import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  buildInitUserPrompt,
  buildInitConceptsUserPrompt,
  buildInitOpeningUserPrompt,
  buildTurnUserPrompt,
  PI_INIT_CONCEPTS_SYSTEM_PROMPT,
  PI_INIT_OPENING_SYSTEM_PROMPT,
  PI_INIT_SYSTEM_PROMPT,
  PI_TURN_SYSTEM_PROMPT,
  resolveHistoryLimit,
  resolveActorBudgetBytes,
} from "@/lib/pi-prompt";
import {
  buildPiModelsJson,
  ensurePiConfig,
  resolvePiAgentDir,
  resolvePiModel,
} from "@/lib/pi-config";
import { createStory, resolveWorkspaceDir } from "@/lib/workspace";
import { appendTurnHistory } from "@/lib/turn-history";
import { parseFactLedger } from "@/lib/fact-ledger";
import { useTempWorkspaceRoot, resetWorkspaceRoot } from "../helpers/workspace-env";

beforeEach(async () => {
  await useTempWorkspaceRoot();
});
afterEach(() => resetWorkspaceRoot());

describe("PI_TURN_SYSTEM_PROMPT", () => {
  it("契约要求完整 JSON 响应、红线与继续指令，不要求模型写盘", () => {
    expect(PI_TURN_SYSTEM_PROMPT).toContain("kind");
    expect(PI_TURN_SYSTEM_PROMPT).toContain("stateUpdate");
    expect(PI_TURN_SYSTEM_PROMPT).toContain("# 主角视窗");
    expect(PI_TURN_SYSTEM_PROMPT).toContain("【系统指令·继续】");
    expect(PI_TURN_SYSTEM_PROMPT).toContain("不能读取或写入文件");
    expect(PI_TURN_SYSTEM_PROMPT).toContain("禁止修改 story.md");
    expect(PI_TURN_SYSTEM_PROMPT).not.toContain("turn/output.md");
    expect(PI_TURN_SYSTEM_PROMPT).not.toContain("turn/interaction.json");
    expect(PI_TURN_SYSTEM_PROMPT).not.toContain("turn/state-update.md");
  });

  it("随机判定契约：先请求候选、绑定后服从、结构化随机结果、禁自造随机数", () => {
    expect(PI_TURN_SYSTEM_PROMPT).toContain("roll-request");
    expect(PI_TURN_SYSTEM_PROMPT).toContain("服务端绑定随机结果");
    expect(PI_TURN_SYSTEM_PROMPT).toContain("不得再次请求随机");
    expect(PI_TURN_SYSTEM_PROMPT).toContain("必须服从");
    expect(PI_TURN_SYSTEM_PROMPT).toContain("禁止自造随机数");
    expect(PI_TURN_SYSTEM_PROMPT).toContain('"sections"');
    expect(PI_TURN_SYSTEM_PROMPT).toContain('"rolls"');
    expect(PI_TURN_SYSTEM_PROMPT).toContain('"kind":"replace"');
    expect(PI_TURN_SYSTEM_PROMPT).toContain('"from"');
    expect(PI_TURN_SYSTEM_PROMPT).toContain('"id":"success","weight":25');
    expect(PI_TURN_SYSTEM_PROMPT).toContain('"id":"fail","weight":75');
    expect(PI_TURN_SYSTEM_PROMPT).not.toContain("=== RANDOM ===");
    expect(PI_TURN_SYSTEM_PROMPT).not.toContain("R1: rollId=");
  });

  it("禁止凭空用期限或默认后果替玩家完成重大决定", () => {
    expect(PI_TURN_SYSTEM_PROMPT).toContain(
      "不得凭空新增截止时间、默认同意或拒绝、逾期自动失去选项",
    );
    expect(PI_TURN_SYSTEM_PROMPT).toContain("暂不决定仍是未决定");
  });

  it("状态文件路径必须逐字复用上下文标题，禁止按角色显示名重建", () => {
    expect(PI_TURN_SYSTEM_PROMPT).toContain("file 必须逐字复制上下文中已有的文件标题");
    expect(PI_TURN_SYSTEM_PROMPT).toContain("禁止翻译、改名或按角色显示名重建路径");
    expect(PI_TURN_SYSTEM_PROMPT).toContain('"file":"actors/existing-file.md"');
    expect(PI_TURN_SYSTEM_PROMPT).not.toContain('"file":"actors/姓名.md"');
  });
});

describe("PI_INIT_SYSTEM_PROMPT", () => {
  it("保留初始化产品契约与三产物协议", () => {
    for (const marker of [
      "canon",
      "3-5",
      "有限地点",
      "有限时间跨度",
      "氛围",
      "隐藏事实",
      "God State",
      "矛盾、秘密、风险或压力",
      "初始状态",
      "主角已知信息",
      "Protagonist Core",
      "Player Agency",
      "判定风格",
      "随机权重约定",
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
      "表面形象",
      "私有记忆/动机",
      "禁用表达",
      "基本动机",
      "不做 NPC↔NPC 关系图",
      "初始 0-2 条",
      "模型内部的人物行为约束",
      "不是小说正文",
      "恋爱/后宫/修罗场",
      "后续经历逐渐获得",
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

  it("明确隔离玩家历史与服务端标记文件", () => {
    expect(PI_INIT_SYSTEM_PROMPT).toContain("turns/**（包括 turns/history.jsonl）");
    expect(PI_INIT_SYSTEM_PROMPT).toContain("不要写 done.json");
    expect(PI_INIT_SYSTEM_PROMPT).toContain("其他文件");
  });

  it("初始化 output 的首行契约同时写明首行和标题", () => {
    const outputInstruction = PI_INIT_SYSTEM_PROMPT
      .split("\n")
      .find((line) => line.includes("turn/output.md"));
    expect(outputInstruction).toBeDefined();
    expect(outputInstruction).toContain("首行");
    expect(outputInstruction).toContain("# 主角视窗");
  });

  it("buildInitUserPrompt 原样保留 canon 中的 $&", async () => {
    const meta = await createStory();
    const canon = "保留字面量 $&，不要将它当作替换模板。";
    const prompt = await buildInitUserPrompt(resolveWorkspaceDir(meta.storyId), canon);
    expect(prompt).toContain(canon);
  });

  it("Phase 1 只要求完整 Bundle 候选，不要求 output/interaction", () => {
    expect(PI_INIT_CONCEPTS_SYSTEM_PROMPT).toContain("Phase 1");
    expect(PI_INIT_CONCEPTS_SYSTEM_PROMPT).toContain("turn/state-update.md");
    expect(PI_INIT_CONCEPTS_SYSTEM_PROMPT).toContain("不能写 turn/output.md");
    expect(PI_INIT_CONCEPTS_SYSTEM_PROMPT).toContain("不能写 turn/interaction.json");
    expect(PI_INIT_CONCEPTS_SYSTEM_PROMPT).toContain("Emotionally Salient Memories");
  });

  it("Phase 2 opening prompt 只面向主角可见信息和 actor 表面/voice", async () => {
    const meta = await createStory();
    const dir = resolveWorkspaceDir(meta.storyId);
    await fs.writeFile(
      path.join(dir, "player.md"),
      "# 主角\n\n## 初始状态\n站在门口。\n\n## Public Scene\n{\"time\":\"第一天清晨\",\"location\":\"灯塔门口\",\"narrativeVoice\":\"第一人称限知\",\"knownFacts\":[\"灯快熄了\"],\"visibleActors\":[{\"name\":\"守塔人\",\"appearance\":\"穿旧雨衣\",\"voice\":\"短句，少解释\"}]}\n\n## 主角已知信息\n灯快熄了。\n\n## Protagonist Core\n声音克制。\n\n## Player Agency\n重大决定交还玩家。\n\n## 用户设定\n原始秘密设定不应注入。",
    );
    await fs.writeFile(
      path.join(dir, "world.md"),
      "# 世界\n\nGod State：地下有会唱歌的钥匙。",
    );
    await fs.writeFile(
      path.join(dir, "actors", "keeper.md"),
      "# 守塔人\n\n## 表面形象\n穿旧雨衣。\n\n## voice\n短句，少解释。\n\n## 私有记忆\n他记得主角的秘密。\n\n## Emotional Core\ncoreNeed: 被需要。\n\n## Relationship State: 主角\nsurfaceRelationship: 学徒。\n\n## Current Intent\nhiddenIntent: 试探。",
    );

    const prompt = await buildInitOpeningUserPrompt(dir);
    expect(prompt).toContain("第一天清晨");
    expect(prompt).toContain("灯快熄了");
    expect(prompt).toContain("守塔人");
    expect(prompt).toContain("穿旧雨衣");
    expect(prompt).toContain("短句，少解释");
    expect(prompt).not.toContain("站在门口");
    expect(prompt).not.toContain("声音克制");
    expect(prompt).not.toContain("重大决定交还玩家");
    expect(prompt).not.toContain("原始秘密设定不应注入");
    expect(prompt).not.toContain("God State");
    expect(prompt).not.toContain("地下有会唱歌的钥匙");
    expect(prompt).not.toContain("他记得主角的秘密");
    expect(prompt).not.toContain("hiddenIntent");
    expect(prompt).not.toContain("试探");
  });

  it("opening context uses Public Scene voice instead of private Current Intent voice", async () => {
    const meta = await createStory();
    const dir = resolveWorkspaceDir(meta.storyId);
    await fs.writeFile(
      path.join(dir, "player.md"),
      "# 主角\n\n## Public Scene\n{\"time\":\"第一天清晨\",\"location\":\"灯塔门口\",\"narrativeVoice\":\"第一人称限知\",\"knownFacts\":[],\"visibleActors\":[{\"name\":\"守塔人\",\"appearance\":\"旧雨衣\",\"voice\":\"公开短句\"}]}",
    );
    await fs.writeFile(
      path.join(dir, "actors", "keeper.md"),
      "# 守塔人\n\n## 表面形象\n穿旧雨衣。\n\n## Current Intent\n- voice: 私有短句，答一半。\n- hiddenIntent: 试探主角是否知道地下秘密。\n- privateMemory: 他曾在雾里失踪。",
    );

    const prompt = await buildInitOpeningUserPrompt(dir);
    expect(prompt).toContain("公开短句");
    expect(prompt).not.toContain("私有短句，答一半");
    expect(prompt).not.toContain("试探主角是否知道地下秘密");
    expect(prompt).not.toContain("他曾在雾里失踪");
  });

  it("Phase 2 system prompt 只允许 output/interaction，禁止 state-update", () => {
    expect(PI_INIT_OPENING_SYSTEM_PROMPT).toContain("Phase 2");
    expect(PI_INIT_OPENING_SYSTEM_PROMPT).toContain("turn/output.md");
    expect(PI_INIT_OPENING_SYSTEM_PROMPT).toContain("turn/interaction.json");
    expect(PI_INIT_OPENING_SYSTEM_PROMPT).toContain("不能写 turn/state-update.md");
    expect(PI_INIT_OPENING_SYSTEM_PROMPT).not.toContain("=== FILE: world.md ===");
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

  it("注入顺序按变化频率升序且不提前暴露随机样本", async () => {
    const meta = await createStory();
    const dir = resolveWorkspaceDir(meta.storyId);
    await fs.writeFile(path.join(dir, "actors", "lin.md"), "# NPC：林掌柜\n");
    await appendTurnHistory(meta.storyId, {
      turnId: "t1",
      at: new Date().toISOString(),
      input: "开场",
      output: "# 主角视窗\n开场白",
    });

    const prompt = await buildTurnUserPrompt(dir, meta.storyId, "我推门");

    const pos = (marker: string) => prompt.indexOf(marker);
    expect(pos("=== rules.md ===")).toBeLessThan(pos("=== adjustments.md ==="));
    expect(pos("=== adjustments.md ===")).toBeLessThan(pos("=== tendencies.md ==="));
    expect(pos("=== tendencies.md ===")).toBeLessThan(pos("=== player.md ==="));
    expect(pos("=== player.md ===")).toBeLessThan(pos("=== world.md ==="));
    expect(pos("=== world.md ===")).toBeLessThan(pos("=== actors/lin.md ==="));
    expect(pos("=== actors/lin.md ===")).toBeLessThan(pos("=== turns/history.jsonl"));
    expect(pos("=== turns/history.jsonl")).toBeLessThan(pos("我推门"));
    expect(prompt).not.toContain("=== 随机数池");
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

  it("无账本时 prompt 保持现状，不出现账本段", async () => {
    const meta = await createStory();
    const dir = resolveWorkspaceDir(meta.storyId);
    const baseline = await buildTurnUserPrompt(dir, meta.storyId, "我推门");
    const explicitNoLedger = await buildTurnUserPrompt(dir, meta.storyId, "我推门", undefined);
    expect(explicitNoLedger).toBe(baseline);
    expect(baseline).not.toContain("=== 权威薄事实账本（只读） ===");
  });

  it("有账本时在历史之后、本轮输入之前注入只读事实段", async () => {
    const meta = await createStory();
    const dir = resolveWorkspaceDir(meta.storyId);
    const ledger = parseFactLedger({
      version: "1",
      events: [
        {
          id: "public-e1",
          text: "北门在第三夜上锁。",
          source: "system",
          time: "第三夜",
          location: "北门",
          witnesses: ["主角", "闻策"],
          visibility: "public",
          causedBy: [],
        },
        {
          id: "secret-e1",
          text: "主角独自知道北门暗格里有半张海图。",
          source: "player",
          time: "第三夜",
          location: "北门暗格",
          witnesses: ["主角"],
          visibility: "private",
          causedBy: [],
        },
        {
          id: "derived-e1",
          text: "闻策没有看见主角打开暗格。",
          source: "system",
          time: "第三夜",
          location: "北门暗格",
          witnesses: [],
          visibility: "public",
          causedBy: ["secret-e1"],
        },
      ],
    });
    const prompt = await buildTurnUserPrompt(dir, meta.storyId, "我推门", ledger);
    const history = prompt.indexOf("=== turns/history.jsonl");
    const fact = prompt.indexOf("=== 权威薄事实账本（只读） ===");
    const input = prompt.indexOf("=== 本回合玩家输入（turn/input.md）===");
    expect(history).toBeLessThan(fact);
    expect(fact).toBeLessThan(input);
    expect(prompt).toContain("id=public-e1");
    expect(prompt).toContain("text=北门在第三夜上锁。");
    expect(prompt).toContain("location=北门");
    expect(prompt).toContain("witnesses=主角 | 闻策");
    expect(prompt).toContain("visibility=public");
    expect(prompt).toContain("知识边界=");
    expect(prompt).toContain("仅以下角色掌握未公开事实：主角；");
    expect(prompt).not.toContain("secret-e1");
    expect(prompt).not.toContain("derived-e1");
    expect(prompt).not.toContain("北门暗格");
    expect(prompt).not.toContain("半张海图");
    expect(prompt).not.toContain("闻策没有看见");
    expect(prompt).toContain("它不替代人物动机、语气、自由叙事或玩家选择");
    expect(prompt).toContain("不得改写账本");
    expect(prompt).toContain("未明确给出的截止日期、名额/稀缺性、默认后果、不可逆影响均视为未知");
    expect(prompt).toContain("玩家未明确决定的重大选择必须保持未决");
  });

  it("玩家上下文不暴露随机数或允许预选结果", async () => {
    const meta = await createStory();
    const dir = resolveWorkspaceDir(meta.storyId);
    const prompt = await buildTurnUserPrompt(dir, meta.storyId, "我推门");
    expect(prompt).not.toContain("R1=");
    expect(prompt).not.toContain("随机数池");
    expect(PI_TURN_SYSTEM_PROMPT).toContain("收到完整候选之后才抽样");
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
  it("拒绝 deepseek-v4.1-flash 之外的模型配置", () => {
    const saved = process.env.ANTHROPIC_MODEL;
    process.env.ANTHROPIC_MODEL = "another-model";
    try {
      expect(() => resolvePiModel()).toThrow(/requires deepseek-v4\.1-flash/);
    } finally {
      if (saved === undefined) delete process.env.ANTHROPIC_MODEL;
      else process.env.ANTHROPIC_MODEL = saved;
    }
  });

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
      expect(parsed.providers.newapi.models[0].id).toBe("deepseek-v4.1-flash");
      expect(parsed.providers.newapi.models[0].reasoning).toBe(false);
      const response = parsed.providers["newapi-response"];
      expect(response.baseUrl).toBe(parsed.providers.newapi.baseUrl);
      expect(response.apiKey).toBe(parsed.providers.newapi.apiKey);
      expect(response.models[0]).toMatchObject({
        id: "deepseek-v4.1-flash", reasoning: true,
        compat: { thinkingFormat: "deepseek", supportsDeveloperRole: false },
      });
      expect(parsed.providers.newapi.models[0].compat.thinkingFormat).toBe("deepseek");

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
