import { describe, it, expect } from "vitest";
import { buildPrompt, STORY_TURN_RUNNER_PROMPT_TEMPLATE } from "@/lib/claude-prompt";

describe("claude-prompt", () => {
  it("STORY_TURN_RUNNER_PROMPT_TEMPLATE 含任务、工作流程、约束三段", () => {
    expect(STORY_TURN_RUNNER_PROMPT_TEMPLATE).toContain("## 任务");
    expect(STORY_TURN_RUNNER_PROMPT_TEMPLATE).toContain("## 工作流程");
    expect(STORY_TURN_RUNNER_PROMPT_TEMPLATE).toContain("## 约束");
  });

  it("buildPrompt 把 playerInput 填入 prompt", () => {
    const prompt = buildPrompt("推开木门");
    expect(prompt).toContain("推开木门");
    expect(prompt).toContain("## 任务");
  });

  it("prompt 含输出隔离约束（不泄漏 God State/NPC 记忆/日志）", () => {
    const prompt = buildPrompt("test");
    expect(prompt).toContain("不得泄漏");
    expect(prompt.toLowerCase()).toContain("god state");
    expect(prompt).toContain("NPC 私有记忆");
  });

  it("prompt 含随机工具 heredoc 调用说明", () => {
    const prompt = buildPrompt("test");
    expect(prompt).toContain("node /app/cli/roll-choice.js");
    expect(prompt).toContain("<<'JSON'");
  });

  it("prompt 含 done.json 写入说明（status=success）", () => {
    const prompt = buildPrompt("test");
    expect(prompt).toContain("turn/done.json");
    expect(prompt).toContain("status");
    expect(prompt).toContain("success");
  });
});
