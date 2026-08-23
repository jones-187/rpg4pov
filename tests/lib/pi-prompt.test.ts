import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  buildInitUserPrompt,
  buildTurnUserPrompt,
  PI_INIT_SYSTEM_PROMPT,
  PI_TURN_SYSTEM_PROMPT,
  resolveHistoryLimit,
  resolveActorBudgetBytes,
} from "@/lib/pi-prompt";
import { buildPiModelsJson, ensurePiConfig, resolvePiAgentDir } from "@/lib/pi-config";
import { createStory, resolveWorkspaceDir } from "@/lib/workspace";
import { appendTurnHistory } from "@/lib/turn-history";
import { useTempWorkspaceRoot, resetWorkspaceRoot } from "../helpers/workspace-env";

beforeEach(async () => {
  await useTempWorkspaceRoot();
});
afterEach(() => resetWorkspaceRoot());

describe("PI_TURN_SYSTEM_PROMPT", () => {
  it("契约要素齐备：三文件写盘、红线、继续指令、首行标题", () => {
    expect(PI_TURN_SYSTEM_PROMPT).toContain("turn/output.md");
    expect(PI_TURN_SYSTEM_PROMPT).toContain("turn/interaction.json");
    expect(PI_TURN_SYSTEM_PROMPT).toContain("turn/state-update.md");
    expect(PI_TURN_SYSTEM_PROMPT).toContain("# 主角视窗");
    expect(PI_TURN_SYSTEM_PROMPT).toContain("【系统指令·继续】");
    expect(PI_TURN_SYSTEM_PROMPT).toContain("禁止读取文件");
    expect(PI_TURN_SYSTEM_PROMPT).toContain("禁止修改 story.md");
  });

  it("随机判定契约：按序消耗、服从、RANDOM 申报、禁自造随机数", () => {
    expect(PI_TURN_SYSTEM_PROMPT).toContain("随机数池");
    expect(PI_TURN_SYSTEM_PROMPT).toContain("=== RANDOM ===");
    expect(PI_TURN_SYSTEM_PROMPT).toContain("R1: rollId=lockpick");
    expect(PI_TURN_SYSTEM_PROMPT).toContain("必须服从");
    expect(PI_TURN_SYSTEM_PROMPT).toContain("禁止自造随机数");
  });
});

describe("PI_INIT_SYSTEM_PROMPT", () => {
  it("保留初始化产品契约与三产物协议", () => {
    for (const marker of [
      "canon",
      "3-5",
      "Protagonist Core",
      "Player Agency",
      "Emotional Core",
      "Relationship State",
      "coreNeed",
      "coreFear",
      "surfaceRelationship",
      "recentEvidence",
      "Emotionally Salient Memories",
      "event、meaning、impact",
      "Current Intent",
      "emotionalTrigger",
      "emotionalConflict",
      "restraint",
      "# 主角视窗",
      "不要预写固定剧情",
      "输出隔离",
      "turn/output.md",
      "turn/interaction.json",
      "turn/state-update.md",
      "=== FILE: actors/name.md ===",
      "禁止写 story.md",
      "不要写 done.json",
    ]) {
      expect(PI_INIT_SYSTEM_PROMPT).toContain(marker);
    }
    expect(PI_INIT_SYSTEM_PROMPT).not.toContain("随机数池");
  });

  it("用户 canon 与骨架完整注入，初始化不带随机池", async () => {
    const meta = await createStory();
    const prompt = await buildInitUserPrompt(
      resolveWorkspaceDir(meta.storyId),
      "雾中灯塔，主角是守塔学徒，使用第三人称限知视角",
    );
    expect(prompt).toContain("雾中灯塔，主角是守塔学徒，使用第三人称限知视角");
    expect(prompt).toContain("=== story.md ===");
    expect(prompt).toContain("=== world.md ===");
    expect(prompt).toContain("=== player.md ===");
    expect(prompt).toContain("=== rules.md ===");
    expect(prompt).not.toContain("R1=");
    expect(prompt).not.toContain("=== 随机数池");
  });
});

describe("buildTurnUserPrompt", () => {
  it("预注入全部状态段 + 玩家输入 + 角色卡", async () => {
    const meta = await createStory();
    const dir = resolveWorkspaceDir(meta.storyId);
    await fs.writeFile(path.join(dir, "actors", "lin.md"), "# NPC：林掌柜\nvoice：反问");

    const prompt = await buildTurnUserPrompt(dir, meta.storyId, "我下楼吃面");

    expect(prompt).toContain("=== rules.md ===");
    expect(prompt).toContain("=== world.md ===");
    expect(prompt).toContain("=== player.md ===");
    expect(prompt).toContain("=== adjustments.md ===");
    expect(prompt).toContain("=== tendencies.md ===");
    expect(prompt).toContain("=== actors/lin.md ===");
    expect(prompt).toContain("# NPC：林掌柜");
    expect(prompt).toContain("我下楼吃面");
  });

  it("注入顺序按变化频率升序：rules → world → actors → history → 输入 → 随机池（前缀缓存友好）", async () => {
    const meta = await createStory();
    const dir = resolveWorkspaceDir(meta.storyId);
    await fs.writeFile(path.join(dir, "actors", "lin.md"), "# NPC：林掌柜\n");
    await appendTurnHistory(meta.storyId, {
      turnId: "t1",
      at: new Date().toISOString(),
      input: "开场",
      output: "# 主角视窗\n开场白",
    });

    const prompt = await buildTurnUserPrompt(dir, meta.storyId, "我推门", [0.5]);

    const pos = (marker: string) => prompt.indexOf(marker);
    expect(pos("=== rules.md ===")).toBeLessThan(pos("=== adjustments.md ==="));
    expect(pos("=== adjustments.md ===")).toBeLessThan(pos("=== tendencies.md ==="));
    expect(pos("=== tendencies.md ===")).toBeLessThan(pos("=== player.md ==="));
    expect(pos("=== player.md ===")).toBeLessThan(pos("=== world.md ==="));
    expect(pos("=== world.md ===")).toBeLessThan(pos("=== actors/lin.md ==="));
    expect(pos("=== actors/lin.md ===")).toBeLessThan(pos("=== turns/history.jsonl"));
    expect(pos("=== turns/history.jsonl")).toBeLessThan(pos("我推门"));
    expect(pos("我推门")).toBeLessThan(pos("=== 随机数池"));
  });

  it("角色卡超预算 → 注入瘦身附加指令；未超 → 无该段", async () => {
    const meta = await createStory();
    const dir = resolveWorkspaceDir(meta.storyId);
    await fs.writeFile(path.join(dir, "actors", "slim.md"), "# NPC：小卡\n");
    await fs.writeFile(path.join(dir, "actors", "fat.md"), `${"# NPC：大卡\n证据行。".repeat(400)}\n`);

    const prompt = await buildTurnUserPrompt(dir, meta.storyId, "我推门");

    expect(prompt).toContain("=== 本回合附加指令 ===");
    expect(prompt).toContain("actors/fat.md 已超出精简预算");
    expect(prompt).toContain("REPLACE 修剪");
    expect(prompt).not.toContain("actors/slim.md 已超出精简预算");
  });

  it("history 只取最近 N 条（默认 5）", async () => {
    const meta = await createStory();
    const dir = resolveWorkspaceDir(meta.storyId);
    for (let i = 1; i <= 8; i++) {
      await appendTurnHistory(meta.storyId, {
        turnId: `t${i}`,
        at: new Date().toISOString(),
        input: `输入${i}`,
        output: `# 主角视窗\n输出${i}`,
      });
    }
    const prompt = await buildTurnUserPrompt(dir, meta.storyId, "继续");
    const limit = resolveHistoryLimit();
    expect(prompt).toContain("最近 5 条");
    expect(prompt).toContain("输出8");
    expect(prompt).toContain("输出4");
    expect(prompt).not.toContain("输出3");
  });

  it("随机数池注入在最末（玩家输入之后），逐号展开 6 位小数", async () => {
    const meta = await createStory();
    const dir = resolveWorkspaceDir(meta.storyId);
    const prompt = await buildTurnUserPrompt(dir, meta.storyId, "我推门", [0.734211, 0.1]);

    const inputIdx = prompt.indexOf("本回合玩家输入");
    const poolIdx = prompt.indexOf("=== 随机数池");
    expect(poolIdx).toBeGreaterThan(inputIdx);
    expect(prompt).toContain("R1=0.734211");
    expect(prompt).toContain("R2=0.100000");
    expect(prompt.indexOf("按 system 提示执行本回合")).toBeGreaterThan(poolIdx);
  });

  it("rollPool 缺省为空：不注入随机数池段", async () => {
    const meta = await createStory();
    const dir = resolveWorkspaceDir(meta.storyId);
    const prompt = await buildTurnUserPrompt(dir, meta.storyId, "我推门");
    expect(prompt).not.toContain("随机数池");
  });

  it("resolveActorBudgetBytes：默认 6144，env 可调且带夹取", () => {
    const saved = process.env.PI_ACTOR_BUDGET_BYTES;
    try {
      expect(resolveActorBudgetBytes()).toBe(6144);
      process.env.PI_ACTOR_BUDGET_BYTES = "999";
      expect(resolveActorBudgetBytes()).toBe(2048); // 下夹取
      process.env.PI_ACTOR_BUDGET_BYTES = "99999999";
      expect(resolveActorBudgetBytes()).toBe(65536); // 上夹取
      process.env.PI_ACTOR_BUDGET_BYTES = "8192";
      expect(resolveActorBudgetBytes()).toBe(8192);
    } finally {
      if (saved === undefined) delete process.env.PI_ACTOR_BUDGET_BYTES;
      else process.env.PI_ACTOR_BUDGET_BYTES = saved;
    }
  });
});

describe("pi-config", () => {
  it("models.json 从环境推导且幂等", async () => {
    const home = await fs.mkdtemp(path.join(process.env.TMPDIR || "/tmp", "pi-cfg-"));
    const saved = {
      PI_HOME: process.env.PI_HOME,
      BASE: process.env.ANTHROPIC_BASE_URL,
      TOKEN: process.env.ANTHROPIC_AUTH_TOKEN,
    };
    process.env.PI_HOME = home;
    process.env.ANTHROPIC_BASE_URL = "http://gw.test:3030/";
    process.env.ANTHROPIC_AUTH_TOKEN = "unit-test-token";

    try {
      const json = buildPiModelsJson();
      const parsed = JSON.parse(json);
      expect(parsed.providers.newapi.baseUrl).toBe("http://gw.test:3030/v1");
      expect(parsed.providers.newapi.api).toBe("openai-completions");
      expect(parsed.providers.newapi.models[0].id).toBe("qwen-fp8");
      expect(parsed.providers.newapi.models[0].reasoning).toBe(false);

      const file = await ensurePiConfig();
      expect(file).toBe(path.join(resolvePiAgentDir(), "models.json"));
      const first = await fs.readFile(file, "utf8");
      await ensurePiConfig(); // 幂等：内容一致不重写
      const second = await fs.readFile(file, "utf8");
      expect(first).toBe(second);
    } finally {
      process.env.PI_HOME = saved.PI_HOME;
      process.env.ANTHROPIC_BASE_URL = saved.BASE;
      process.env.ANTHROPIC_AUTH_TOKEN = saved.TOKEN;
    }
  });
});
