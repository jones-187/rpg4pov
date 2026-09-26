import { NextResponse } from "next/server";
import { isValidStoryId, getStory, workspaceExists } from "@/lib/workspace";
import { TurnBusyError } from "@/lib/turn-orchestrator";
import { orchestrator } from "@/lib/runner-selection";

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }

  const rawStoryId = (body as { storyId?: unknown }).storyId;
  const storyId = typeof rawStoryId === "string" ? rawStoryId.trim() : "";
  if (!isValidStoryId(storyId)) {
    return NextResponse.json({ error: "invalid storyId" }, { status: 400 });
  }

  const rawInput = (body as { input?: unknown }).input;
  const input = typeof rawInput === "string" ? rawInput.trim() : "";
  // Issue 10：系统级"继续"命令——不需要主角输入。
  // 若同时提供了 input，则按普通回合处理（不静默丢弃玩家输入）。
  const rawCommand = (body as { command?: unknown }).command;
  const isContinue = rawCommand === "continue" && !input;
  const isRetry = rawCommand === "retry" && !input;
  const rawCorrection = (body as { correction?: unknown }).correction;
  if (isRetry && rawCorrection !== undefined && typeof rawCorrection !== "string") {
    return NextResponse.json({ error: "correction must be a string" }, { status: 400 });
  }
  const correction = typeof rawCorrection === "string" ? rawCorrection.trim() : undefined;
  if (correction && correction.length > 2000) {
    return NextResponse.json({ error: "correction is too long" }, { status: 400 });
  }
  if (!input && !isContinue && !isRetry) {
    return NextResponse.json({ error: "input is required" }, { status: 400 });
  }

  if (!(await workspaceExists(storyId))) {
    return NextResponse.json({ error: "story not found" }, { status: 404 });
  }

  // Issue 7：状态机守卫——create → init → turn。未初始化的故事拒绝回合。
  // 守卫在 route 层而非 orchestrator：orchestrator 保持通用 agent 执行机制。
  const story = await getStory(storyId);
  if (!story?.initialized) {
    return NextResponse.json({ error: "故事尚未初始化，请先完成初始化" }, { status: 400 });
  }

  // Issue 4：串行锁拒绝 → 409（无 retryInput，用户输入还在前端输入框）。
  // 回合失败 → 500 + retryInput（回填输入框供重试）。
  // 用户只看固定中文提示，内部 error 分类只进 logs/turn-errors.log（US 42）。
  try {
    const outcome = isRetry
      ? await orchestrator.retryLatestTurn(storyId, correction)
      : await orchestrator.executeTurn(storyId, input, {
          systemCommand: isContinue ? "continue" : undefined,
        });
    if (!outcome.success || !outcome.playerResponse) {
      if (isRetry && outcome.error === "latest turn is not retryable") {
        return NextResponse.json({ error: "当前没有可重写的最新回合" }, { status: 409 });
      }
      return NextResponse.json(
        isRetry
          ? { error: "重写失败，原回合已保留" }
          : { error: "回合执行失败，请重试", retryInput: input },
        { status: 500 },
      );
    }
    return NextResponse.json({
      playerResponse: outcome.playerResponse,
      turn: outcome.turn, // Issue 6.5: 返回 committed entry
      interaction: outcome.interaction, // Issue 10: 净化后的交互状态
      replaced: isRetry,
    });
  } catch (e) {
    if (e instanceof TurnBusyError) {
      return NextResponse.json(
        { error: "故事正在执行，请稍候" },
        { status: 409 },
      );
    }
    // 非 TurnBusyError 的意外异常：重写不回填输入，普通回合回填原输入。
    return NextResponse.json(
      isRetry
        ? { error: "重写失败，原回合已保留" }
        : { error: "回合执行失败，请重试", retryInput: input },
      { status: 500 },
    );
  }
}
