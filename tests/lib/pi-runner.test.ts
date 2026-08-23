import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { PiRunner } from "@/lib/pi-runner";
import { TurnOrchestrator } from "@/lib/turn-orchestrator";
import type { SpawnFn, SpawnOpts } from "@/lib/agent-spawn";
import { createStory, resolveWorkspaceDir } from "@/lib/workspace";
import { appendTurnHistory } from "@/lib/turn-history";
import { readTurnProgress, clearTurnProgress } from "@/lib/turn-progress";
import { useTempWorkspaceRoot, resetWorkspaceRoot } from "../helpers/workspace-env";

/**
 * mock spawn：模拟 pi 的行为——files 非空则把文件写入 opts.cwd 后成功退出；
 * files 为 null 则什么都不写（模拟"口述不写盘"失效模式）。
 */
type CallRecord = { cmd: string; args: string[]; opts: SpawnOpts };
function makeSpawn(script: (null | Record<string, string>)[]): { spawn: SpawnFn; calls: CallRecord[] } {
  let i = 0;
  const calls: CallRecord[] = [];
  const spawn: SpawnFn = async (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    const files = script[Math.min(i, script.length - 1)];
    i++;
    if (files) {
      for (const [file, content] of Object.entries(files)) {
        const target = path.join(opts.cwd, file);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, content);
      }
    }
    return { code: 0, stdout: files ? "回合完成" : "（口述内容，未写盘）", stderr: "" };
  };
  return { spawn, calls };
}

const OUTPUT_MD = "# 主角视窗\n\n你推门进来，热气扑面。\n";
const INTERACTION_JSON = JSON.stringify({ mode: "decision", suggestions: ["应和一句"] });
const STATE_UPDATE_MD = [
  "=== FILE: world.md ===",
  "APPEND: ## 时间线",
  "REPLACE: （占位：场景、地点、时间与隐藏事实。后续初始化 agent 填充。）→ 雪夜客栈",
].join("\n");

const INIT_BUNDLE = [
  "=== FILE: world.md ===",
  "# 世界设定\n\n雨夜的废弃灯塔，雾潮会在黎明前上涨。",
  "=== FILE: player.md ===",
  "# 主角\n\n## 用户设定（canon）\n雾中的守塔学徒。\n\n## Protagonist Core\nnarrativeVoice: 第一人称限知。\n\n## Player Agency\n重大决定交还玩家。",
  "=== FILE: rules.md ===",
  "# 规则\n\n风险由随机工具判定，故事不预写固定路线。",
  "=== FILE: actors/keeper.md ===",
  "# 守塔人\n\n## Emotional Core\ncoreNeed: 有人留下。\ncoreFear: 灯火熄灭。\n\n## Relationship State: 主角\nsurfaceRelationship: 新来的学徒。\n\n## Emotionally Salient Memories\nevent: 上一任守塔人失踪。\nmeaning: 灯不能无人照看。\nimpact: 他不再轻信离开的人。\n\n## Current Intent\ncurrentEmotion: 警觉。\nimmediateGoal: 试探学徒。\nhiddenIntent: 确认学徒是否可靠。\nrestraint: 不愿暴露秘密。\nvoice: 短句。",
].join("\n");

const ENV_KEYS = [
  "PI_HOME",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_MODEL",
  "PI_EARLY_EXIT",
  "PI_WRITE_BOUNDARY_EXTENSION_PATH",
] as const;
let savedEnv: Record<string, string | undefined>;
let piHome: string;

beforeEach(async () => {
  savedEnv = {};
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  piHome = await fs.mkdtemp(path.join(os.tmpdir(), "pi-home-"));
  process.env.PI_HOME = piHome;
  process.env.ANTHROPIC_BASE_URL = "http://gateway.test:3030";
  process.env.ANTHROPIC_AUTH_TOKEN = "test-token";
  delete process.env.ANTHROPIC_MODEL;
  await useTempWorkspaceRoot();
});

afterEach(async () => {
  for (const k of ENV_KEYS) {
    const v = savedEnv[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetWorkspaceRoot();
});

function turnRequest(storyId: string, workspaceDir: string) {
  return { storyId, workspaceDir, playerInput: "我下楼吃面", signal: AbortSignal.timeout(10_000) };
}

describe("PiRunner", () => {
  it("task=init runs isolated concept and opening phases in order", async () => {
    const meta = await createStory();
    const dir = resolveWorkspaceDir(meta.storyId);
    const calls: CallRecord[] = [];
    const spawn: SpawnFn = async (cmd, args, opts) => {
      calls.push({ cmd, args, opts });
      const phasePrompt = args[args.indexOf("--system-prompt") + 1] ?? "";
      if (calls.length === 1) {
        expect(phasePrompt).toContain("Phase 1");
        await fs.writeFile(path.join(opts.cwd, "turn/state-update.md"), INIT_BUNDLE);
        return { code: 0, stdout: "概念完成", stderr: "" };
      }
      expect(phasePrompt).toContain("Phase 2");
      await fs.writeFile(path.join(opts.cwd, "turn/output.md"), OUTPUT_MD);
      await fs.writeFile(path.join(opts.cwd, "turn/interaction.json"), INTERACTION_JSON);
      return { code: 0, stdout: "开场完成", stderr: "" };
    };

    const result = await new PiRunner({ spawnFn: spawn }).runTurn({
      ...turnRequest(meta.storyId, dir),
      playerInput: "雾中的废弃灯塔，主角是守塔学徒",
      task: "init",
    });

    expect(result.success).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[0].opts.env.PI_WRITE_ALLOWED_PATHS).toBe("turn/state-update.md");
    expect(calls[1].opts.env.PI_WRITE_ALLOWED_PATHS).toBe("turn/output.md,turn/interaction.json");
    expect(calls[0].args[calls[0].args.length - 1]).toContain("雾中的废弃灯塔");
    const openingPrompt = calls[1].args[calls[1].args.length - 1];
    expect(openingPrompt).toContain("Protagonist Core");
    expect(openingPrompt).not.toContain("雾中的废弃灯塔");
    await expect(fs.readFile(path.join(dir, "world.md"), "utf8")).resolves.toContain("废弃灯塔");
    await expect(fs.readFile(path.join(dir, "turn/done.json"), "utf8")).resolves.toContain("success");
  });

  it("Phase 1 rejects output writes and does not retry", async () => {
    const meta = await createStory();
    const dir = resolveWorkspaceDir(meta.storyId);
    let calls = 0;
    const spawn: SpawnFn = async (_cmd, _args, opts) => {
      calls++;
      await fs.writeFile(path.join(opts.cwd, "turn/state-update.md"), INIT_BUNDLE);
      await fs.writeFile(path.join(opts.cwd, "turn/output.md"), OUTPUT_MD);
      return { code: 0, stdout: "越权", stderr: "" };
    };
    const result = await new PiRunner({ spawnFn: spawn }).runTurn({
      ...turnRequest(meta.storyId, dir),
      playerInput: "设定",
      task: "init",
    });
    expect(result.success).toBe(false);
    expect(result.error).toBe("pi init workspace write boundary violated");
    expect(calls).toBe(1);
    await expect(fs.readFile(path.join(dir, "world.md"), "utf8")).resolves.toContain("占位");
  });

  it("Phase 2 rejects state-update writes and does not retry Phase 1", async () => {
    const meta = await createStory();
    const dir = resolveWorkspaceDir(meta.storyId);
    let calls = 0;
    const spawn: SpawnFn = async (_cmd, _args, opts) => {
      calls++;
      if (calls === 1) {
        await fs.writeFile(path.join(opts.cwd, "turn/state-update.md"), INIT_BUNDLE);
      } else {
        await fs.writeFile(path.join(opts.cwd, "turn/output.md"), OUTPUT_MD);
        await fs.writeFile(path.join(opts.cwd, "turn/interaction.json"), INTERACTION_JSON);
        await fs.writeFile(path.join(opts.cwd, "turn/state-update.md"), INIT_BUNDLE);
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    const result = await new PiRunner({ spawnFn: spawn }).runTurn({
      ...turnRequest(meta.storyId, dir),
      playerInput: "设定",
      task: "init",
    });
    expect(result.success).toBe(false);
    expect(result.error).toBe("pi init workspace write boundary violated");
    expect(calls).toBe(2);
    await expect(fs.access(path.join(dir, "turn/done.json"))).rejects.toThrow();
  });

  it("orchestrator rolls back Phase 1 concepts when Phase 2 opening fails", async () => {
    const meta = await createStory();
    const dir = resolveWorkspaceDir(meta.storyId);
    let calls = 0;
    const spawn: SpawnFn = async (_cmd, _args, opts) => {
      calls++;
      if (calls === 1) {
        await fs.writeFile(path.join(opts.cwd, "turn/state-update.md"), INIT_BUNDLE);
      } else {
        await fs.writeFile(path.join(opts.cwd, "turn/output.md"), OUTPUT_MD);
        await fs.writeFile(path.join(opts.cwd, "turn/interaction.json"), "{}");
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    const previousAttempts = process.env.PI_MAX_ATTEMPTS;
    process.env.PI_MAX_ATTEMPTS = "1";
    try {
      const outcome = await new TurnOrchestrator(new PiRunner({ spawnFn: spawn })).executeTurn(
        meta.storyId,
        "设定",
        { task: "init" },
      );
      expect(outcome.success).toBe(false);
      expect(calls).toBe(2);
      await expect(fs.readFile(path.join(dir, "world.md"), "utf8")).resolves.toContain("占位");
      await expect(fs.access(path.join(dir, "actors", "keeper.md"))).rejects.toThrow();
      await expect(fs.access(path.join(dir, "turn", "done.json"))).rejects.toThrow();
    } finally {
      if (previousAttempts === undefined) delete process.env.PI_MAX_ATTEMPTS;
      else process.env.PI_MAX_ATTEMPTS = previousAttempts;
    }
  });

  it("Phase 2 rejects an interaction without a valid mode, retries, and never writes done", async () => {
    const meta = await createStory();
    const dir = resolveWorkspaceDir(meta.storyId);
    let calls = 0;
    const spawn: SpawnFn = async (_cmd, _args, opts) => {
      calls++;
      if (calls === 1) {
        await fs.writeFile(path.join(opts.cwd, "turn/state-update.md"), INIT_BUNDLE);
      } else {
        await fs.writeFile(path.join(opts.cwd, "turn/output.md"), OUTPUT_MD);
        await fs.writeFile(path.join(opts.cwd, "turn/interaction.json"), "{}");
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    const previousAttempts = process.env.PI_MAX_ATTEMPTS;
    process.env.PI_MAX_ATTEMPTS = "2";
    try {
      const result = await new PiRunner({ spawnFn: spawn }).runTurn({
        ...turnRequest(meta.storyId, dir),
        playerInput: "设定",
        task: "init",
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain("no init opening");
      expect(calls).toBe(3);
      await expect(fs.access(path.join(dir, "turn/done.json"))).rejects.toThrow();
    } finally {
      if (previousAttempts === undefined) delete process.env.PI_MAX_ATTEMPTS;
      else process.env.PI_MAX_ATTEMPTS = previousAttempts;
    }
  });

  it.each([
    ["JSON 正文", `# 主角视窗\n\n{"internal":"state"}\n`],
    ["超长正文", `# 主角视窗\n\n${"x".repeat(50_001)}\n`],
    ["interaction 原文泄漏", "# 主角视窗\n\n{\"mode\":\"decision\",\"suggestions\":[\"打开门\"]}\n"],
  ] as const)("Phase 2 rejects %s before writing done", async (_label, output) => {
    const meta = await createStory();
    const dir = resolveWorkspaceDir(meta.storyId);
    let calls = 0;
    const interaction = JSON.stringify({ mode: "decision", suggestions: ["打开门"] });
    const spawn: SpawnFn = async (_cmd, _args, opts) => {
      calls++;
      if (calls === 1) {
        await fs.writeFile(path.join(opts.cwd, "turn/state-update.md"), INIT_BUNDLE);
      } else {
        await fs.writeFile(path.join(opts.cwd, "turn/output.md"), output);
        await fs.writeFile(path.join(opts.cwd, "turn/interaction.json"), interaction);
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    const previousAttempts = process.env.PI_MAX_ATTEMPTS;
    process.env.PI_MAX_ATTEMPTS = "1";
    try {
      const result = await new PiRunner({ spawnFn: spawn }).runTurn({
        ...turnRequest(meta.storyId, dir),
        playerInput: "设定",
        task: "init",
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain("no init opening");
      expect(calls).toBe(2);
      await expect(fs.access(path.join(dir, "turn/done.json"))).rejects.toThrow();
    } finally {
      if (previousAttempts === undefined) delete process.env.PI_MAX_ATTEMPTS;
      else process.env.PI_MAX_ATTEMPTS = previousAttempts;
    }
  });

  it("Phase 2 early-exit gate also rejects an invalid interaction", async () => {
    const meta = await createStory();
    const dir = resolveWorkspaceDir(meta.storyId);
    let calls = 0;
    const spawn: SpawnFn = async (_cmd, _args, opts) => {
      calls++;
      if (calls === 1) {
        await fs.writeFile(path.join(opts.cwd, "turn/state-update.md"), INIT_BUNDLE);
      } else {
        await fs.writeFile(path.join(opts.cwd, "turn/output.md"), OUTPUT_MD);
        await fs.writeFile(path.join(opts.cwd, "turn/interaction.json"), "{}");
        await new Promise((resolve) => setTimeout(resolve, 260));
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    const previousAttempts = process.env.PI_MAX_ATTEMPTS;
    process.env.PI_MAX_ATTEMPTS = "1";
    try {
      const result = await new PiRunner({ spawnFn: spawn }).runTurn({
        ...turnRequest(meta.storyId, dir),
        playerInput: "设定",
        task: "init",
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain("no init opening");
      expect(calls).toBe(2);
      await expect(fs.access(path.join(dir, "turn/done.json"))).rejects.toThrow();
    } finally {
      if (previousAttempts === undefined) delete process.env.PI_MAX_ATTEMPTS;
      else process.env.PI_MAX_ATTEMPTS = previousAttempts;
    }
  });

  it("task=init uses the init plan, applies a complete bundle, and writes done server-side", async () => {
    const meta = await createStory();
    const dir = resolveWorkspaceDir(meta.storyId);
    const { spawn, calls } = makeSpawn([
      {
        "turn/state-update.md": INIT_BUNDLE,
      },
      { "turn/output.md": OUTPUT_MD, "turn/interaction.json": INTERACTION_JSON },
    ]);
    const runner = new PiRunner({ spawnFn: spawn });

    const result = await runner.runTurn({
      ...turnRequest(meta.storyId, dir),
      playerInput: "雾中的废弃灯塔，主角是守塔学徒",
      task: "init",
    });

    expect(result.success).toBe(true);
    const prompt = calls[0].args[calls[0].args.length - 1];
    expect(prompt).toContain("Phase 1");
    expect(prompt).toContain("雾中的废弃灯塔");
    expect(prompt).toContain("=== world.md ===");
    expect(prompt).not.toContain("随机数池");
    expect(calls[1].args[calls[1].args.length - 1]).toContain("Phase 2");
    await expect(fs.readFile(path.join(dir, "world.md"), "utf8")).resolves.toContain("废弃灯塔");
    await expect(fs.readFile(path.join(dir, "actors/keeper.md"), "utf8")).resolves.toContain("Emotional Core");
    await expect(fs.readFile(path.join(dir, "turn/done.json"), "utf8")).resolves.toContain("success");
  });

  it("passes the fail-closed write extension to every Pi startup", async () => {
    const meta = await createStory();
    const dir = resolveWorkspaceDir(meta.storyId);
    const { spawn, calls } = makeSpawn([
      { "turn/output.md": OUTPUT_MD, "turn/interaction.json": INTERACTION_JSON },
    ]);
    const runner = new PiRunner({ spawnFn: spawn });

    const result = await runner.runTurn(turnRequest(meta.storyId, dir));

    expect(result.success).toBe(true);
    const noExtensions = calls[0].args.indexOf("--no-extensions");
    const extension = calls[0].args.indexOf("--extension");
    expect(noExtensions).toBeGreaterThan(-1);
    expect(extension).toBeGreaterThan(-1);
    expect(calls[0].args[extension + 1]).toBe(
      path.resolve(process.cwd(), "pi-extensions/write-boundary.ts"),
    );
  });

  it("uses an explicit readable PI_WRITE_BOUNDARY_EXTENSION_PATH override", async () => {
    const meta = await createStory();
    const dir = resolveWorkspaceDir(meta.storyId);
    const extensionPath = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "pi-extension-")), "boundary.ts");
    await fs.writeFile(extensionPath, "export default () => {};\n");
    const previous = process.env.PI_WRITE_BOUNDARY_EXTENSION_PATH;
    process.env.PI_WRITE_BOUNDARY_EXTENSION_PATH = extensionPath;
    try {
      const { spawn, calls } = makeSpawn([
        { "turn/output.md": OUTPUT_MD, "turn/interaction.json": INTERACTION_JSON },
      ]);
      const result = await new PiRunner({ spawnFn: spawn }).runTurn(turnRequest(meta.storyId, dir));

      expect(result.success).toBe(true);
      const extension = calls[0].args.indexOf("--extension");
      expect(calls[0].args[extension + 1]).toBe(extensionPath);
    } finally {
      if (previous === undefined) delete process.env.PI_WRITE_BOUNDARY_EXTENSION_PATH;
      else process.env.PI_WRITE_BOUNDARY_EXTENSION_PATH = previous;
    }
  });

  it("fails closed before spawn when the write extension is missing", async () => {
    const meta = await createStory();
    const dir = resolveWorkspaceDir(meta.storyId);
    const previous = process.env.PI_WRITE_BOUNDARY_EXTENSION_PATH;
    process.env.PI_WRITE_BOUNDARY_EXTENSION_PATH = path.join(dir, "missing-extension.ts");
    let spawnCalls = 0;
    try {
      const runner = new PiRunner({
        spawnFn: async () => {
          spawnCalls++;
          return { code: 0, stdout: "", stderr: "" };
        },
      });

      const result = await runner.runTurn(turnRequest(meta.storyId, dir));

      expect(result.success).toBe(false);
      expect(result.error).toBe("pi write boundary extension unavailable");
      expect(spawnCalls).toBe(0);
    } finally {
      if (previous === undefined) delete process.env.PI_WRITE_BOUNDARY_EXTENSION_PATH;
      else process.env.PI_WRITE_BOUNDARY_EXTENSION_PATH = previous;
    }
  });

  it("task=init retries an invalid bundle without partially applying conceptual files", async () => {
    const meta = await createStory();
    const dir = resolveWorkspaceDir(meta.storyId);
    const invalid = INIT_BUNDLE.replace("=== FILE: actors/keeper.md ===", "=== FILE: story.md ===");
    const { spawn, calls } = makeSpawn([
      { "turn/state-update.md": invalid },
      { "turn/state-update.md": INIT_BUNDLE },
      { "turn/output.md": OUTPUT_MD, "turn/interaction.json": INTERACTION_JSON },
    ]);
    const runner = new PiRunner({ spawnFn: spawn });

    const result = await runner.runTurn({
      ...turnRequest(meta.storyId, dir),
      playerInput: "设定",
      task: "init",
    });

    expect(result.success).toBe(true);
    expect(calls).toHaveLength(3);
    await expect(fs.readFile(path.join(dir, "world.md"), "utf8")).resolves.toContain("废弃灯塔");
  });

  it("task=init exhausts attempts without writing done or partial conceptual files", async () => {
    const meta = await createStory();
    const dir = resolveWorkspaceDir(meta.storyId);
    const invalid = INIT_BUNDLE.replace("=== FILE: actors/keeper.md ===", "=== FILE: story.md ===");
    const { spawn, calls } = makeSpawn([
      { "turn/state-update.md": invalid },
    ]);
    const runner = new PiRunner({ spawnFn: spawn });

    const result = await runner.runTurn({
      ...turnRequest(meta.storyId, dir),
      playerInput: "设定",
      task: "init",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("no init concepts");
    expect(calls).toHaveLength(2);
    await expect(fs.access(path.join(dir, "turn/done.json"))).rejects.toThrow();
    await expect(fs.readFile(path.join(dir, "world.md"), "utf8")).resolves.toContain("占位");
  });

  it("task=init does not retry after a valid bundle hits a filesystem apply error", async () => {
    const meta = await createStory();
    const dir = resolveWorkspaceDir(meta.storyId);
    // Make the second conceptual target an incompatible filesystem entry so
    // world.md is renamed before player.md fails. Orchestrator rollback owns
    // recovery; PiRunner must not run another attempt on this workspace.
    await fs.rm(path.join(dir, "player.md"));
    await fs.mkdir(path.join(dir, "player.md"));
    const { spawn, calls } = makeSpawn([
      {
        "turn/state-update.md": INIT_BUNDLE,
      },
    ]);
    const runner = new PiRunner({ spawnFn: spawn });

    const result = await runner.runTurn({
      ...turnRequest(meta.storyId, dir),
      playerInput: "设定",
      task: "init",
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe("pi init bundle apply failed");
    expect(result.detail).toContain("init bundle apply failed");
    expect(calls).toHaveLength(1);
    await expect(fs.access(path.join(dir, "turn/done.json"))).rejects.toThrow();
  });

  it("task=init rejects a formal-file write even when the attempt exits non-zero", async () => {
    const meta = await createStory();
    const dir = resolveWorkspaceDir(meta.storyId);
    let calls = 0;
    const spawn: SpawnFn = async (_cmd, _args, opts) => {
      calls++;
      await fs.writeFile(path.join(opts.cwd, "turn/state-update.md"), INIT_BUNDLE);
      await fs.writeFile(path.join(opts.cwd, "world.md"), "越权改写\n");
      return { code: 1, stdout: "failed after write", stderr: "model error" };
    };
    const result = await new PiRunner({ spawnFn: spawn }).runTurn({
      ...turnRequest(meta.storyId, dir),
      playerInput: "设定",
      task: "init",
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe("pi init workspace write boundary violated");
    expect(result.detail).toContain("world.md");
    expect(calls).toBe(1);
    await expect(fs.access(path.join(dir, "turn/done.json"))).rejects.toThrow();
  });

  it("task=init rejects an extra file and never retries", async () => {
    const meta = await createStory();
    const dir = resolveWorkspaceDir(meta.storyId);
    let calls = 0;
    const spawn: SpawnFn = async (_cmd, _args, opts) => {
      calls++;
      for (const [file, content] of Object.entries({
        "turn/state-update.md": INIT_BUNDLE,
        "rogue.md": "不应出现\n",
      })) {
        const target = path.join(opts.cwd, file);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, content);
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    const result = await new PiRunner({ spawnFn: spawn }).runTurn({
      ...turnRequest(meta.storyId, dir),
      playerInput: "设定",
      task: "init",
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe("pi init workspace write boundary violated");
    expect(result.detail).toContain("rogue.md");
    expect(calls).toBe(1);
    await expect(fs.access(path.join(dir, "turn/done.json"))).rejects.toThrow();
  });

  it("成功路径：合并 state-update、服务端写 done.json、只 spawn 一次", async () => {
    const meta = await createStory();
    await appendTurnHistory(meta.storyId, {
      turnId: "t0",
      at: new Date().toISOString(),
      input: "开场",
      output: "# 主角视窗\n开场白",
    });
    const dir = resolveWorkspaceDir(meta.storyId);
    const { spawn, calls } = makeSpawn([
      {
        "turn/output.md": OUTPUT_MD,
        "turn/interaction.json": INTERACTION_JSON,
        "turn/state-update.md": STATE_UPDATE_MD,
      },
    ]);
    const runner = new PiRunner({ spawnFn: spawn });

    const result = await runner.runTurn(turnRequest(meta.storyId, dir));

    expect(result.success).toBe(true);
    expect(calls).toHaveLength(1);
    // state-update 已合并进真实状态文件
    const world = await fs.readFile(path.join(dir, "world.md"), "utf8");
    expect(world).toContain("雪夜客栈");
    expect(world).not.toContain("占位");
    // done.json 由服务端写入
    const done = JSON.parse(await fs.readFile(path.join(dir, "turn", "done.json"), "utf8"));
    expect(done.status).toBe("success");
    // pi 配置已生成
    const modelsJson = JSON.parse(await fs.readFile(path.join(piHome, "agent", "models.json"), "utf8"));
    expect(modelsJson.providers.newapi.models[0].id).toBe("qwen-fp8");
  });

  it("首次口述不写盘时自动重试一次", async () => {
    const meta = await createStory();
    const dir = resolveWorkspaceDir(meta.storyId);
    const { spawn, calls } = makeSpawn([
      null,
      { "turn/output.md": OUTPUT_MD, "turn/interaction.json": INTERACTION_JSON },
    ]);
    const runner = new PiRunner({ spawnFn: spawn });

    const result = await runner.runTurn(turnRequest(meta.storyId, dir));

    expect(result.success).toBe(true);
    expect(calls).toHaveLength(2);
    expect(await fs.readFile(path.join(dir, "turn", "output.md"), "utf8")).toBe(OUTPUT_MD);
  });

  it("两次都没写盘 → 失败，错误信息含 attempt 诊断", async () => {
    const meta = await createStory();
    const dir = resolveWorkspaceDir(meta.storyId);
    const { spawn, calls } = makeSpawn([null]);
    const runner = new PiRunner({ spawnFn: spawn });

    const result = await runner.runTurn(turnRequest(meta.storyId, dir));

    expect(result.success).toBe(false);
    expect(result.error).toContain("no turn output");
    expect(result.detail).toContain("attempt 1");
    expect(calls).toHaveLength(2);
    // done.json 不应存在（无成功标记）
    await expect(fs.access(path.join(dir, "turn", "done.json"))).rejects.toThrow();
  });

  it("state-update.md 缺失时降级成功（无状态合并）", async () => {
    const meta = await createStory();
    const dir = resolveWorkspaceDir(meta.storyId);
    const { spawn } = makeSpawn([{ "turn/output.md": OUTPUT_MD, "turn/interaction.json": INTERACTION_JSON }]);
    const runner = new PiRunner({ spawnFn: spawn });

    const result = await runner.runTurn(turnRequest(meta.storyId, dir));

    expect(result.success).toBe(true);
    expect(result.detail).toContain("state-update.md absent or stale");
  });

  it.each(["0", "1"] as const)(
    "普通 turn 的 {} interaction 保持成功并由上层降级（PI_EARLY_EXIT=%s）",
    async (earlyExit) => {
      process.env.PI_EARLY_EXIT = earlyExit;
      const meta = await createStory();
      const { spawn, calls } = makeSpawn([
        { "turn/output.md": OUTPUT_MD, "turn/interaction.json": "{}" },
      ]);

      const outcome = await new TurnOrchestrator(new PiRunner({ spawnFn: spawn })).executeTurn(
        meta.storyId,
        "看向门口",
      );

      expect(outcome.success).toBe(true);
      expect(outcome.interaction).toEqual({ mode: "continue", suggestions: [] });
      expect(calls).toHaveLength(1);
    },
  );

  it("argv 正确：-p/--no-session/--model qwen-fp8，尾参含预注入上下文与玩家输入", async () => {
    const meta = await createStory();
    const dir = resolveWorkspaceDir(meta.storyId);
    const { spawn, calls } = makeSpawn([
      { "turn/output.md": OUTPUT_MD, "turn/interaction.json": INTERACTION_JSON },
    ]);
    const runner = new PiRunner({ spawnFn: spawn });
    await runner.runTurn(turnRequest(meta.storyId, dir));

    expect(calls[0].cmd).toBe("pi");
    expect(calls[0].args).toContain("-p");
    expect(calls[0].args).toContain("--no-session");
    expect(calls[0].args).toContain("qwen-fp8");
    // json 事件流：叙事先行显示的数据源
    const modeIdx = calls[0].args.indexOf("--mode");
    expect(modeIdx).toBeGreaterThan(-1);
    expect(calls[0].args[modeIdx + 1]).toBe("json");
    // 工具面收窄：只允许 write（读/bash 从模型视野移除）
    const toolsIdx = calls[0].args.indexOf("--tools");
    expect(toolsIdx).toBeGreaterThan(-1);
    expect(calls[0].args[toolsIdx + 1]).toBe("write");
    expect(calls[0].args).toContain("--no-extensions");
    expect(calls[0].args).toContain("--extension");
    const userPrompt = calls[0].args[calls[0].args.length - 1];
    expect(userPrompt).toContain("=== world.md ===");
    expect(userPrompt).toContain("=== turns/history.jsonl");
    expect(userPrompt).toContain("我下楼吃面");
    expect(calls[0].opts.cwd).toBe(dir);
  });

  it("早退看门狗：三产物落盘后 SIGTERM，跳过第二次往返仍判成功", async () => {
    const meta = await createStory();
    const dir = resolveWorkspaceDir(meta.storyId);
    const files = {
      "turn/output.md": OUTPUT_MD,
      "turn/interaction.json": INTERACTION_JSON,
      "turn/state-update.md": STATE_UPDATE_MD,
    };
    // mock：写完三产物后"挂住"模拟第二次 LLM 往返，被 kill 才返回 143
    let killed = false;
    const spawn: SpawnFn = async (cmd, args, opts) => {
      for (const [file, content] of Object.entries(files)) {
        const target = path.join(opts.cwd, file);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, content);
      }
      return await new Promise((resolve) => {
        opts._child = {
          kill: () => {
            killed = true;
            resolve({ code: 143, stdout: "", stderr: "" });
          },
        };
      });
    };
    const runner = new PiRunner({ spawnFn: spawn });

    const result = await runner.runTurn(turnRequest(meta.storyId, dir));

    expect(killed).toBe(true); // 看门狗确实提前击杀
    expect(result.success).toBe(true); // fired 跳过退出码检查，产物校验通过
    expect(result.detail).toContain("early-exit fired");
    await expect(fs.readFile(path.join(dir, "turn", "done.json"), "utf8")).resolves.toContain("success");
  }, 10_000);

  it("看门狗不误杀：attempt 开始前已存在的旧产物（mtime 过旧）不触发早退", async () => {
    const meta = await createStory();
    const dir = resolveWorkspaceDir(meta.storyId);
    // 预置三个合法产物但 mtime 设为过去——模拟上一 attempt 残留
    await fs.mkdir(path.join(dir, "turn"), { recursive: true });
    await fs.writeFile(path.join(dir, "turn", "output.md"), OUTPUT_MD);
    await fs.writeFile(path.join(dir, "turn", "interaction.json"), INTERACTION_JSON);
    await fs.writeFile(path.join(dir, "turn", "state-update.md"), STATE_UPDATE_MD);
    const past = new Date(Date.now() - 60_000);
    for (const f of ["output.md", "interaction.json", "state-update.md"]) {
      await fs.utimes(path.join(dir, "turn", f), past, past);
    }
    // mock：不写任何文件，600ms 后自然退出 0（给看门狗两个轮询窗口）
    const spawn: SpawnFn = async () => {
      await new Promise((r) => setTimeout(r, 600));
      return { code: 0, stdout: "回合完成", stderr: "" };
    };
    const runner = new PiRunner({ spawnFn: spawn });

    const result = await runner.runTurn(turnRequest(meta.storyId, dir));

    // 看门狗不误杀（旧产物不触发早退）；且旧产物不得被当成本回合提交——
    // 全部 attempt 均无新鲜产物 → 回合失败（旧产物蒙混提交是实测过的 bug）
    expect(result.success).toBe(false);
    expect(result.error).toContain("no turn output");
    expect(result.detail ?? "").not.toContain("early-exit fired");
    expect(result.detail ?? "").toContain("stale/missing");
  }, 10_000);

  it("随机判定：池注入 prompt，申报经服务端权威重算落账 random-rolls.jsonl", async () => {
    const meta = await createStory();
    const dir = resolveWorkspaceDir(meta.storyId);
    const files = {
      "turn/output.md": OUTPUT_MD,
      "turn/interaction.json": INTERACTION_JSON,
      "turn/state-update.md": [
        "=== FILE: world.md ===",
        "APPEND: ## 时间线",
        "=== RANDOM ===",
        "R1: rollId=lockpick candidates=success:25,fail:75 → fail",
      ].join("\n"),
    };
    const { spawn, calls } = makeSpawn([files]);
    // 0.9×100=90 落在 fail(25-100) 区间 → 权威结果 fail，与申报一致
    const runner = new PiRunner({ spawnFn: spawn, rollRng: () => 0.9 });

    const result = await runner.runTurn(turnRequest(meta.storyId, dir));

    expect(result.success).toBe(true);
    const userPrompt = calls[0].args[calls[0].args.length - 1];
    expect(userPrompt).toContain("=== 随机数池");
    expect(userPrompt).toContain("R1=0.900000");
    expect(userPrompt).toContain("R6="); // 默认池 6 个样本

    const raw = await fs.readFile(path.join(dir, "logs", "random-rolls.jsonl"), "utf8");
    const line = JSON.parse(raw.trim()) as Record<string, unknown>;
    expect(line).toMatchObject({
      storyId: meta.storyId,
      rollId: "lockpick",
      type: "roll-choice",
      selectedId: "fail",
      randomSource: "pool",
      sample: 0.9,
    });
  });

  it("申报结果与权威重算不一致：回合仍成功，detail 记 mismatch", async () => {
    const meta = await createStory();
    const dir = resolveWorkspaceDir(meta.storyId);
    const files = {
      "turn/output.md": OUTPUT_MD,
      "turn/interaction.json": INTERACTION_JSON,
      "turn/state-update.md": [
        "=== RANDOM ===",
        "R1: rollId=persuade candidates=yes:50,no:50 → yes",
      ].join("\n"),
    };
    const { spawn } = makeSpawn([files]);
    const runner = new PiRunner({ spawnFn: spawn, rollRng: () => 0.9 }); // 0.9×100=90 → no

    const result = await runner.runTurn(turnRequest(meta.storyId, dir));

    expect(result.success).toBe(true);
    expect(result.detail).toContain("declared yes but authoritative no");
    const raw = await fs.readFile(path.join(dir, "logs", "random-rolls.jsonl"), "utf8");
    const line = JSON.parse(raw.trim()) as Record<string, unknown>;
    expect(line.selectedId).toBe("no"); // 落账以服务端重算为准
  });

  it("乱序申报跳过且不消耗号位；后续按序申报仍可落账", async () => {
    const meta = await createStory();
    const dir = resolveWorkspaceDir(meta.storyId);
    const files = {
      "turn/output.md": OUTPUT_MD,
      "turn/interaction.json": INTERACTION_JSON,
      "turn/state-update.md": [
        "=== RANDOM ===",
        "R2: rollId=jumped candidates=x:1 → x",
        "R1: rollId=first candidates=x:1 → x",
      ].join("\n"),
    };
    const { spawn } = makeSpawn([files]);
    const runner = new PiRunner({ spawnFn: spawn, rollRng: () => 0.5 });

    const result = await runner.runTurn(turnRequest(meta.storyId, dir));

    expect(result.success).toBe(true);
    expect(result.detail).toContain("roll skipped (out of order): R2, expected R1");
    // 乱序 R2 未消耗号位，R1 仍按序落账
    const raw = await fs.readFile(path.join(dir, "logs", "random-rolls.jsonl"), "utf8");
    const lines = raw.trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ rollId: "first", sample: 0.5 });
  });
});

// --- 叙事先行预览（--mode json 事件流 → turn-progress） ---

/** 构造 pi --mode json 的 toolcall_end 事件行（contentIndex 指向 blocks 下标） */
function piToolcallEndLine(contentIndex: number, filePath: string, content: string): string {
  return JSON.stringify({
    type: "message_update",
    assistantMessageEvent: {
      type: "toolcall_end",
      contentIndex,
      partial: {
        content: [
          { type: "thinking", thinking: "（隐藏思考）" },
          { type: "toolCall", name: "write", arguments: { path: filePath, content } },
        ],
      },
    },
  });
}

/**
 * mock spawn：写盘行为同 makeSpawn，额外在写盘前后经 onStdoutLine
 * 回放事件流（模拟 pi 逐事件输出）。
 */
function makeEventSpawn(
  script: (null | { files: Record<string, string>; events: string[] })[],
): { spawn: SpawnFn; calls: CallRecord[] } {
  let i = 0;
  const calls: CallRecord[] = [];
  const spawn: SpawnFn = async (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    const step = script[Math.min(i, script.length - 1)];
    i++;
    if (step) {
      for (const line of step.events) opts.onStdoutLine?.(line);
      for (const [file, content] of Object.entries(step.files)) {
        const target = path.join(opts.cwd, file);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, content);
      }
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  return { spawn, calls };
}

describe("PiRunner 叙事先行预览", () => {
  it("toolcall_end(output.md/interaction.json) 事件发布叙事与交互预览", async () => {
    const meta = await createStory();
    const dir = resolveWorkspaceDir(meta.storyId);
    const { spawn } = makeEventSpawn([
      {
        files: {
          "turn/output.md": OUTPUT_MD,
          "turn/interaction.json": INTERACTION_JSON,
          "turn/state-update.md": STATE_UPDATE_MD,
        },
        events: [
          piToolcallEndLine(1, path.join(dir, "turn", "output.md"), OUTPUT_MD),
          piToolcallEndLine(1, path.join(dir, "turn", "interaction.json"), INTERACTION_JSON),
        ],
      },
    ]);
    const runner = new PiRunner({ spawnFn: spawn });

    const result = await runner.runTurn(turnRequest(meta.storyId, dir));

    expect(result.success).toBe(true);
    const progress = readTurnProgress(meta.storyId);
    expect(progress).not.toBeNull();
    expect(progress!.narrative).toContain("你推门进来");
    expect(progress!.interaction?.mode).toBe("decision");
    expect(["narrative-ready", "interaction-ready"]).toContain(progress!.phase);
    clearTurnProgress(meta.storyId);
  });

  it("首行契约不合规的 output.md 不发布预览", async () => {
    const meta = await createStory();
    const dir = resolveWorkspaceDir(meta.storyId);
    const bad = "（没有标题行的口述正文）\n";
    const { spawn } = makeEventSpawn([
      {
        files: { "turn/output.md": OUTPUT_MD, "turn/interaction.json": INTERACTION_JSON },
        events: [piToolcallEndLine(1, path.join(dir, "turn", "output.md"), bad)],
      },
    ]);
    const runner = new PiRunner({ spawnFn: spawn });

    await runner.runTurn(turnRequest(meta.storyId, dir));

    const progress = readTurnProgress(meta.storyId);
    expect(progress?.narrative).toBeUndefined();
    clearTurnProgress(meta.storyId);
  });

  it("预览泄密守卫：output.md 逐字包含随机账本行不发布", async () => {
    const meta = await createStory();
    const dir = resolveWorkspaceDir(meta.storyId);
    const rollLine = JSON.stringify({
      rollId: "leaky",
      sample: 0.42,
      candidates: [{ id: "yes", weight: 50 }],
      selectedId: "yes",
    });
    await fs.mkdir(path.join(dir, "logs"), { recursive: true });
    await fs.writeFile(path.join(dir, "logs", "random-rolls.jsonl"), rollLine + "\n");
    const leaky = "# 主角视窗\n\n" + rollLine + "\n";
    const { spawn } = makeEventSpawn([
      {
        files: { "turn/output.md": OUTPUT_MD, "turn/interaction.json": INTERACTION_JSON },
        events: [piToolcallEndLine(1, path.join(dir, "turn", "output.md"), leaky)],
      },
    ]);
    const runner = new PiRunner({ spawnFn: spawn });

    await runner.runTurn(turnRequest(meta.storyId, dir));

    expect(readTurnProgress(meta.storyId)?.narrative).toBeUndefined();
    clearTurnProgress(meta.storyId);
  });

  it("重试重开时预览被重置：最终预览来自第二次 attempt", async () => {
    const meta = await createStory();
    const dir = resolveWorkspaceDir(meta.storyId);
    const firstNarrative = "# 主角视窗\n\n第一次尝试的叙事。\n";
    const { spawn, calls } = makeEventSpawn([
      // attempt 1：发布预览但不写盘（口述失效模式）
      {
        files: {},
        events: [piToolcallEndLine(1, path.join(dir, "turn", "output.md"), firstNarrative)],
      },
      // attempt 2：不同叙事 + 全产物落盘
      {
        files: {
          "turn/output.md": OUTPUT_MD,
          "turn/interaction.json": INTERACTION_JSON,
        },
        events: [piToolcallEndLine(1, path.join(dir, "turn", "output.md"), OUTPUT_MD)],
      },
    ]);
    const runner = new PiRunner({ spawnFn: spawn });

    const result = await runner.runTurn(turnRequest(meta.storyId, dir));

    expect(result.success).toBe(true);
    expect(calls).toHaveLength(2);
    const progress = readTurnProgress(meta.storyId);
    expect(progress!.narrative).toContain("你推门进来");
    expect(progress!.narrative).not.toContain("第一次尝试的叙事");
    clearTurnProgress(meta.storyId);
  });

  it("init 预览 output 先到时等待本 attempt 的 interaction，再发布叙事", async () => {
    const meta = await createStory();
    const dir = resolveWorkspaceDir(meta.storyId);
    const initOutput = "# 主角视窗\n\n灯塔门在雾里发出一声轻响。\n";
    const initInteraction = JSON.stringify({ mode: "continue", suggestions: [] });
    let calls = 0;
    const spawn: SpawnFn = async (_cmd, _args, opts) => {
      calls++;
      if (calls === 1) {
        await fs.writeFile(path.join(dir, "turn/state-update.md"), INIT_BUNDLE);
        return { code: 0, stdout: "", stderr: "" };
      }
      opts.onStdoutLine?.(piToolcallEndLine(1, path.join(dir, "turn", "output.md"), initOutput));
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(readTurnProgress(meta.storyId)?.narrative).toBeUndefined();
      opts.onStdoutLine?.(
        piToolcallEndLine(1, path.join(dir, "turn", "interaction.json"), initInteraction),
      );
      await fs.writeFile(path.join(dir, "turn/output.md"), initOutput);
      await fs.writeFile(path.join(dir, "turn/interaction.json"), initInteraction);
      return { code: 0, stdout: "", stderr: "" };
    };

    const result = await new PiRunner({ spawnFn: spawn }).runTurn({
      ...turnRequest(meta.storyId, dir),
      playerInput: "设定",
      task: "init",
    });

    expect(result.success).toBe(true);
    expect(readTurnProgress(meta.storyId)?.narrative).toContain("灯塔门");
    clearTurnProgress(meta.storyId);
  });

  it("init concepts 阶段的 output/interaction 事件不发布任何预览", async () => {
    const meta = await createStory();
    const dir = resolveWorkspaceDir(meta.storyId);
    let calls = 0;
    const spawn: SpawnFn = async (_cmd, _args, opts) => {
      calls++;
      if (calls === 1) {
        opts.onStdoutLine?.(
          piToolcallEndLine(1, path.join(dir, "turn/output.md"), OUTPUT_MD),
        );
        opts.onStdoutLine?.(
          piToolcallEndLine(1, path.join(dir, "turn/interaction.json"), INTERACTION_JSON),
        );
        const progress = readTurnProgress(meta.storyId);
        expect(progress?.narrative).toBeUndefined();
        expect(progress?.interaction).toBeUndefined();
        await fs.writeFile(path.join(dir, "turn/state-update.md"), INIT_BUNDLE);
      } else {
        await fs.writeFile(path.join(dir, "turn/output.md"), OUTPUT_MD);
        await fs.writeFile(path.join(dir, "turn/interaction.json"), INTERACTION_JSON);
      }
      return { code: 0, stdout: "", stderr: "" };
    };

    const result = await new PiRunner({ spawnFn: spawn }).runTurn({
      ...turnRequest(meta.storyId, dir),
      playerInput: "设定",
      task: "init",
    });

    expect(result.success, result.error ?? result.detail).toBe(true);
    const progress = readTurnProgress(meta.storyId);
    expect(progress?.narrative).toBeUndefined();
    expect(progress?.interaction).toBeUndefined();
    clearTurnProgress(meta.storyId);
  });

  it.each([
    ["output-first", ["output", "interaction"]],
    ["interaction-first", ["interaction", "output"]],
  ] as const)("init 预览 %s 时使用本 attempt interaction 阻止 output 泄漏", async (_label, order) => {
    const meta = await createStory();
    const dir = resolveWorkspaceDir(meta.storyId);
    const interaction = JSON.stringify({ mode: "decision", suggestions: ["打开门"] });
    const leakyOutput = `# 主角视窗\n\n${interaction}\n`;
    let calls = 0;
    const spawn: SpawnFn = async (_cmd, _args, opts) => {
      calls++;
      if (calls === 1) {
        await fs.writeFile(path.join(dir, "turn/state-update.md"), INIT_BUNDLE);
        return { code: 0, stdout: "", stderr: "" };
      }
      for (const item of order) {
        opts.onStdoutLine?.(
          piToolcallEndLine(
            1,
            path.join(dir, `turn/${item}.md`.replace("interaction.md", "interaction.json")),
            item === "output" ? leakyOutput : interaction,
          ),
        );
      }
      await fs.writeFile(path.join(dir, "turn/output.md"), leakyOutput);
      await fs.writeFile(path.join(dir, "turn/interaction.json"), interaction);
      return { code: 0, stdout: "", stderr: "" };
    };

    const result = await new PiRunner({ spawnFn: spawn }).runTurn({
      ...turnRequest(meta.storyId, dir),
      playerInput: "设定",
      task: "init",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("no init opening");
    expect(readTurnProgress(meta.storyId)?.narrative).toBeUndefined();
    await expect(fs.access(path.join(dir, "turn/done.json"))).rejects.toThrow();
    clearTurnProgress(meta.storyId);
  });
});

// --- 旧产物新鲜度守卫（实测 bug 回归：口述失效 + 残留上回合产物） ---

describe("PiRunner 旧产物守卫", () => {
  it("口述失效且盘上残留上回合产物时拒绝旧产物并重试，不把旧 output 当本回合提交", async () => {
    const meta = await createStory();
    const dir = resolveWorkspaceDir(meta.storyId);
    // 预置"上一回合"产物（attempt 前已存在 → 进入 mtime 基线）
    await fs.mkdir(path.join(dir, "turn"), { recursive: true });
    const STALE_OUTPUT = "# 主角视窗\n\n上一回合的旧叙事，绝不能被当成本回合提交。\n";
    const STALE_INTERACTION = JSON.stringify({ mode: "continue", suggestions: [] });
    const STALE_STATE = STATE_UPDATE_MD;
    await fs.writeFile(path.join(dir, "turn", "output.md"), STALE_OUTPUT);
    await fs.writeFile(path.join(dir, "turn", "interaction.json"), STALE_INTERACTION);
    await fs.writeFile(path.join(dir, "turn", "state-update.md"), STALE_STATE);

    // attempt 1：口述失效（退出码 0 但不写盘）→ 旧产物必须被新鲜度门拦下
    // attempt 2：正常写盘
    const { spawn, calls } = makeSpawn([
      null,
      {
        "turn/output.md": OUTPUT_MD,
        "turn/interaction.json": INTERACTION_JSON,
        "turn/state-update.md": STATE_UPDATE_MD,
      },
    ]);
    const runner = new PiRunner({ spawnFn: spawn });

    const result = await runner.runTurn(turnRequest(meta.storyId, dir));

    expect(result.success).toBe(true);
    expect(calls).toHaveLength(2);
    // 提交的是 attempt 2 的新产物，不是盘上残留的旧产物
    expect(await fs.readFile(path.join(dir, "turn", "output.md"), "utf8")).toBe(OUTPUT_MD);
  });

  it("自然退出且产物齐且新鲜时不重试（新鲜度门不误伤正常路径）", async () => {
    const meta = await createStory();
    const dir = resolveWorkspaceDir(meta.storyId);
    const { spawn, calls } = makeSpawn([
      {
        "turn/output.md": OUTPUT_MD,
        "turn/interaction.json": INTERACTION_JSON,
        "turn/state-update.md": STATE_UPDATE_MD,
      },
    ]);
    const runner = new PiRunner({ spawnFn: spawn });

    const result = await runner.runTurn(turnRequest(meta.storyId, dir));

    expect(result.success).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("残留旧 state-update 不重放：口述失效后的成功 attempt 只合并新 state-update", async () => {
    const meta = await createStory();
    const dir = resolveWorkspaceDir(meta.storyId);
    await fs.mkdir(path.join(dir, "turn"), { recursive: true });
    // 旧的 REPLACE 指令若被重放，world.md 会被旧值覆盖
    const STALE_STATE = ["=== FILE: world.md ===", "REPLACE: （占位）→ 旧值不应出现"].join("\n");
    await fs.writeFile(path.join(dir, "turn", "output.md"), "# 主角视窗\n旧\n");
    await fs.writeFile(path.join(dir, "turn", "interaction.json"), INTERACTION_JSON);
    await fs.writeFile(path.join(dir, "turn", "state-update.md"), STALE_STATE);
    const FRESH_STATE = [
      "=== FILE: world.md ===",
      "REPLACE: （占位：场景、地点、时间与隐藏事实。后续初始化 agent 填充。）→ 新值应当出现",
    ].join("\n");

    const { spawn } = makeSpawn([
      {
        "turn/output.md": OUTPUT_MD,
        "turn/interaction.json": INTERACTION_JSON,
        "turn/state-update.md": FRESH_STATE,
      },
    ]);
    const runner = new PiRunner({ spawnFn: spawn });

    const result = await runner.runTurn(turnRequest(meta.storyId, dir));

    expect(result.success).toBe(true);
    const world = await fs.readFile(path.join(dir, "world.md"), "utf8");
    expect(world).toContain("新值应当出现");
    expect(world).not.toContain("旧值不应出现");
  });
});
