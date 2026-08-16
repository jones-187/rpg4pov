// tests/api/stories/[storyId].test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { GET } from "@/app/api/stories/[storyId]/route";
import { createStory, markStoryInitialized, resolveWorkspaceRoot } from "@/lib/workspace";
import { appendTurnHistory, type TurnHistoryEntry } from "@/lib/turn-history";
import { useTempWorkspaceRoot, resetWorkspaceRoot } from "../../helpers/workspace-env";

beforeAll(async () => {
  await useTempWorkspaceRoot();
});
afterAll(() => resetWorkspaceRoot());

function makeRequest(storyId: string): Request {
  return new Request(`http://localhost/api/stories/${storyId}`);
}

describe("GET /api/stories/[storyId]", () => {
  it("returns story meta without history when no turns", async () => {
    const meta = await createStory({ title: "空故事" });
    const res = await GET(makeRequest(meta.storyId), {
      params: Promise.resolve({ storyId: meta.storyId }),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.story).toBeDefined();
    expect(json.story.storyId).toBe(meta.storyId);
    expect(json.story.title).toBe("空故事");
    expect(json.history).toEqual([]);
    // Issue 7：新建故事未初始化，前端据此显示初始化表单
    expect(json.story.initialized).toBe(false);
  });

  it("returns initialized=true after markStoryInitialized (Issue 7)", async () => {
    const meta = await createStory({ title: "已初始化故事" });
    await markStoryInitialized(meta.storyId);
    const res = await GET(makeRequest(meta.storyId), {
      params: Promise.resolve({ storyId: meta.storyId }),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.story.initialized).toBe(true);
  });

  it("returns story meta with history entries", async () => {
    const meta = await createStory({ title: "有历史故事" });
    await appendTurnHistory(meta.storyId, {
      turnId: "turn-1",
      at: "2026-06-18T00:00:00.000Z",
      input: "推开木门",
      output: "你推开木门。",
    });
    await appendTurnHistory(meta.storyId, {
      turnId: "turn-2",
      at: "2026-06-18T00:01:00.000Z",
      input: "走进房间",
      output: "你走进房间。",
    });

    const res = await GET(makeRequest(meta.storyId), {
      params: Promise.resolve({ storyId: meta.storyId }),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.story.storyId).toBe(meta.storyId);
    expect(json.history).toHaveLength(2);
    expect(json.history[0].input).toBe("推开木门");
    expect(json.history[1].input).toBe("走进房间");
  });

  it("returns 404 for non-existent story", async () => {
    const res = await GET(
      makeRequest("00000000-0000-4000-8000-000000000000"),
      { params: Promise.resolve({ storyId: "00000000-0000-4000-8000-000000000000" }) },
    );
    expect(res.status).toBe(404);
  });

  // --- Issue 9：GET 只返回 meta + history，隐藏文件内容不外泄 ---

  it("does not return world/actors/logs content (God State / NPC memory / random log)", async () => {
    const meta = await createStory({ title: "隔离测试" });
    const wsDir = path.join(resolveWorkspaceRoot(), meta.storyId);
    // 在隐藏文件中放入哨兵内容
    await fs.writeFile(path.join(wsDir, "world.md"), "# 世界\n\nGOD-SECRET-隐藏事实：幕后黑手是店主。");
    await fs.writeFile(path.join(wsDir, "actors", "npc.md"), "# NPC\n\nNPC-MEMORY-SECRET：她认得凶手的脸。");
    await fs.writeFile(
      path.join(wsDir, "logs", "random-rolls.jsonl"),
      JSON.stringify({ rollId: "ROLL-SECRET-luck", selectedId: "fail" }) + "\n",
    );
    await appendTurnHistory(meta.storyId, {
      turnId: "turn-1",
      at: "2026-08-16T00:00:00.000Z",
      input: "环顾四周",
      output: "# 主角视窗\n\n你环顾四周，一切安静。",
    });

    const res = await GET(makeRequest(meta.storyId), {
      params: Promise.resolve({ storyId: meta.storyId }),
    });
    expect(res.status).toBe(200);
    const raw = JSON.stringify(await res.json());
    // 玩家可见内容在，隐藏内容不在
    expect(raw).toContain("你环顾四周，一切安静。");
    expect(raw).not.toContain("GOD-SECRET");
    expect(raw).not.toContain("NPC-MEMORY-SECRET");
    expect(raw).not.toContain("ROLL-SECRET");
  });
});
