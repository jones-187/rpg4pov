import { describe, it, expect } from "vitest";
import {
  buildPrompt,
  buildInitPrompt,
  STORY_TURN_RUNNER_PROMPT_TEMPLATE,
  STORY_INIT_RUNNER_PROMPT_TEMPLATE,
} from "@/lib/claude-prompt";

describe("claude-prompt", () => {
  it("STORY_TURN_RUNNER_PROMPT_TEMPLATE contains task/workflow/constraints sections", () => {
    expect(STORY_TURN_RUNNER_PROMPT_TEMPLATE).toContain("## 任务");
    expect(STORY_TURN_RUNNER_PROMPT_TEMPLATE).toContain("## 工作流程");
    expect(STORY_TURN_RUNNER_PROMPT_TEMPLATE).toContain("## 约束");
  });

  it("buildPrompt fills playerInput into prompt", () => {
    const prompt = buildPrompt("推开木门");
    expect(prompt).toContain("推开木门");
    expect(prompt).toContain("## 任务");
  });

  it("prompt contains output isolation constraints (no God State/NPC memory/logs leak)", () => {
    const prompt = buildPrompt("test");
    expect(prompt).toContain("不得泄漏");
    expect(prompt.toLowerCase()).toContain("god state");
    expect(prompt).toContain("NPC 私有记忆");
  });

  it("prompt contains heredoc random tool invocation", () => {
    const prompt = buildPrompt("test");
    expect(prompt).toContain("node /app/cli/roll-choice.js");
    expect(prompt).toContain("<<'JSON'");
  });

  it("prompt contains done.json write instruction (status=success)", () => {
    const prompt = buildPrompt("test");
    expect(prompt).toContain("turn/done.json");
    expect(prompt).toContain("status");
    expect(prompt).toContain("success");
  });

  it("buildPrompt handles $ special characters in playerInput", () => {
    const prompt = buildPrompt("$&");
    expect(prompt).toContain("$&");
    expect(prompt).not.toContain("{PLAYER_INPUT}");
  });

  // --- Issue 9：output.md 首行标题契约（orchestrator 强制校验） ---

  it("turn prompt requires output.md first line to be 「# 主角视窗」", () => {
    const prompt = buildPrompt("test");
    expect(prompt).toContain("# 主角视窗");
    expect(prompt).toContain("第一行");
  });
});

describe("claude-prompt: story init (Issue 7)", () => {
  it("STORY_INIT_RUNNER_PROMPT_TEMPLATE contains task/workflow/constraints sections", () => {
    expect(STORY_INIT_RUNNER_PROMPT_TEMPLATE).toContain("## 任务");
    expect(STORY_INIT_RUNNER_PROMPT_TEMPLATE).toContain("## 工作流程");
    expect(STORY_INIT_RUNNER_PROMPT_TEMPLATE).toContain("## 约束");
    expect(STORY_INIT_RUNNER_PROMPT_TEMPLATE).toContain("初始化");
  });

  it("buildInitPrompt fills setting into prompt", () => {
    const prompt = buildInitPrompt("深夜的边境酒馆，主角是一名逃亡的炼金术士");
    expect(prompt).toContain("深夜的边境酒馆，主角是一名逃亡的炼金术士");
    expect(prompt).not.toContain("{PLAYER_INPUT}");
  });

  it("init prompt treats user setting as canon (US 53 / Decision 54)", () => {
    const prompt = buildInitPrompt("test");
    expect(prompt).toContain("canon");
    expect(prompt).toContain("原文保留");
  });

  it("init prompt covers required conceptual documents", () => {
    const prompt = buildInitPrompt("test");
    expect(prompt).toContain("world.md");
    expect(prompt).toContain("player.md");
    expect(prompt).toContain("rules.md");
    expect(prompt).toContain("actors/*.md");
    expect(prompt).toContain("turn/output.md");
  });

  it("init prompt keeps small-scene scale (3-5 NPCs, limited locations)", () => {
    const prompt = buildInitPrompt("test");
    expect(prompt).toContain("3-5");
    expect(prompt).toContain("小场景");
  });

  it("init prompt forbids modifying story.md and history.jsonl", () => {
    const prompt = buildInitPrompt("test");
    expect(prompt).toContain("不得修改 story.md、turns/history.jsonl");
    expect(prompt).toContain("DO NOT");
  });

  it("init prompt requires done.json and no extra files", () => {
    const prompt = buildInitPrompt("test");
    expect(prompt).toContain("turn/done.json");
    expect(prompt).toContain("status=success");
    expect(prompt).toContain("不得创建其他文件");
  });

  it("init prompt has output isolation constraints like turn prompt", () => {
    const prompt = buildInitPrompt("test");
    expect(prompt).toContain("不得泄漏");
    expect(prompt).toContain("God State");
    expect(prompt).toContain("NPC 私有记忆");
  });

  it("buildInitPrompt handles $ special characters in setting", () => {
    const prompt = buildInitPrompt("$&");
    expect(prompt).toContain("$&");
    expect(prompt).not.toContain("{PLAYER_INPUT}");
  });

  // --- Issue 9：output.md 首行标题契约（orchestrator 强制校验） ---

  it("init prompt requires opening output.md first line to be 「# 主角视窗」", () => {
    const prompt = buildInitPrompt("test");
    expect(prompt).toContain("# 主角视窗");
    expect(prompt).toContain("第一行");
  });
});

// --- Issue 8：Narrative Turn Contract（有效变化 / 角色意图 / 表演） ---

describe("claude-prompt: Narrative Turn Contract (Issue 8)", () => {
  it("requires deciding meaningful change before writing prose", () => {
    const prompt = buildPrompt("test");
    expect(prompt).toContain("有效变化");
    expect(prompt).toContain("写正文前先内部确定");
  });

  it("documents non-change criteria (复述/平级细化/纯氛围不算推进)", () => {
    const prompt = buildPrompt("test");
    expect(prompt).toContain("不算有效变化");
    expect(prompt).toContain("平级细化");
    expect(prompt).toContain("慢不等于不推进");
  });

  it("requires Character Intent fields on NPC cards", () => {
    const prompt = buildPrompt("test");
    expect(prompt).toContain("currentEmotion");
    expect(prompt).toContain("immediateGoal");
    expect(prompt).toContain("hiddenIntent");
    expect(prompt).toContain("voice");
    expect(prompt).toContain("actors/*.md");
  });

  it("requires NPCs to act proactively, not just respond", () => {
    const prompt = buildPrompt("test");
    expect(prompt).toContain("NPC 必须主动");
    expect(prompt).toContain("等待玩家推进");
  });

  it("requires subtext-first performance and bans generic AI lines", () => {
    const prompt = buildPrompt("test");
    expect(prompt).toContain("潜台词");
    expect(prompt).toContain("我理解你的感受");
  });

  it("requires respondable turn endings", () => {
    const prompt = buildPrompt("test");
    expect(prompt).toContain("可回应");
    expect(prompt).toContain("纯环境描写");
  });
});

// --- Issue 9：Adaptive Authored Protagonist Runtime ---

describe("claude-prompt: protagonist runtime (Issue 9)", () => {
  it("requires stable first-person voice and concrete inner monologue", () => {
    const prompt = buildPrompt("test");
    expect(prompt).toContain("Protagonist Core");
    expect(prompt).toContain("第一人称");
    expect(prompt).toContain("内心独白");
  });

  it("bans long-stay vague emotion expressions", () => {
    const prompt = buildPrompt("test");
    expect(prompt).toContain("说不上来的感觉");
    expect(prompt).toContain("莫名的情绪");
  });

  it("documents the control boundary (auto vs must-not)", () => {
    const prompt = buildPrompt("test");
    expect(prompt).toContain("系统可以自动处理");
    expect(prompt).toContain("系统不得自行增加");
    expect(prompt).toContain("不可逆行动");
    expect(prompt).toContain("玩家本回合明确输入永远覆盖系统自动表现");
  });
});

// --- Issue 9.5：Feedback & Adaptation ---

describe("claude-prompt: feedback & adaptation (Issue 9.5)", () => {
  it("distinguishes one-off correction from long-term adjustment", () => {
    const prompt = buildPrompt("test");
    expect(prompt).toContain("本次纠正");
    expect(prompt).toContain("长期偏好");
    expect(prompt).toContain("adjustments.md");
  });

  it("requires evidence + confidence on inferred tendencies, no single-occasion upgrade", () => {
    const prompt = buildPrompt("test");
    expect(prompt).toContain("tendencies.md");
    expect(prompt).toContain("evidence");
    expect(prompt).toContain("confidence");
    expect(prompt).toContain("单次行为不得升级为稳定人格");
  });

  it("documents generation priority order", () => {
    const prompt = buildPrompt("test");
    expect(prompt).toContain("玩家本回合明确输入 → adjustments.md");
    expect(prompt).toContain("系统默认");
  });
});

// --- Issue 10：Decision Points & Input Guidance ---

describe("claude-prompt: decision points & input guidance (Issue 10)", () => {
  it("instructs writing turn/interaction.json with mode and suggestions", () => {
    const prompt = buildPrompt("test");
    expect(prompt).toContain("turn/interaction.json");
    expect(prompt).toContain("continue");
    expect(prompt).toContain("decision");
    expect(prompt).toContain("suggestions");
  });

  it("defines continue as system-level control, not protagonist action", () => {
    const prompt = buildPrompt("test");
    expect(prompt).toContain("【系统指令·继续】");
    expect(prompt).toContain("不是主角台词或行动");
  });

  it("documents the suggestion gate (0-4, no filler suggestions)", () => {
    const prompt = buildPrompt("test");
    expect(prompt).toContain("建议门槛");
    expect(prompt).toContain("0-4");
    expect(prompt).toContain("不为凑数生成");
    expect(prompt).toContain("继续观察");
  });

  it("forbids internal metadata in interaction.json", () => {
    const prompt = buildPrompt("test");
    expect(prompt).toContain("只允许包含 mode 和 suggestions 两个字段");
  });
});

// --- Issue 8/9 init 材料要求 ---

describe("claude-prompt: init materials for Issues 8/9", () => {
  it("init prompt requires Protagonist Core fields", () => {
    const prompt = buildInitPrompt("test");
    expect(prompt).toContain("narrativeVoice");
    expect(prompt).toContain("speechPatterns");
    expect(prompt).toContain("avoidExpressions");
    expect(prompt).toContain("agency boundaries");
  });

  it("init prompt seeds NPC intent blocks and dramatic pressure", () => {
    const prompt = buildInitPrompt("test");
    expect(prompt).toContain("currentEmotion");
    expect(prompt).toContain("hiddenIntent");
    expect(prompt).toContain("矛盾、秘密、风险或压力源");
  });

  it("init prompt forbids pre-written scripts/routes/endings", () => {
    const prompt = buildInitPrompt("test");
    expect(prompt).toContain("不预写固定剧本、章节大纲、角色路线或结局");
  });

  it("init prompt writes opening interaction state", () => {
    const prompt = buildInitPrompt("test");
    expect(prompt).toContain("turn/interaction.json");
  });

  it("init prompt does not touch adjustments/tendencies", () => {
    const prompt = buildInitPrompt("test");
    expect(prompt).toContain("不得修改 story.md、turns/history.jsonl、adjustments.md、tendencies.md");
  });
});
