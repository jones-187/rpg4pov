// tests/api/stories/[storyId].test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { GET } from "@/app/api/stories/[storyId]/route";
import { createStory } from "@/lib/workspace";
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
});