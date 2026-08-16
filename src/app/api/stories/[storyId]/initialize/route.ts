import { NextResponse } from "next/server";
import { getStory } from "@/lib/workspace";
import { TurnBusyError } from "@/lib/turn-orchestrator";
import { orchestrator } from "@/lib/runner-selection";

/**
 * 初始化故事（Issue 7）。POST /api/stories/{storyId}/initialize
 * body: { setting: string }——用户自然语言小场景设定（可含主角/NPC 角色卡）。
 *
 * 走 orchestrator.executeTurn({ task: "init" })：同一把锁/快照/回滚机制，
 * init 与 turn 互斥串行。成功响应与 POST /api/story-turn 同形
 * （{ playerResponse, turn }），前端复用同一渲染路径——开场视窗即第一条 history entry。
 *
 * 状态机：未初始化才可 init；已初始化 → 409；失败可原 storyId 重试（回滚回占位骨架）。
 * 409 预检查在锁外——并发 initialize 的竞态窗口由 orchestrator 锁内复查兜底
 * （后到者收到可重试失败，重试时命中这里的 409）。
 * 用户只看固定中文提示，内部 error 分类只进 logs/turn-errors.log。
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ storyId: string }> },
) {
  const { storyId } = await params;

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }

  const rawSetting = (body as { setting?: unknown }).setting;
  const setting = typeof rawSetting === "string" ? rawSetting.trim() : "";
  if (!setting) {
    return NextResponse.json({ error: "设定不能为空" }, { status: 400 });
  }

  const story = await getStory(storyId);
  if (!story) {
    return NextResponse.json({ error: "story not found" }, { status: 404 });
  }
  if (story.initialized) {
    return NextResponse.json({ error: "故事已初始化" }, { status: 409 });
  }

  try {
    const outcome = await orchestrator.executeTurn(storyId, setting, { task: "init" });
    if (!outcome.success || !outcome.playerResponse) {
      return NextResponse.json(
        { error: "初始化失败，请重试", retryInput: setting },
        { status: 500 },
      );
    }
    return NextResponse.json({
      playerResponse: outcome.playerResponse,
      turn: outcome.turn,
    });
  } catch (e) {
    if (e instanceof TurnBusyError) {
      return NextResponse.json(
        { error: "故事正在执行，请稍候" },
        { status: 409 },
      );
    }
    return NextResponse.json(
      { error: "初始化失败，请重试", retryInput: setting },
      { status: 500 },
    );
  }
}
