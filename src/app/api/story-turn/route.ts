import { NextResponse } from "next/server";

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);

  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }

  const rawInput = (body as { input?: unknown }).input;
  const input =
    typeof rawInput === "string" ? rawInput.trim() : "";

  if (!input) {
    return NextResponse.json({ error: "input is required" }, { status: 400 });
  }

  // tracer-bullet 占位：尚未接入 Story Workspace / agent runtime。
  // 后续 issue 会替换为 adapter 调用并只返回固定 player-visible 输出。
  const playerResponse = `(占位回合 · tracer bullet)\n\n主角视窗：${input}\n\n（这是占位响应，尚未接入故事引擎。）`;

  return NextResponse.json({ playerResponse });
}
