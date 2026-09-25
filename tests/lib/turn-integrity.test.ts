import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { PiRunner } from "@/lib/pi-runner";
import { TurnOrchestrator } from "@/lib/turn-orchestrator";
import type { SpawnFn } from "@/lib/agent-spawn";
import { createStory, resolveWorkspaceDir } from "@/lib/workspace";
import { useTempWorkspaceRoot, resetWorkspaceRoot } from "../helpers/workspace-env";

const OUTPUT = "# 主角视窗\n\n门后的灯亮了。\n";
const INTERACTION = { mode: "continue", suggestions: [] } as const;
const PUBLIC_SCENE = {
  time: "第一天清晨",
  location: "灯塔门口",
  narrativeVoice: "第一人称限知",
  knownFacts: ["灯快熄了"],
  visibleActors: [{ name: "守塔人", appearance: "旧雨衣", voice: "短句" }],
};

function messageEnd(value: unknown): string {
  return JSON.stringify({
    type: "message_end",
    message: {
      role: "assistant",
      stopReason: "stop",
      content: [{ type: "text", text: JSON.stringify(value) }],
    },
  });
}

function turnResponse(overrides: Record<string, unknown> = {}) {
  return {
    kind: "turn",
    output: OUTPUT,
    interaction: INTERACTION,
    stateUpdate: { sections: [], rolls: [] },
    ...overrides,
  };
}

let savedEnv: Record<string, string | undefined>;
let piHome: string;

beforeEach(async () => {
  savedEnv = {};
  for (const key of [
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_AUTH_TOKEN",
    "PI_HOME",
    "PI_MAX_ATTEMPTS",
    "PI_UNCOMMITTED_PREVIEW",
  ]) savedEnv[key] = process.env[key];
  piHome = await fs.mkdtemp(path.join("/tmp", "pi-integrity-home-"));
  process.env.ANTHROPIC_BASE_URL = "http://gateway.test:3030";
  process.env.ANTHROPIC_AUTH_TOKEN = "test-token";
  process.env.PI_HOME = piHome;
  await useTempWorkspaceRoot();
});

afterEach(async () => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await fs.rm(piHome, { recursive: true, force: true });
  resetWorkspaceRoot();
});

describe("turn response integrity", () => {
  it("does not commit or preview prose, partial JSON, or a missing terminal response", async () => {
    process.env.PI_MAX_ATTEMPTS = "2";
    process.env.PI_UNCOMMITTED_PREVIEW = "1";
    const meta = await createStory({ title: "incomplete response" });
    const workspaceDir = resolveWorkspaceDir(meta.storyId);
    const worldBefore = await fs.readFile(path.join(workspaceDir, "world.md"), "utf8");
    let calls = 0;
    const spawn: SpawnFn = async (_cmd, _args, opts) => {
      calls++;
      opts.onStdoutLine?.(calls === 1
        ? "# 主角视窗\n裸小说，不是事件"
        : '{"kind":"turn","output":"# 主角视窗"');
      return { code: 0, stdout: "", stderr: "" };
    };

    const result = await new PiRunner({ spawnFn: spawn }).runTurn({
      storyId: meta.storyId,
      workspaceDir,
      playerInput: "走进房间",
      signal: AbortSignal.timeout(5_000),
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("no turn response");
    expect(calls).toBe(2);
    expect(await fs.readFile(path.join(workspaceDir, "world.md"), "utf8")).toBe(worldBefore);
    await expect(fs.access(path.join(workspaceDir, "turn/done.json"))).rejects.toThrow();
  });

  it("rejects a pre-existing workspace symlink before a no-tools turn can start", async () => {
    process.env.PI_MAX_ATTEMPTS = "1";
    const meta = await createStory({ title: "pre-existing symlink" });
    const workspaceDir = resolveWorkspaceDir(meta.storyId);
    const outside = await fs.mkdtemp(path.join("/tmp", "pi-integrity-outside-"));
    const sentinel = path.join(outside, "sentinel.md");
    const stateUpdate = path.join(workspaceDir, "turn", "state-update.md");
    const sentinelBefore = "外部文件不得被改写\n";
    await fs.writeFile(sentinel, sentinelBefore);
    await fs.symlink(sentinel, stateUpdate);

    let spawnCalls = 0;
    try {
      const result = await new PiRunner({
        spawnFn: async () => {
          spawnCalls++;
          return { code: 0, stdout: "", stderr: "" };
        },
      }).runTurn({
        storyId: meta.storyId,
        workspaceDir,
        playerInput: "走进房间",
        signal: AbortSignal.timeout(5_000),
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe("pi turn workspace write boundary violated");
      expect(spawnCalls).toBe(0);
      expect(await fs.readFile(sentinel, "utf8")).toBe(sentinelBefore);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it("binds a legal roll request from a non-zero attempt and reuses it without redrawing", async () => {
    process.env.PI_MAX_ATTEMPTS = "1";
    const meta = await createStory({ title: "non-zero roll request" });
    const workspaceDir = resolveWorkspaceDir(meta.storyId);
    const request = {
      kind: "roll-request",
      rolls: [{ rollId: "risk", candidates: [{ id: "yes", weight: 1 }, { id: "no", weight: 1 }] }],
    };
    const boundState = {
      sections: [],
      rolls: [{
        index: 1,
        rollId: "risk",
        candidates: [{ id: "yes", weight: 1 }, { id: "no", weight: 1 }],
        declaredSelectedId: "no",
      }],
    };
    let spawnCalls = 0;
    let draws = 0;
    const prompts: string[] = [];
    const spawn: SpawnFn = async (_cmd, args, opts) => {
      spawnCalls++;
      prompts.push(args.at(-1) ?? "");
      if (spawnCalls === 1) {
        opts.onStdoutLine?.(messageEnd(request));
        return { code: 1, stdout: "request complete", stderr: "model stopped after request" };
      }
      opts.onStdoutLine?.(messageEnd(turnResponse({ stateUpdate: boundState })));
      return { code: 0, stdout: "turn complete", stderr: "" };
    };

    const result = await new PiRunner({ spawnFn: spawn, rollRng: () => { draws++; return 0.9; } }).runTurn({
      storyId: meta.storyId,
      workspaceDir,
      playerInput: "试探风险",
      signal: AbortSignal.timeout(5_000),
    });

    expect(result.success, result.detail).toBe(true);
    expect(spawnCalls).toBe(2);
    expect(draws).toBe(1);
    expect(prompts[1]).toContain("R1: rollId=risk candidates=yes:1,no:1 → no");
    await expect(fs.readFile(path.join(workspaceDir, "turn/done.json"), "utf8")).resolves.toContain("success");
  });

  it("does not accept a complete turn response when the process exits non-zero", async () => {
    process.env.PI_MAX_ATTEMPTS = "1";
    const meta = await createStory({ title: "non-zero final response" });
    const workspaceDir = resolveWorkspaceDir(meta.storyId);
    const spawn: SpawnFn = async (_cmd, _args, opts) => {
      opts.onStdoutLine?.(messageEnd(turnResponse()));
      return { code: 1, stdout: "", stderr: "model failed" };
    };

    const result = await new TurnOrchestrator(new PiRunner({ spawnFn: spawn })).executeTurn(
      meta.storyId,
      "继续",
    );

    expect(result.success).toBe(false);
    await expect(fs.access(path.join(workspaceDir, "turn/done.json"))).rejects.toThrow();
  });

  it("rejects a complete response with missing or illegal stateUpdate and commits nothing", async () => {
    process.env.PI_MAX_ATTEMPTS = "1";
    const meta = await createStory({ title: "invalid state response" });
    const workspaceDir = resolveWorkspaceDir(meta.storyId);
    const worldBefore = await fs.readFile(path.join(workspaceDir, "world.md"), "utf8");
    let response: Record<string, unknown> = turnResponse({ stateUpdate: "不是合法状态候选" });
    const spawn: SpawnFn = async (_cmd, _args, opts) => {
      opts.onStdoutLine?.(messageEnd(response));
      return { code: 0, stdout: "", stderr: "" };
    };

    const first = await new PiRunner({ spawnFn: spawn }).runTurn({
      storyId: meta.storyId,
      workspaceDir,
      playerInput: "继续",
      signal: AbortSignal.timeout(5_000),
    });
    expect(first.success).toBe(false);
    expect(await fs.readFile(path.join(workspaceDir, "world.md"), "utf8")).toBe(worldBefore);
    await expect(fs.access(path.join(workspaceDir, "turn/done.json"))).rejects.toThrow();

    response = turnResponse({ stateUpdate: undefined });
    const second = await new PiRunner({ spawnFn: spawn }).runTurn({
      storyId: meta.storyId,
      workspaceDir,
      playerInput: "继续",
      signal: AbortSignal.timeout(5_000),
    });
    expect(second.success).toBe(false);
    await expect(fs.access(path.join(workspaceDir, "turn/done.json"))).rejects.toThrow();
  });

  it("rejects an unexpected model filesystem write even with a valid response", async () => {
    process.env.PI_MAX_ATTEMPTS = "1";
    const meta = await createStory({ title: "unexpected write" });
    const workspaceDir = resolveWorkspaceDir(meta.storyId);
    const worldBefore = await fs.readFile(path.join(workspaceDir, "world.md"), "utf8");
    const spawn: SpawnFn = async (_cmd, _args, opts) => {
      await fs.writeFile(path.join(workspaceDir, "world.md"), "模型越权改写\n");
      opts.onStdoutLine?.(messageEnd(turnResponse()));
      return { code: 0, stdout: "", stderr: "" };
    };

    const result = await new TurnOrchestrator(new PiRunner({ spawnFn: spawn })).executeTurn(
      meta.storyId,
      "继续",
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("write boundary");
    expect(await fs.readFile(path.join(workspaceDir, "world.md"), "utf8")).toBe(worldBefore);
  });

  it("experimental scene planner and renderer both use no-tools response events", async () => {
    process.env.PI_MAX_ATTEMPTS = "1";
    const meta = await createStory({ title: "separated scene" });
    const workspaceDir = resolveWorkspaceDir(meta.storyId);
    await fs.writeFile(path.join(workspaceDir, "player.md"), `# 主角\n\n## Public Scene\n${JSON.stringify(PUBLIC_SCENE)}\n`);
    await fs.writeFile(path.join(workspaceDir, "world.md"), "# 世界\n秘密：她烧了船票\n");
    const plan = {
      kind: "scene",
      visibleEvents: ["她把手从灶边收回。"],
      publicScene: PUBLIC_SCENE,
      stateUpdate: {
        sections: [{ file: "world.md", ops: [{ kind: "append", text: "私下销毁证据" }] }],
        rolls: [],
      },
      interaction: { mode: "decision", suggestions: ["问她怎么了"] },
    };
    const render = { kind: "render", output: "# 主角视窗\n她把手从灶边收回。我停在门口。" };
    const prompts: string[] = [];
    let calls = 0;
    const spawn: SpawnFn = async (_cmd, args, opts) => {
      calls++;
      prompts.push(args.at(-1) ?? "");
      opts.onStdoutLine?.(messageEnd(calls === 1 ? plan : render));
      return { code: 0, stdout: "", stderr: "" };
    };

    const result = await new PiRunner({ spawnFn: spawn, experimentalSceneSeparation: true }).runTurn({
      storyId: meta.storyId,
      workspaceDir,
      playerInput: "我想她可能烧了船票",
      signal: AbortSignal.timeout(5_000),
    });

    expect(result.success, result.detail).toBe(true);
    expect(calls).toBe(2);
    expect(prompts[1]).not.toContain("烧了船票");
    expect(prompts[1]).not.toContain("销毁证据");
    expect(await fs.readFile(path.join(workspaceDir, "world.md"), "utf8")).toContain("销毁证据");
  });
});
