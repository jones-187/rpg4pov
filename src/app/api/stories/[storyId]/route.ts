import { NextResponse } from "next/server";
import { getStory } from "@/lib/workspace";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ storyId: string }> },
) {
  const { storyId } = await params;
  const meta = await getStory(storyId);
  if (!meta) {
    return NextResponse.json({ error: "story not found" }, { status: 404 });
  }
  return NextResponse.json(meta);
}
