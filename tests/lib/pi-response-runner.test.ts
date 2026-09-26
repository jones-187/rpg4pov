import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { PiRunner } from "@/lib/pi-runner";
import { TurnOrchestrator } from "@/lib/turn-orchestrator";
import { createStory, resolveWorkspaceDir } from "@/lib/workspace";
import { useTempWorkspaceRoot, resetWorkspaceRoot } from "../helpers/workspace-env";

const candidate = { kind: "turn", output: "# 主角视窗\n\n我把记录放上桌，守塔人抬起头。", interaction: { mode: "continue", suggestions: [] }, stateUpdate: "=== FILE: world.md ===\nAPPEND: 记录已经送到。" };
const rawEvent = (text: string) => JSON.stringify({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text }] } });
const event = (value: unknown) => rawEvent(JSON.stringify(value));
let saved: Record<string, string | undefined>;
let piConfigRoot: string;
beforeEach(async () => {
  saved = Object.fromEntries(["PI_HOME", "ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "PI_MAX_ATTEMPTS", "PI_RESPONSE_EXTENSION_PATH"].map(k => [k, process.env[k]]));
  piConfigRoot = await fs.mkdtemp("/tmp/pi-response-test-");
  process.env.PI_HOME = piConfigRoot;
  process.env.ANTHROPIC_BASE_URL = "http://gateway.test";
  process.env.ANTHROPIC_AUTH_TOKEN = "test-token";
  process.env.PI_MAX_ATTEMPTS = "1";
  await useTempWorkspaceRoot();
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  await fs.rm(piConfigRoot, { recursive: true, force: true });
  resetWorkspaceRoot();
});

describe("server-owned complete response submission", () => {
  it("refuses to spawn when the JSON request extension is missing", async () => {
    process.env.PI_RESPONSE_EXTENSION_PATH = path.join(piConfigRoot, "missing.ts");
    const story = await createStory();
    let calls = 0;
    const runner = new PiRunner({ spawnFn: async () => {
      calls++;
      return { code: 0, stdout: "", stderr: "" };
    } });
    const result = await new TurnOrchestrator(runner).executeTurn(story.storyId, "继续");
    expect(result.success).toBe(false);
    expect(result.error).toBe("pi JSON response extension unavailable");
    expect(calls).toBe(0);
  });
  it("commits a complete assistant response without model file writes", async () => {
    const story = await createStory();
    const dir = resolveWorkspaceDir(story.storyId);
    let argsUsed: string[] = [];
    const runner = new PiRunner({ spawnFn: async (_cmd, args, opts) => {
      argsUsed = args;
      opts.onStdoutLine?.(event(candidate));
      return { code: 0, stdout: "", stderr: "" };
    } });
    const outcome = await new TurnOrchestrator(runner).executeTurn(story.storyId, "送回记录");
    expect(outcome.success, outcome.error).toBe(true);
    expect(argsUsed).toContain("--no-tools");
    expect(argsUsed).toContain("--no-context-files");
    expect(await fs.readFile(path.join(dir, "world.md"), "utf8")).toContain("记录已经送到");
    expect(outcome.playerResponse).toBe(candidate.output);
  });

  it("commits explicit multiline state operations in the complete response", async () => {
    const story = await createStory();
    const dir = resolveWorkspaceDir(story.storyId);
    await fs.writeFile(path.join(dir, "world.md"), "# 世界\n第一行旧状态\n第二行旧状态\n");
    const value = { ...candidate, stateUpdate: { sections: [{ file: "world.md", ops: [{ kind: "replace", from: "第一行旧状态\n第二行旧状态", to: "记录已经送到\n灯塔清晨" }] }], rolls: [] } };
    const runner = new PiRunner({ spawnFn: async (_cmd, _args, opts) => {
      opts.onStdoutLine?.(event(value));
      return { code: 0, stdout: "", stderr: "" };
    } });
    const outcome = await new TurnOrchestrator(runner).executeTurn(story.storyId, "送回记录");
    expect(outcome.success, outcome.error).toBe(true);
    expect(await fs.readFile(path.join(dir, "world.md"), "utf8")).toBe("# 世界\n记录已经送到\n灯塔清晨\n");
  });

  it.each([
    ["非法顶层字段", JSON.stringify({ ...candidate, explanation: "多余说明" }), "turn response keys are invalid"],
    ["非法 JSON", `${JSON.stringify(candidate)} trailing`, "response is not valid JSON"],
  ])("returns the rejected %s response and parse error for one bounded repair", async (_label, rejected, expectedError) => {
    process.env.PI_MAX_ATTEMPTS = "2";
    const story = await createStory();
    const prompts: string[] = [];
    let calls = 0;
    const runner = new PiRunner({
      spawnFn: async (_cmd, args, opts) => {
        calls++;
        prompts.push(args.at(-1) ?? "");
        opts.onStdoutLine?.(calls === 1 ? rawEvent(rejected) : event(candidate));
        return { code: 0, stdout: "", stderr: "" };
      },
    });

    const outcome = await new TurnOrchestrator(runner).executeTurn(story.storyId, "继续记录");

    expect(outcome.success, outcome.error).toBe(true);
    expect(calls).toBe(2);
    expect(prompts[0]).not.toContain("<previous_invalid_response>");
    expect(prompts[1]).toContain(expectedError);
    expect(prompts[1]).toContain(rejected);
    expect(prompts[1]).toContain("只修正 JSON/字段结构");
    expect(prompts[1]).toContain("正文、事实、角色归属、玩家决定、状态含义和随机结果必须保持不变");
  });

  it("retries a complete response when one state replace misses without committing sibling appends", async () => {
    process.env.PI_MAX_ATTEMPTS = "2";
    const story = await createStory();
    const dir = resolveWorkspaceDir(story.storyId);
    await fs.writeFile(path.join(dir, "actors", "lin.md"), "旧状态\n");

    const firstResponse = {
      ...candidate,
      stateUpdate: {
        sections: [
          { file: "world.md", ops: [{ kind: "append", text: "第一次不应落盘" }] },
          { file: "actors/lin.md", ops: [{ kind: "replace", from: "不存在的旧状态", to: "错误替换" }] },
        ],
        rolls: [],
      },
    };
    const validResponse = {
      ...candidate,
      stateUpdate: {
        sections: [
          { file: "world.md", ops: [{ kind: "append", text: "第二次最终记录" }] },
          { file: "actors/lin.md", ops: [{ kind: "replace", from: "旧状态", to: "新状态" }] },
        ],
        rolls: [],
      },
    };
    const prompts: string[] = [];
    let calls = 0;
    const runner = new PiRunner({
      spawnFn: async (_cmd, args, opts) => {
        calls++;
        prompts.push(args.at(-1) ?? "");
        opts.onStdoutLine?.(event(calls === 1 ? firstResponse : validResponse));
        return { code: 0, stdout: "", stderr: "" };
      },
    });

    const outcome = await new TurnOrchestrator(runner).executeTurn(story.storyId, "继续记录");

    expect(outcome.success, outcome.error).toBe(true);
    expect(calls).toBe(2);
    expect(prompts[1]).toContain("REPLACE miss");
    const world = await fs.readFile(path.join(dir, "world.md"), "utf8");
    expect(world).not.toContain("第一次不应落盘");
    expect(world).toContain("第二次最终记录");
    await expect(fs.readFile(path.join(dir, "actors", "lin.md"), "utf8")).resolves.toBe("新状态\n");
  });

  it("rolls back a partial state write on I/O failure without retrying the model", async () => {
    process.env.PI_MAX_ATTEMPTS = "2";
    const story = await createStory();
    const dir = resolveWorkspaceDir(story.storyId);
    const actorPath = path.join(dir, "actors", "lin.md");
    await fs.writeFile(actorPath, "旧状态\n");
    const worldBefore = await fs.readFile(path.join(dir, "world.md"), "utf8");
    const response = {
      ...candidate,
      stateUpdate: {
        sections: [
          { file: "world.md", ops: [{ kind: "append", text: "部分写入后应回滚" }] },
          { file: "actors/lin.md", ops: [{ kind: "append", text: "触发写入异常" }] },
        ],
        rolls: [],
      },
    };
    let calls = 0;
    let injected = false;
    const realWriteFile = fs.writeFile.bind(fs);
    vi.spyOn(fs, "writeFile").mockImplementation((file, data, options) => {
      if (!injected && path.resolve(String(file)) === path.resolve(actorPath)) {
        injected = true;
        throw new Error("synthetic actor write failure");
      }
      return realWriteFile(file, data, options);
    });
    const runner = new PiRunner({
      spawnFn: async (_cmd, _args, opts) => {
        calls++;
        opts.onStdoutLine?.(event(response));
        return { code: 0, stdout: "", stderr: "" };
      },
    });

    const outcome = await new TurnOrchestrator(runner).executeTurn(story.storyId, "继续记录");

    expect(outcome.success).toBe(false);
    expect(outcome.error).toBe("turn candidate validation or commit failed");
    expect(calls).toBe(1);
    expect(injected).toBe(true);
    await expect(fs.readFile(path.join(dir, "world.md"), "utf8")).resolves.toBe(worldBefore);
    await expect(fs.readFile(actorPath, "utf8")).resolves.toBe("旧状态\n");
  });

  it("retries a failed bound-random response without redrawing or changing its binding context", async () => {
    process.env.PI_MAX_ATTEMPTS = "2";
    const story = await createStory();
    const dir = resolveWorkspaceDir(story.storyId);
    const actorPath = path.join(dir, "actors", "lin.md");
    await fs.writeFile(actorPath, "旧状态\n");
    const candidates = [{ id: "yes", weight: 1 }, { id: "no", weight: 1 }];
    const declaration = { index: 1, rollId: "risk", candidates, declaredSelectedId: "no" };
    const request = { kind: "roll-request", rolls: [{ rollId: "risk", candidates }] };
    const firstResponse = {
      ...candidate,
      stateUpdate: {
        sections: [
          { file: "world.md", ops: [{ kind: "append", text: "随机失败时不应落盘" }] },
          { file: "actors/lin.md", ops: [{ kind: "replace", from: "不存在的旧状态", to: "错误替换" }] },
        ],
        rolls: [declaration],
      },
    };
    const validResponse = {
      ...candidate,
      stateUpdate: {
        sections: [
          { file: "world.md", ops: [{ kind: "append", text: "随机确认后的记录" }] },
          { file: "actors/lin.md", ops: [{ kind: "replace", from: "旧状态", to: "新状态" }] },
        ],
        rolls: [declaration],
      },
    };
    const prompts: string[] = [];
    let calls = 0;
    let draws = 0;
    const runner = new PiRunner({
      rollRng: () => {
        draws++;
        return 0.9;
      },
      spawnFn: async (_cmd, args, opts) => {
        calls++;
        prompts.push(args.at(-1) ?? "");
        opts.onStdoutLine?.(event(calls === 1 ? request : calls === 2 ? firstResponse : validResponse));
        return { code: 0, stdout: "", stderr: "" };
      },
    });

    const outcome = await new TurnOrchestrator(runner).executeTurn(story.storyId, "尝试风险");

    expect(outcome.success, outcome.error).toBe(true);
    expect(calls).toBe(3);
    expect(draws).toBe(1);
    const binding = "R1: rollId=risk candidates=yes:1,no:1 → no";
    expect(prompts[1]).toContain(binding);
    expect(prompts[2]).toContain(binding);
    expect(prompts[2]).toContain("REPLACE miss");
    await expect(fs.readFile(path.join(dir, "world.md"), "utf8")).resolves.not.toContain("随机失败时不应落盘");
    await expect(fs.readFile(path.join(dir, "world.md"), "utf8")).resolves.toContain("随机确认后的记录");
    await expect(fs.readFile(actorPath, "utf8")).resolves.toBe("新状态\n");
  });

  it("rejects a canonical random declaration leaked from a structured state response", async () => {
    const story = await createStory();
    const declaration = { index: 1, rollId: "risk", candidates: [{ id: "yes", weight: 1 }, { id: "no", weight: 1 }], declaredSelectedId: "no" };
    let calls = 0;
    const runner = new PiRunner({ rollRng: () => 0.9, spawnFn: async (_cmd, _args, opts) => {
      calls++;
      opts.onStdoutLine?.(event(calls === 1
        ? { kind: "roll-request", rolls: [{ rollId: declaration.rollId, candidates: declaration.candidates }] }
        : { ...candidate, output: "# 主角视窗\nR1: rollId=risk candidates=yes:1,no:1 → no", stateUpdate: { sections: [], rolls: [declaration] } }));
      return { code: 0, stdout: "", stderr: "" };
    } });
    const outcome = await new TurnOrchestrator(runner).executeTurn(story.storyId, "尝试风险");
    expect(outcome.success).toBe(false);
    expect(outcome.error).toBe("turn candidate validation or commit failed");
  });

  it("does not treat prose alone or old disk artifacts as a valid response", async () => {
    const story = await createStory();
    const dir = resolveWorkspaceDir(story.storyId);
    const before = await fs.readFile(path.join(dir, "world.md"), "utf8");
    await fs.writeFile(path.join(dir, "turn/state-update.md"), candidate.stateUpdate);
    const runner = new PiRunner({ spawnFn: async () => ({ code: 0, stdout: candidate.output, stderr: "" }) });
    const outcome = await new TurnOrchestrator(runner).executeTurn(story.storyId, "送回记录");
    expect(outcome.success).toBe(false);
    expect(await fs.readFile(path.join(dir, "world.md"), "utf8")).toBe(before);
  });

  it("rejects model filesystem writes even when the final response is valid", async () => {
    const story = await createStory();
    const dir = resolveWorkspaceDir(story.storyId);
    const before = await fs.readFile(path.join(dir, "world.md"), "utf8");
    const runner = new PiRunner({ spawnFn: async (_cmd, _args, opts) => {
      await fs.writeFile(path.join(dir, "world.md"), "非法改写");
      opts.onStdoutLine?.(event(candidate));
      return { code: 0, stdout: "", stderr: "" };
    } });
    const outcome = await new TurnOrchestrator(runner).executeTurn(story.storyId, "送回记录");
    expect(outcome.success).toBe(false);
    expect(outcome.error).toContain("write boundary");
    expect(await fs.readFile(path.join(dir, "world.md"), "utf8")).toBe(before);
  });

  it("rejects a random declaration in output even when its state declaration is indented", async () => {
    const story = await createStory();
    const dir = resolveWorkspaceDir(story.storyId);
    const request = {
      kind: "roll-request",
      rolls: [{ rollId: "risk", candidates: [{ id: "yes", weight: 1 }, { id: "no", weight: 1 }] }],
    };
    const declaration = "R1: rollId=risk candidates=yes:1,no:1 → no";
    const randomTurn = {
      ...candidate,
      output: `${candidate.output}\n\n${declaration}`,
      stateUpdate: `=== NO CHANGES ===\n=== RANDOM ===\n  ${declaration}`,
    };
    let calls = 0;
    const runner = new PiRunner({
      rollRng: () => 0.9,
      spawnFn: async (_cmd, _args, opts) => {
        calls++;
        opts.onStdoutLine?.(event(calls === 1 ? request : randomTurn));
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    const outcome = await new TurnOrchestrator(runner).executeTurn(story.storyId, "送回记录");
    expect(outcome.success).toBe(false);
    expect(calls).toBe(2);
    await expect(fs.access(path.join(dir, "turn/done.json"))).rejects.toThrow();
  });

  it("fails immediately when a bound random request cannot be persisted", async () => {
    process.env.PI_MAX_ATTEMPTS = "2";
    const story = await createStory();
    const dir = resolveWorkspaceDir(story.storyId);
    await fs.mkdir(path.join(dir, "turn", "roll-request.json"));
    const request = {
      kind: "roll-request",
      rolls: [{ rollId: "risk", candidates: [{ id: "yes", weight: 1 }, { id: "no", weight: 1 }] }],
    };
    const randomTurn = {
      ...candidate,
      stateUpdate: "=== NO CHANGES ===\n=== RANDOM ===\nR1: rollId=risk candidates=yes:1,no:1 → no",
    };
    let calls = 0;
    const runner = new PiRunner({
      rollRng: () => 0.9,
      spawnFn: async (_cmd, _args, opts) => {
        calls++;
        opts.onStdoutLine?.(event(calls === 1 ? request : randomTurn));
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    const outcome = await runner.runTurn({
      storyId: story.storyId,
      workspaceDir: dir,
      playerInput: "送回记录",
      signal: AbortSignal.timeout(10_000),
    });
    expect(outcome.success).toBe(false);
    expect(outcome.error).toBe("random request persistence failed");
    expect(calls).toBe(1);
    await expect(fs.access(path.join(dir, "turn/done.json"))).rejects.toThrow();
    await expect(fs.access(path.join(dir, "logs/random-rolls.jsonl"))).rejects.toThrow();
  });
});
