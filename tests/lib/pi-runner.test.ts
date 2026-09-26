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
import { parseFactLedger } from "@/lib/fact-ledger";
import { useTempWorkspaceRoot, resetWorkspaceRoot } from "../helpers/workspace-env";

/**
 * Init-only mock spawn：模拟 pi 的写工具。普通 turn 已迁移到
 * server-owned message_end 响应协议，见 makeResponseSpawn。
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

type ResponseStep = {
  value?: unknown;
  stdout?: string;
  code?: number;
  stderr?: string;
  write?: Record<string, string>;
};

function makeResponseSpawn(script: ResponseStep[]): { spawn: SpawnFn; calls: CallRecord[] } {
  let index = 0;
  const calls: CallRecord[] = [];
  const spawn: SpawnFn = async (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    const step = script[Math.min(index, script.length - 1)] ?? {};
    index++;
    for (const [file, content] of Object.entries(step.write ?? {})) {
      const target = path.join(opts.cwd, file);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, content);
    }
    if (step.value !== undefined) opts.onStdoutLine?.(messageEnd(step.value));
    return { code: step.code ?? 0, stdout: step.stdout ?? "", stderr: step.stderr ?? "" };
  };
  return { spawn, calls };
}

const OUTPUT_MD = "# 主角视窗\n\n你推门进来，热气扑面。\n";
const INTERACTION_JSON = JSON.stringify({ mode: "decision", suggestions: ["应和一句"] });
const PUBLIC_SCENE_JSON = JSON.stringify({
  time: "第一天清晨",
  location: "灯塔门口",
  narrativeVoice: "第一人称限知",
  knownFacts: ["灯快熄了"],
  visibleActors: [{ name: "守塔人", appearance: "旧雨衣", voice: "短句" }],
});
const TURN_RESPONSE = {
  kind: "turn",
  output: OUTPUT_MD,
  interaction: { mode: "continue", suggestions: [] },
  stateUpdate: { sections: [], rolls: [] },
};
const LEDGER_UPDATE = {
  version: "1",
  appendEvents: [{
    id: "card-e1",
    kind: "event",
    text: "主角在灯房看见守塔人添油。",
    source: "model",
    time: "第一夜",
    location: "灯房",
    witnesses: ["主角", "守塔人"],
    visibility: "public",
    causedBy: [],
  }],
  upsertKnowledgeBoundaries: [],
  resolve: [],
  retireIds: [],
};
const STATE_UPDATE_MD = [
  "=== FILE: world.md ===",
  "APPEND: ## 时间线",
  "REPLACE: （占位：场景、地点、时间与隐藏事实。后续初始化 agent 填充。）→ 雪夜客栈",
].join("\n");

const INIT_BUNDLE = [
  "=== FILE: world.md ===",
  "# 世界设定\n\n雨夜的废弃灯塔，雾潮会在黎明前上涨。",
  "=== FILE: player.md ===",
  `# 主角\n\n## 用户设定（canon）\n雾中的守塔学徒。\n\n## Public Scene\n${PUBLIC_SCENE_JSON}\n\n## Protagonist Core\nnarrativeVoice: 第一人称限知。\n\n## Player Agency\n重大决定交还玩家。`,
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
  "PI_MAX_ATTEMPTS",
  "PI_EARLY_EXIT",
  "PI_WRITE_BOUNDARY_EXTENSION_PATH",
  "PI_UNCOMMITTED_PREVIEW",
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
  it("reports an invalid fresh init bundle as invalid, not missing or stale", async () => {
    const meta = await createStory();
    const dir = resolveWorkspaceDir(meta.storyId);
    const { spawn } = makeSpawn([{ "turn/state-update.md": INIT_BUNDLE.replace("## Emotional Core", "## Wrong Heading") }]);
    const result = await new PiRunner({ spawnFn: spawn }).runTurn({ ...turnRequest(meta.storyId, dir), task: "init" });
    expect(result.success).toBe(false);
    expect(result.detail).toContain("missing emotional core heading");
    expect(result.detail).not.toContain("init bundle missing or stale");
  });

  it("retries a Phase 1 bundle missing Public Scene, then applies no concepts", async () => {
    const meta = await createStory();
    const dir = resolveWorkspaceDir(meta.storyId);
    const withoutPublicScene = INIT_BUNDLE.replace(`## Public Scene\n${PUBLIC_SCENE_JSON}\n\n`, "");
    const { spawn, calls } = makeSpawn([{ "turn/state-update.md": withoutPublicScene }]);
    process.env.PI_MAX_ATTEMPTS = "2";

    const result = await new PiRunner({ spawnFn: spawn }).runTurn({
      ...turnRequest(meta.storyId, dir),
      task: "init",
    });

    expect(result.success).toBe(false);
    expect(calls).toHaveLength(2);
    expect(result.detail).toMatch(/public scene/i);
    await expect(fs.readFile(path.join(dir, "world.md"), "utf8")).resolves.toContain("占位");
    await expect(fs.access(path.join(dir, "actors/keeper.md"))).rejects.toThrow();
    await expect(fs.access(path.join(dir, "turn/done.json"))).rejects.toThrow();
  });

  it("rolls back a complete response when its state candidate is invalid", async () => {
    const meta = await createStory();
    const dir = resolveWorkspaceDir(meta.storyId);
    const worldBefore = await fs.readFile(path.join(dir, "world.md"), "utf8");
    const { spawn } = makeResponseSpawn([{
      value: { ...TURN_RESPONSE, stateUpdate: "=== FILE: player.md ===\nREPLACE: 不存在的旧文本 → 承诺被记录" },
    }]);
    const outcome = await new TurnOrchestrator(new PiRunner({ spawnFn: spawn })).executeTurn(meta.storyId, "约定明天见面");
    expect(outcome.success).toBe(false);
    expect(await fs.readFile(path.join(dir, "world.md"), "utf8")).toBe(worldBefore);
    await expect(fs.access(path.join(dir, "turn/done.json"))).rejects.toThrow();
  });

  it("ordinary turn never previews a complete response, even when preview is enabled", async () => {
    process.env.PI_UNCOMMITTED_PREVIEW = "1";
    const meta = await createStory();
    const dir = resolveWorkspaceDir(meta.storyId);
    const { spawn } = makeResponseSpawn([{ value: TURN_RESPONSE }]);
    expect((await new PiRunner({ spawnFn: spawn }).runTurn(turnRequest(meta.storyId, dir))).success).toBe(true);
    expect(readTurnProgress(meta.storyId)?.narrative).toBeUndefined();
    clearTurnProgress(meta.storyId);
  });

  it("passes the experimental fact ledger to the real turn prompt without changing the baseline", async () => {
    const meta = await createStory();
    const dir = resolveWorkspaceDir(meta.storyId);
    const ledger = parseFactLedger({
      version: "1",
      events: [
        {
          id: "ledger-e1",
          text: "主角独自知道北门暗格里有半张海图。",
          source: "player",
          time: "第三夜",
          location: "北门暗格",
          witnesses: ["主角"],
          visibility: "private",
          causedBy: [],
        },
      ],
    });

    const baselineSpawn = makeResponseSpawn([{ value: TURN_RESPONSE }]);
    const baseline = await new PiRunner({ spawnFn: baselineSpawn.spawn }).runTurn(turnRequest(meta.storyId, dir));
    const ledgerSpawn = makeResponseSpawn([{ value: TURN_RESPONSE }]);
    const ledgerResult = await new PiRunner({ spawnFn: ledgerSpawn.spawn, experimentalFactLedger: ledger }).runTurn(turnRequest(meta.storyId, dir));

    expect(baseline.success, baseline.detail).toBe(true);
    expect(ledgerResult.success, ledgerResult.detail).toBe(true);
    expect(baselineSpawn.calls[0].args.at(-1)).not.toContain("权威薄事实账本");
    expect(ledgerSpawn.calls[0].args.at(-1)).toContain("权威薄事实账本");
    expect(ledgerSpawn.calls[0].args.at(-1)).toContain("知识边界=");
    expect(ledgerSpawn.calls[0].args.at(-1)).not.toContain("factLedgerUpdate 字段");
    expect(ledgerSpawn.calls[0].args.at(-1)).not.toContain("ledger-e1");
    expect(ledgerSpawn.calls[0].args.at(-1)).not.toContain("半张海图");
  });

  it("public continuity card reads, validates, persists, and injects the next card", async () => {
    const meta = await createStory();
    const dir = resolveWorkspaceDir(meta.storyId);
    const { spawn, calls } = makeResponseSpawn([{ value: { ...TURN_RESPONSE, factLedgerUpdate: LEDGER_UPDATE } }]);

    const runner = new PiRunner({ spawnFn: spawn, publicContinuityCard: true });
    const first = await runner.runTurn(turnRequest(meta.storyId, dir));
    expect(first.success, first.detail).toBe(true);

    const saved = await fs.readFile(path.join(dir, "continuity-card.json"), "utf8");
    expect(saved).toContain("card-e1");
    expect(saved).toContain("主角在灯房看见守塔人添油。");
    expect(calls[0].args[calls[0].args.indexOf("--system-prompt") + 1]).toContain("五个字段缺一不可");
    expect(calls[0].args.at(-1)).toContain("权威薄事实账本（只读）");
    expect(calls[0].args.at(-1)).toContain("（无事件）");
    expect(calls[0].args.at(-1)).toContain("factLedgerUpdate");

    const secondSpawn = makeResponseSpawn([{
      value: {
        ...TURN_RESPONSE,
        factLedgerUpdate: { ...LEDGER_UPDATE, appendEvents: [], retireIds: [] },
      },
    }]);
    const second = await new PiRunner({
      spawnFn: secondSpawn.spawn,
      publicContinuityCard: true,
    }).runTurn(turnRequest(meta.storyId, dir));
    expect(second.success, second.detail).toBe(true);
    expect(secondSpawn.calls[0].args.at(-1)).toContain("id=card-e1");
    expect(secondSpawn.calls[0].args.at(-1)).toContain("text=主角在灯房看见守塔人添油。");
  });

  it("invalid public continuity update retries before writes, then persists no card", async () => {
    const meta = await createStory();
    const dir = resolveWorkspaceDir(meta.storyId);
    const invalid = {
      ...LEDGER_UPDATE,
      appendEvents: [{ ...LEDGER_UPDATE.appendEvents[0], visibility: "private" }],
    };
    const { spawn, calls } = makeResponseSpawn([
      { value: { ...TURN_RESPONSE, factLedgerUpdate: invalid } },
      { value: { ...TURN_RESPONSE, factLedgerUpdate: invalid } },
    ]);
    process.env.PI_MAX_ATTEMPTS = "2";

    const result = await new PiRunner({ spawnFn: spawn, publicContinuityCard: true })
      .runTurn(turnRequest(meta.storyId, dir));

    expect(result.success).toBe(false);
    expect(calls).toHaveLength(2);
    await expect(fs.access(path.join(dir, "continuity-card.json"))).rejects.toThrow();
    await expect(fs.readFile(path.join(dir, "turn/output.md"), "utf8"))
      .resolves.toContain("占位");
  });

  it("commits a locally valid candidate when independent semantic review passes", async () => {
    const meta = await createStory();
    const dir = resolveWorkspaceDir(meta.storyId);
    const { spawn, calls } = makeResponseSpawn([{ value: TURN_RESPONSE }]);
    const reviews: Array<{ authoritativeContext: string; candidateResponse: string }> = [];

    const result = await new PiRunner({
      spawnFn: spawn,
      semanticReviewer: async (request) => {
        reviews.push(request);
        return { pass: true };
      },
    }).runTurn(turnRequest(meta.storyId, dir));

    expect(result.success, result.detail).toBe(true);
    expect(calls).toHaveLength(1);
    expect(reviews).toHaveLength(1);
    expect(reviews[0].authoritativeContext).toContain("我下楼吃面");
    expect(reviews[0].candidateResponse).toContain("主角视窗");
    await expect(fs.readFile(path.join(dir, "turn/output.md"), "utf8"))
      .resolves.toBe(OUTPUT_MD);
  });

  it("gives one rejected semantic candidate back for exactly one repair", async () => {
    process.env.PI_MAX_ATTEMPTS = "1";
    const meta = await createStory();
    const dir = resolveWorkspaceDir(meta.storyId);
    const repaired = { ...TURN_RESPONSE, output: "# 主角视窗\n\n我下楼吃面，没有替任何人作决定。\n" };
    const { spawn, calls } = makeResponseSpawn([
      { value: TURN_RESPONSE },
      { value: repaired },
    ]);
    let reviewCount = 0;

    const result = await new PiRunner({
      spawnFn: spawn,
      semanticReviewer: async () => (++reviewCount === 1
        ? { pass: false, issues: ["候选替玩家接受了尚未决定的安排"] }
        : { pass: true }),
    }).runTurn(turnRequest(meta.storyId, dir));

    expect(result.success, result.detail).toBe(true);
    expect(calls).toHaveLength(2);
    expect(reviewCount).toBe(2);
    expect(calls[1].args.at(-1)).toContain("候选替玩家接受了尚未决定的安排");
    expect(calls[1].args.at(-1)).toContain("<previous_semantic_candidate>");
    await expect(fs.readFile(path.join(dir, "turn/output.md"), "utf8"))
      .resolves.toBe(repaired.output);
  });

  it("keeps the one semantic repair after the format retry budget is consumed", async () => {
    process.env.PI_MAX_ATTEMPTS = "2";
    const meta = await createStory();
    const dir = resolveWorkspaceDir(meta.storyId);
    const repaired = { ...TURN_RESPONSE, output: "# 主角视窗\n\n我保留这个尚未决定的选择。\n" };
    const { spawn, calls } = makeResponseSpawn([
      { stdout: "not a terminal response" },
      { value: TURN_RESPONSE },
      { value: repaired },
    ]);
    let reviewCount = 0;

    const result = await new PiRunner({
      spawnFn: spawn,
      semanticReviewer: async () => (++reviewCount === 1
        ? { pass: false, issues: ["把开放选择写成了既定决定"] }
        : { pass: true }),
    }).runTurn(turnRequest(meta.storyId, dir));

    expect(result.success, result.detail).toBe(true);
    expect(calls).toHaveLength(3);
    expect(reviewCount).toBe(2);
    expect(calls[2].args.at(-1)).toContain("把开放选择写成了既定决定");
  });

  it("fails closed when the one semantic repair is rejected again", async () => {
    process.env.PI_MAX_ATTEMPTS = "2";
    const meta = await createStory();
    const dir = resolveWorkspaceDir(meta.storyId);
    const { spawn, calls } = makeResponseSpawn([
      { value: TURN_RESPONSE },
      { value: TURN_RESPONSE },
      { value: TURN_RESPONSE },
    ]);

    const result = await new PiRunner({
      spawnFn: spawn,
      semanticReviewer: async () => ({ pass: false, issues: ["仍含无来源事实"] }),
    }).runTurn(turnRequest(meta.storyId, dir));

    expect(result.success).toBe(false);
    expect(result.error).toBe("semantic repair rejected");
    expect(calls).toHaveLength(2);
    await expect(fs.readFile(path.join(dir, "turn/output.md"), "utf8"))
      .resolves.toContain("占位");
  });

  it("fails closed without writes when semantic review crashes", async () => {
    const meta = await createStory();
    const dir = resolveWorkspaceDir(meta.storyId);
    const { spawn } = makeResponseSpawn([{ value: TURN_RESPONSE }]);

    const result = await new PiRunner({
      spawnFn: spawn,
      semanticReviewer: async () => { throw new Error("reviewer unavailable"); },
    }).runTurn(turnRequest(meta.storyId, dir));

    expect(result.success).toBe(false);
    expect(result.error).toBe("semantic review failed");
    await expect(fs.readFile(path.join(dir, "turn/output.md"), "utf8"))
      .resolves.toContain("占位");
  });

  it("rejects combining public continuity card with scene separation", () => {
    expect(() => new PiRunner({
      experimentalSceneSeparation: true,
      publicContinuityCard: true,
    })).toThrow(/cannot be combined/);
  });

  it("keeps a bound outcome across response retries without drawing again", async () => {
    const meta = await createStory();
    const dir = resolveWorkspaceDir(meta.storyId);
    const request = { kind: "roll-request", rolls: [{ rollId: "risk", candidates: [{ id: "yes", weight: 1 }, { id: "no", weight: 1 }] }] };
    const randomTurn = {
      ...TURN_RESPONSE,
      stateUpdate: {
        sections: [],
        rolls: [{
          index: 1,
          rollId: "risk",
          candidates: [{ id: "yes", weight: 1 }, { id: "no", weight: 1 }],
          declaredSelectedId: "no",
        }],
      },
    };
    const { spawn, calls } = makeResponseSpawn([
      { value: request },
      {},
      { value: randomTurn },
    ]);
    let draws = 0;
    process.env.PI_MAX_ATTEMPTS = "2";
    const outcome = await new PiRunner({ spawnFn: spawn, rollRng: () => { draws++; return 0.9; } }).runTurn(turnRequest(meta.storyId, dir));
    expect(outcome.success, outcome.detail).toBe(true);
    expect(draws).toBe(1);
    expect(calls).toHaveLength(3);
    for (const call of calls.slice(1)) {
      expect(call.args.at(-1)).toContain("R1: rollId=risk candidates=yes:1,no:1 → no");
    }
  });

  it("experimental scene path separates world decisions from prose and commits together", async () => {
    const meta = await createStory();
    const dir = resolveWorkspaceDir(meta.storyId);
    await fs.writeFile(path.join(dir, "world.md"), "# 世界\n秘密：她烧了船票\n");
    await fs.writeFile(path.join(dir, "player.md"), `# 主角\n\n## Public Scene\n${PUBLIC_SCENE_JSON}\n`);
    const plan = {
      kind: "scene",
      visibleEvents: ["她把手从灶边收回。"],
      publicScene: JSON.parse(PUBLIC_SCENE_JSON),
      stateUpdate: {
        sections: [{ file: "world.md", ops: [{ kind: "append", text: "私下销毁证据" }] }],
        rolls: [],
      },
      interaction: { mode: "decision", suggestions: ["问她怎么了"] },
    };
    const rendered = { kind: "render", output: "# 主角视窗\n她把手从灶边收回。我停在门口，等她开口。" };
    const { spawn, calls } = makeResponseSpawn([
      { value: plan },
      { value: rendered },
    ]);
    const outcome = await new TurnOrchestrator(new PiRunner({ spawnFn: spawn, experimentalSceneSeparation: true })).executeTurn(meta.storyId, "我想她可能烧了船票");
    expect(outcome.success, outcome.error).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[0].args.at(-1)).toContain("烧了船票");
    expect(calls[0].args).toContain("--no-tools");
    expect(calls[1].args).toContain("--no-tools");
    expect(calls[1].args.at(-1)).not.toContain("烧了船票");
    expect(calls[1].args.at(-1)).not.toContain("销毁证据");
    expect(await fs.readFile(path.join(dir, "world.md"), "utf8")).toContain("销毁证据");
    expect(outcome.interaction?.mode).toBe("decision");
  });

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
    for (const call of calls) {
      expect(call.args[call.args.indexOf("--provider") + 1]).toBe("newapi");
      expect(call.args).not.toContain("--thinking");
    }
    expect(calls[0].args[calls[0].args.length - 1]).toContain("雾中的废弃灯塔");
    const openingPrompt = calls[1].args[calls[1].args.length - 1];
    expect(openingPrompt).toContain("灯快熄了");
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
      { "turn/state-update.md": INIT_BUNDLE },
      { "turn/output.md": OUTPUT_MD, "turn/interaction.json": INTERACTION_JSON },
    ]);
    const runner = new PiRunner({ spawnFn: spawn });

    const result = await runner.runTurn({ ...turnRequest(meta.storyId, dir), task: "init" });

    expect(result.success).toBe(true);
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      const noExtensions = call.args.indexOf("--no-extensions");
      const extension = call.args.indexOf("--extension");
      expect(noExtensions).toBeGreaterThan(-1);
      expect(extension).toBeGreaterThan(-1);
      expect(call.args[extension + 1]).toBe(path.resolve(process.cwd(), "pi-extensions/write-boundary.ts"));
    }
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
        { "turn/state-update.md": INIT_BUNDLE },
        { "turn/output.md": OUTPUT_MD, "turn/interaction.json": INTERACTION_JSON },
      ]);
      const result = await new PiRunner({ spawnFn: spawn }).runTurn({ ...turnRequest(meta.storyId, dir), task: "init" });

      expect(result.success).toBe(true);
      expect(calls).toHaveLength(2);
      for (const call of calls) {
        const extension = call.args.indexOf("--extension");
        expect(call.args[extension + 1]).toBe(extensionPath);
      }
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

      const result = await runner.runTurn({ ...turnRequest(meta.storyId, dir), task: "init" });

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

  it("accepts one complete response, applies state and writes the server marker", async () => {
    const meta = await createStory();
    await appendTurnHistory(meta.storyId, {
      turnId: "t0",
      at: new Date().toISOString(),
      input: "开场",
      output: "# 主角视窗\n开场白",
    });
    const dir = resolveWorkspaceDir(meta.storyId);
    const candidate = {
      ...TURN_RESPONSE,
      stateUpdate: STATE_UPDATE_MD,
      interaction: { mode: "decision", suggestions: ["应和一句"] },
    };
    const { spawn, calls } = makeResponseSpawn([{ value: candidate }]);
    const result = await new PiRunner({ spawnFn: spawn }).runTurn(turnRequest(meta.storyId, dir));

    expect(result.success, result.detail).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toContain("--no-tools");
    expect(calls[0].args).toContain("--no-context-files");
    expect(calls[0].args).toContain("--extension");
    expect(calls[0].args[calls[0].args.indexOf("--extension") + 1]).toMatch(/json-response\.ts$/);
    expect(calls[0].args[calls[0].args.indexOf("--provider") + 1]).toBe("newapi-response");
    expect(calls[0].args[calls[0].args.indexOf("--thinking") + 1]).toBe("xhigh");
    expect(calls[0].args).not.toContain("--tools");
    expect(await fs.readFile(path.join(dir, "world.md"), "utf8")).toContain("雪夜客栈");
    await expect(fs.readFile(path.join(dir, "turn/done.json"), "utf8")).resolves.toContain("success");
    const modelsJson = JSON.parse(await fs.readFile(path.join(piHome, "agent", "models.json"), "utf8"));
    expect(modelsJson.providers.newapi.models[0].id).toBe("deepseek-v4.1-flash");
  });

  it("rejects prose, partial JSON, and a missing terminal response without committing", async () => {
    const meta = await createStory();
    const dir = resolveWorkspaceDir(meta.storyId);
    const worldBefore = await fs.readFile(path.join(dir, "world.md"), "utf8");
    const { spawn, calls } = makeResponseSpawn([
      { stdout: OUTPUT_MD },
      { stdout: '{"kind":"turn","output":"# 主角视窗"' },
    ]);
    process.env.PI_MAX_ATTEMPTS = "2";
    const result = await new PiRunner({ spawnFn: spawn }).runTurn(turnRequest(meta.storyId, dir));

    expect(result.success).toBe(false);
    expect(result.error).toContain("no turn response");
    expect(calls).toHaveLength(2);
    expect(await fs.readFile(path.join(dir, "world.md"), "utf8")).toBe(worldBefore);
    await expect(fs.access(path.join(dir, "turn/done.json"))).rejects.toThrow();
  });

  it("does not accept a complete response from a non-zero process", async () => {
    const meta = await createStory();
    const dir = resolveWorkspaceDir(meta.storyId);
    const { spawn } = makeResponseSpawn([{ value: TURN_RESPONSE, code: 1, stderr: "model failed" }]);
    const result = await new PiRunner({ spawnFn: spawn }).runTurn(turnRequest(meta.storyId, dir));

    expect(result.success).toBe(false);
    await expect(fs.access(path.join(dir, "turn/done.json"))).rejects.toThrow();
  });

  it("uses no-tools JSON mode and keeps the complete response in the final event", async () => {
    const meta = await createStory();
    const dir = resolveWorkspaceDir(meta.storyId);
    const { spawn, calls } = makeResponseSpawn([{ value: TURN_RESPONSE }]);
    await new PiRunner({ spawnFn: spawn }).runTurn(turnRequest(meta.storyId, dir));

    expect(calls[0].cmd).toBe("pi");
    expect(calls[0].args).toContain("-p");
    expect(calls[0].args).toContain("--no-session");
    expect(calls[0].args).toContain("--no-tools");
    expect(calls[0].args).toContain("--no-context-files");
    const modeIdx = calls[0].args.indexOf("--mode");
    expect(calls[0].args[modeIdx + 1]).toBe("json");
    expect(calls[0].args[calls[0].args.indexOf("--extension") + 1]).toMatch(/json-response\.ts$/);
    expect(calls[0].opts.cwd).toBe(dir);
  });

  it("rejects an unsolicited random declaration and keeps the workspace uncommitted", async () => {
    const meta = await createStory();
    const dir = resolveWorkspaceDir(meta.storyId);
    const candidate = {
      ...TURN_RESPONSE,
      stateUpdate: "=== RANDOM ===\nR1: rollId=first candidates=yes:1,no:1 → yes",
    };
    const { spawn } = makeResponseSpawn([{ value: candidate }]);
    const result = await new PiRunner({ spawnFn: spawn }).runTurn(turnRequest(meta.storyId, dir));

    expect(result.success).toBe(false);
    expect(result.detail).toContain("unsolicited");
    await expect(fs.access(path.join(dir, "logs/random-rolls.jsonl"))).rejects.toThrow();
    await expect(fs.access(path.join(dir, "turn/done.json"))).rejects.toThrow();
  });

  it("rejects a declaration that does not match the bound random outcome", async () => {
    const meta = await createStory();
    const dir = resolveWorkspaceDir(meta.storyId);
    const request = { kind: "roll-request", rolls: [{ rollId: "persuade", candidates: [{ id: "yes", weight: 50 }, { id: "no", weight: 50 }] }] };
    const candidate = {
      ...TURN_RESPONSE,
      stateUpdate: "=== RANDOM ===\nR1: rollId=persuade candidates=yes:50,no:50 → yes",
    };
    const { spawn } = makeResponseSpawn([{ value: request }, { value: candidate }]);
    const result = await new PiRunner({ spawnFn: spawn, rollRng: () => 0.9 }).runTurn(turnRequest(meta.storyId, dir));

    expect(result.success).toBe(false);
    expect(result.detail).toContain("mismatch");
    await expect(fs.access(path.join(dir, "logs/random-rolls.jsonl"))).rejects.toThrow();
    await expect(fs.access(path.join(dir, "turn/done.json"))).rejects.toThrow();
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
  beforeEach(() => { process.env.PI_UNCOMMITTED_PREVIEW = "1"; });
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

// --- 普通 turn 的旧磁盘产物隔离 ---

describe("PiRunner 普通 turn 响应隔离", () => {
  it("没有完整终止响应时拒绝旧磁盘产物，不把它们当本回合提交", async () => {
    const meta = await createStory();
    const dir = resolveWorkspaceDir(meta.storyId);
    const staleOutput = "# 主角视窗\n\n上一回合的旧叙事，不能冒充本回合结果。\n";
    await fs.writeFile(path.join(dir, "turn/output.md"), staleOutput);
    await fs.writeFile(path.join(dir, "turn/interaction.json"), INTERACTION_JSON);
    await fs.writeFile(path.join(dir, "turn/state-update.md"), STATE_UPDATE_MD);
    const worldBefore = await fs.readFile(path.join(dir, "world.md"), "utf8");
    const { spawn } = makeResponseSpawn([{ stdout: "口述小说，没有 message_end" }]);

    const result = await new PiRunner({ spawnFn: spawn }).runTurn(turnRequest(meta.storyId, dir));

    expect(result.success).toBe(false);
    expect(await fs.readFile(path.join(dir, "turn/output.md"), "utf8")).toBe(staleOutput);
    expect(await fs.readFile(path.join(dir, "world.md"), "utf8")).toBe(worldBefore);
    await expect(fs.access(path.join(dir, "turn/done.json"))).rejects.toThrow();
  });
});
