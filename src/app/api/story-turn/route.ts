import { NextResponse } from "next/server";
import {
  isValidStoryId,
  workspaceExists,
  writeTurnInput,
  writeTurnOutput,
  readTurnOutput,
} from "@/lib/workspace";

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
  if (!input) {
    return NextResponse.json({ error: "input is required" }, { status: 400 });
  }

  if (!(await workspaceExists(storyId))) {
    return NextResponse.json({ error: "story not found" }, { status: 404 });
  }

  // Issue 2：仍为占位回合。
  // 关键不变量：Web 只从 turn/output.md 读取主角可见输出，
  // 不读 agent stdout / logs / world / player / actors。
  // Issue 3 起将替换 output.md 的写入者（fake agent），读取路径保持不变。
  await writeTurnInput(storyId, input);
  const placeholder = `(占位回合 · tracer bullet)\n\n主角视窗：${input}\n\n（这是占位响应，尚未接入故事引擎。）`;
  await writeTurnOutput(storyId, placeholder);
  const playerResponse = await readTurnOutput(storyId);

  if (!playerResponse) {
    return NextResponse.json({ error: "output unavailable" }, { status: 500 });
  }
  return NextResponse.json({ playerResponse });
}
