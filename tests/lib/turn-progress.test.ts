import { describe, it, expect } from "vitest";
import {
  beginTurnAttempt,
  publishTurnProgress,
  readTurnProgress,
  clearTurnProgress,
} from "@/lib/turn-progress";

describe("TurnProgress 注册表（叙事先行显示通道）", () => {
  it("发布与读取：narrative-ready 携带叙事原文", () => {
    publishTurnProgress("prog-1", {
      phase: "narrative-ready",
      narrative: "# 主角视窗\n\n正文",
    });
    const p = readTurnProgress("prog-1");
    expect(p).not.toBeNull();
    expect(p!.phase).toBe("narrative-ready");
    expect(p!.narrative).toContain("正文");
    expect(p!.updatedAt).toBeGreaterThan(0);
    clearTurnProgress("prog-1");
    expect(readTurnProgress("prog-1")).toBeNull();
  });

  it("后续相位保留先前产物：interaction-ready 不丢 narrative", () => {
    publishTurnProgress("prog-2", { phase: "narrative-ready", narrative: "N" });
    publishTurnProgress("prog-2", {
      phase: "interaction-ready",
      interaction: { mode: "continue", suggestions: [] },
    });
    const p = readTurnProgress("prog-2")!;
    expect(p.phase).toBe("interaction-ready");
    expect(p.narrative).toBe("N");
    expect(p.interaction?.mode).toBe("continue");
    clearTurnProgress("prog-2");
  });

  it("phase 回退 generating 清空产物预览（重试撤回信号）", () => {
    publishTurnProgress("prog-3", { phase: "narrative-ready", narrative: "N" });
    publishTurnProgress("prog-3", {
      phase: "interaction-ready",
      interaction: { mode: "continue", suggestions: [] },
    });
    publishTurnProgress("prog-3", { phase: "generating" });
    const p = readTurnProgress("prog-3")!;
    expect(p.phase).toBe("generating");
    expect(p.narrative).toBeUndefined();
    expect(p.interaction).toBeUndefined();
    clearTurnProgress("prog-3");
  });

  it("无进行中回合返回 null", () => {
    expect(readTurnProgress("prog-none")).toBeNull();
  });

  it("迟到发布防御：旧 attempt 令牌的发布被丢弃（撤回不可推翻、终局后无僵尸预览）", () => {
    const t1 = beginTurnAttempt("prog-4");
    publishTurnProgress("prog-4", { phase: "narrative-ready", narrative: "N1" }, t1);
    expect(readTurnProgress("prog-4")?.narrative).toBe("N1");

    // attempt 2 重开：令牌推进 + 预览撤回
    const t2 = beginTurnAttempt("prog-4");
    expect(readTurnProgress("prog-4")?.phase).toBe("generating");
    expect(readTurnProgress("prog-4")?.narrative).toBeUndefined();

    // attempt 1 的迟到发布（泄密守卫读盘期间跨越了重试）：丢弃
    publishTurnProgress("prog-4", { phase: "narrative-ready", narrative: "STALE" }, t1);
    expect(readTurnProgress("prog-4")?.narrative).toBeUndefined();

    // attempt 2 正常发布
    publishTurnProgress("prog-4", { phase: "narrative-ready", narrative: "N2" }, t2);
    expect(readTurnProgress("prog-4")?.narrative).toBe("N2");

    // 终局清空后，迟到的旧发布不落成僵尸预览（下一回合首次轮询读到 null）
    clearTurnProgress("prog-4");
    publishTurnProgress("prog-4", { phase: "narrative-ready", narrative: "GHOST" }, t2);
    expect(readTurnProgress("prog-4")).toBeNull();
    clearTurnProgress("prog-4");
  });
});
