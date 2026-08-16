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
});
