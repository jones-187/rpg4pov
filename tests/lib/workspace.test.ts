import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  createStory,
  listStories,
  getStory,
  workspaceExists,
  isValidStoryId,
  readTurnOutput,
  writeTurnInput,
  writeTurnOutput,
  resolveWorkspaceRoot,
} from "@/lib/workspace";
import { useTempWorkspaceRoot, resetWorkspaceRoot } from "../helpers/workspace-env";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let root: string;
beforeAll(async () => {
  root = await useTempWorkspaceRoot();
});
afterAll(() => resetWorkspaceRoot());

describe("isValidStoryId", () => {
  it("accepts a UUID v4", () => {
    expect(isValidStoryId("11111111-1111-4111-8111-111111111111")).toBe(true);
  });
  it("rejects path traversal and non-uuid", () => {
    expect(isValidStoryId("..")).toBe(false);
    expect(isValidStoryId("a/b")).toBe(false);
    expect(isValidStoryId("not-a-uuid")).toBe(false);
    expect(isValidStoryId("")).toBe(false);
  });
});

describe("createStory", () => {
  it("returns meta with uuid id, normalized title and ISO createdAt", async () => {
    const meta = await createStory({ title: "  酒馆之夜  " });
    expect(UUID_RE.test(meta.storyId)).toBe(true);
    expect(meta.title).toBe("酒馆之夜");
    expect(() => new Date(meta.createdAt).toISOString()).not.toThrow();
    expect(new Date(meta.createdAt).toString()).not.toBe("Invalid Date");
  });

  it("defaults title to 未命名故事", async () => {
    const meta = await createStory();
    expect(meta.title).toBe("未命名故事");
  });

  it("scaffolds all expected files (no empty dirs)", async () => {
    const meta = await createStory({ title: "骨架测试" });
    const dir = path.join(root, meta.storyId);
    const expected = [
      "story.md",
      "rules.md",
      "world.md",
      "player.md",
      "actors/.gitkeep",
      "logs/.gitkeep",
      "turn/input.md",
      "turn/output.md",
    ];
    for (const rel of expected) {
      await expect(fs.access(path.join(dir, rel))).resolves.toBeUndefined();
    }
  });

  it("writes id/title/createdAt into story.md front matter", async () => {
    const meta = await createStory({ title: "元数据测试" });
    const raw = await fs.readFile(path.join(root, meta.storyId, "story.md"), "utf8");
    expect(raw).toContain(`id: ${meta.storyId}`);
    expect(raw).toContain(`title: ${meta.title}`);
    expect(raw).toContain(`createdAt: ${meta.createdAt}`);
  });
});

describe("listStories", () => {
  it("lists created stories, newest first", async () => {
    await createStory({ title: "列表A" });
    const b = await createStory({ title: "列表B" });
    const list = await listStories();
    expect(list.length).toBeGreaterThanOrEqual(2);
    expect(list[0].storyId).toBe(b.storyId); // newest first
    for (const m of list) expect(UUID_RE.test(m.storyId)).toBe(true);
  });

  it("returns [] when root is empty", async () => {
    const before = await listStories();
    expect(before.length).toBeGreaterThan(0); // 共享 tmpdir，此时非空
    // 隔离验证：指向一个空根
    process.env.WORKSPACE_ROOT = path.join(root, "does-not-exist");
    expect(await listStories()).toEqual([]);
    process.env.WORKSPACE_ROOT = root;
  });
});

describe("getStory / workspaceExists", () => {
  it("returns meta for existing, null for unknown/invalid", async () => {
    const meta = await createStory({ title: "查询测试" });
    expect(await getStory(meta.storyId)).toEqual(meta);
    expect(await getStory("00000000-0000-4000-8000-000000000000")).toBeNull();
    expect(await getStory("../etc")).toBeNull();
  });
  it("workspaceExists mirrors getStory", async () => {
    const meta = await createStory();
    expect(await workspaceExists(meta.storyId)).toBe(true);
    expect(await workspaceExists("00000000-0000-4000-8000-000000000000")).toBe(false);
    expect(await workspaceExists("../etc")).toBe(false);
  });
});

describe("turn input/output files", () => {
  it("writes input and output, reads output back", async () => {
    const meta = await createStory();
    await writeTurnInput(meta.storyId, "推开木门");
    await writeTurnOutput(meta.storyId, "主角视窗内容");
    const out = await readTurnOutput(meta.storyId);
    expect(out).toBe("主角视窗内容");
    const inputRaw = await fs.readFile(
      path.join(root, meta.storyId, "turn", "input.md"),
      "utf8",
    );
    expect(inputRaw).toContain("推开木门");
  });
  it("readTurnOutput returns null for unknown story", async () => {
    expect(await readTurnOutput("00000000-0000-4000-8000-000000000000")).toBeNull();
  });
});

describe("resolveWorkspaceRoot", () => {
  it("resolves WORKSPACE_ROOT when set", () => {
    expect(resolveWorkspaceRoot()).toBe(path.resolve(root));
  });
});
