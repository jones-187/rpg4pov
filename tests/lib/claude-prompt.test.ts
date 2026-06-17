import { describe, it, expect } from "vitest";
import { buildPrompt, STORY_TURN_RUNNER_PROMPT_TEMPLATE } from "@/lib/claude-prompt";

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
