import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { POST as createStory, GET as listStories } from "@/app/api/stories/route";
import { GET as getStory } from "@/app/api/stories/[storyId]/route";
import { useTempWorkspaceRoot, resetWorkspaceRoot } from "../helpers/workspace-env";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

beforeAll(async () => {
  await useTempWorkspaceRoot();
});
afterAll(() => resetWorkspaceRoot());

function req(url: string, method: string, body?: unknown): Request {
  return new Request(url, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe("POST /api/stories", () => {
  it("creates a story with given title → 201", async () => {
    const res = await createStory(req("http://localhost/api/stories", "POST", { title: "酒馆之夜" }));
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(UUID_RE.test(json.storyId)).toBe(true);
    expect(json.title).toBe("酒馆之夜");
    expect(typeof json.createdAt).toBe("string");
  });

  it("defaults to 未命名故事 when title missing/blank", async () => {
    const res = await createStory(req("http://localhost/api/stories", "POST", { title: "   " }));
    expect(res.status).toBe(201);
    expect((await res.json()).title).toBe("未命名故事");
  });

  it("creates with default title when body absent", async () => {
    const res = await createStory(req("http://localhost/api/stories", "POST"));
    expect(res.status).toBe(201);
    expect((await res.json()).title).toBe("未命名故事");
  });
});

describe("GET /api/stories", () => {
  it("returns { stories: [...] } newest first", async () => {
    const res = await listStories();
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(Array.isArray(json.stories)).toBe(true);
    if (json.stories.length >= 2) {
      expect(json.stories[0].createdAt >= json.stories[1].createdAt).toBe(true);
    }
  });
});

describe("GET /api/stories/{id}", () => {
  it("returns 200 meta for existing story", async () => {
    const created = await createStory(req("http://localhost/api/stories", "POST", { title: "查询" }));
    const meta = await created.json();
    const res = await getStory(
      req(`http://localhost/api/stories/${meta.storyId}`, "GET"),
      { params: Promise.resolve({ storyId: meta.storyId }) },
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.storyId).toBe(meta.storyId);
    expect(json.title).toBe("查询");
  });

  it("returns 404 for unknown valid-format id", async () => {
    const id = "00000000-0000-4000-8000-000000000000";
    const res = await getStory(req(`http://localhost/api/stories/${id}`, "GET"), {
      params: Promise.resolve({ storyId: id }),
    });
    expect(res.status).toBe(404);
  });

  it("returns 404 for invalid id", async () => {
    const res = await getStory(req("http://localhost/api/stories/../etc", "GET"), {
      params: Promise.resolve({ storyId: "../etc" }),
    });
    expect(res.status).toBe(404);
  });
});
