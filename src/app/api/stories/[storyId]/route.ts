import { NextResponse } from "next/server";
import { getStory } from "@/lib/workspace";
import { readTurnHistory } from "@/lib/turn-history";

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
  return NextResponse.json({
    story: meta,
    history: history ?? [],
  });
}
