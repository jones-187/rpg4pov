import { NextResponse } from "next/server";
import { isValidStoryId, workspaceExists } from "@/lib/workspace";
import { TurnOrchestrator } from "@/lib/turn-orchestrator";
import { FakeAgentRunner } from "@/lib/fake-agent-runner";

// 模块级单例：runner 在应用生命周期内不变
const orchestrator = new TurnOrchestrator(new FakeAgentRunner());

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

  // Issue 3：通过 TurnOrchestrator + FakeAgentRunner 执行回合。
  // 关键不变量：Web 只从 turn/output.md 读取主角可见输出，
  // 不读 agent stdout / logs / world / player / actors。
  // 失败时返回受控响应，不让 route 直接 500 崩溃。
  // timeout / snapshot / rollback 留给 Issue 4。
  const outcome = await orchestrator.executeTurn(storyId, input);
  if (!outcome.success || !outcome.playerResponse) {
    return NextResponse.json(
      { error: "回合执行失败，请重试" },
      { status: 500 },
    );
  }
  return NextResponse.json({ playerResponse: outcome.playerResponse });
}
