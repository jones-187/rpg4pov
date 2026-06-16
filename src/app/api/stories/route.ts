import { NextResponse } from "next/server";
import { createStory, listStories } from "@/lib/workspace";

// 创建故事。无必填字段：body 缺失或无 title 时创建「未命名故事」。
export async function POST(request: Request) {
  let title: string | undefined;
  try {
    const body = await request.json();
    if (body && typeof body === "object") {
      const t = (body as { title?: unknown }).title;
      title = typeof t === "string" ? t : undefined;
    }
  } catch {
    // body 非 JSON：按无标题处理，仍允许创建。
  }
  const meta = await createStory({ title });
  return NextResponse.json(meta, { status: 201 });
}

export async function GET() {
  const stories = await listStories();
  return NextResponse.json({ stories });
}
