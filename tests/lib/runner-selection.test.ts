import { describe, it, expect, afterEach, vi } from "vitest";
import { resolveRunner } from "@/lib/runner-selection";
import { PiRunner } from "@/lib/pi-runner";
import { ClaudeCodeRunner } from "@/lib/claude-code-runner";
import { FakeAgentRunner } from "@/lib/fake-agent-runner";
import type { TurnRequest } from "@/lib/agent-runner";

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.AGENT_RUNNER;
  delete process.env.PUBLIC_CONTINUITY_CARD;
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
  it("AGENT_RUNNER=pi：init 与 turn 都由同一个 PiRunner 执行，默认不开公开连续性卡片", async () => {
    process.env.AGENT_RUNNER = "pi";
    const piSpy = vi.spyOn(PiRunner.prototype, "runTurn").mockResolvedValue({ success: true });

    const runner = resolveRunner();
    expect(runner).toBeInstanceOf(PiRunner);
    await runner.runTurn(req("turn"));
    await runner.runTurn(req("init"));

    expect(piSpy).toHaveBeenCalledTimes(2);
    expect(piSpy.mock.instances[0]).toBe(piSpy.mock.instances[1]);
    expect((piSpy.mock.instances[0] as unknown as { publicContinuityCard?: boolean }).publicContinuityCard).toBe(false);
  });

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

  it("PUBLIC_CONTINUITY_CARD=1 只为 Pi runner 开启实验功能", async () => {
    process.env.AGENT_RUNNER = "pi";
    process.env.PUBLIC_CONTINUITY_CARD = "1";
    const piSpy = vi.spyOn(PiRunner.prototype, "runTurn").mockResolvedValue({ success: true });
    await resolveRunner().runTurn(req("turn"));
    expect((piSpy.mock.instances[0] as unknown as { publicContinuityCard?: boolean }).publicContinuityCard).toBe(true);

    process.env.AGENT_RUNNER = "claude";
    const claudeSpy = vi
      .spyOn(ClaudeCodeRunner.prototype, "runTurn")
      .mockResolvedValue({ success: true });
    await resolveRunner().runTurn(req("turn"));
    await resolveRunner().runTurn(req("init"));
    expect((piSpy.mock.instances[1] as unknown as { publicContinuityCard?: boolean }).publicContinuityCard).toBe(true);
    expect(claudeSpy).toHaveBeenCalledTimes(1);
  });
});
