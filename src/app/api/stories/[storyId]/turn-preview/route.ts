import { NextResponse } from "next/server";
import { readTurnProgress } from "@/lib/turn-progress";

/**
 * 回合进行时预览（叙事先行显示）。GET /api/stories/{storyId}/turn-preview
 *
 * 前端在回合 pending 期间轮询：narrative-ready 后即可先显示叙事正文，
 * interaction-ready 后可先显示交互建议——早于 POST 返回（后者要等
 * state-update 合并/随机落账/提交校验全部完成）。
 *
 * 数据只是提前读的预览，不是权威：POST 响应里的 committed turn 才是；
 * 回合最终失败/回滚时预览由前端撤回（phase 回退为 generating 亦同）。
 * 回合结束（或无进行中回合）返回 { active: false }。
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ storyId: string }> },
) {
  const { storyId } = await params;
  const progress = readTurnProgress(storyId);
  if (!progress) {
    return NextResponse.json({ active: false });
  }
  return NextResponse.json({ ...progress, active: true });
}
