import { describe, it, expect, afterEach, vi } from "vitest";
import { resolveRunner } from "@/lib/runner-selection";
import { PiRunner } from "@/lib/pi-runner";
import { ClaudeCodeRunner } from "@/lib/claude-code-runner";
import { FakeAgentRunner } from "@/lib/fake-agent-runner";
import type { TurnRequest } from "@/lib/agent-runner";

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.AGENT_RUNNER;
});

function req(task?: "turn" | "init"): TurnRequest {
  return {
    storyId: "00000000-0000-4000-8000-000000000000",
    workspaceDir: "/tmp/unused",
    playerInput: "输入",
    task,
    signal: AbortSignal.timeout(1000),
  };
}

describe("resolveRunner task 分发（性能优化分支）", () => {
  it("AGENT_RUNNER=claude：turn 走 PiRunner，init 走 ClaudeCodeRunner", async () => {
    process.env.AGENT_RUNNER = "claude";
    const piSpy = vi.spyOn(PiRunner.prototype, "runTurn").mockResolvedValue({ success: true });
    const claudeSpy = vi
      .spyOn(ClaudeCodeRunner.prototype, "runTurn")
      .mockResolvedValue({ success: true });

    const runner = resolveRunner();
    await runner.runTurn(req("turn"));
    await runner.runTurn(req("init"));

    expect(piSpy).toHaveBeenCalledTimes(1);
    expect(claudeSpy).toHaveBeenCalledTimes(1);
  });

  it("默认（未设置）返回 FakeAgentRunner", () => {
    const runner = resolveRunner();
    expect(runner).toBeInstanceOf(FakeAgentRunner);
  });
});
