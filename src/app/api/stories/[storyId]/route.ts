import { NextResponse } from "next/server";
import { getStory } from "@/lib/workspace";
import { readTurnHistory } from "@/lib/turn-history";
import { readTurnInteraction } from "@/lib/turn-interaction";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ storyId: string }> },
) {
  const { storyId } = await params;
  const meta = await getStory(storyId);
  if (!meta) {
    return NextResponse.json({ error: "story not found" }, { status: 404 });
  }

  const history = await readTurnHistory(storyId);
  // Issue 10：刷新后恢复当前 continue/decision 状态与建议（净化后的受控版本）。
  const interaction = await readTurnInteraction(storyId);
  return NextResponse.json({
    story: meta,
    history: history ?? [],
    interaction,
  });
}
