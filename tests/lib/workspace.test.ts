import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  createStory,
  listStories,
  getStory,
  workspaceExists,
  isValidStoryId,
  markStoryInitialized,
  readTurnOutput,
  readRandomRollLines,
  readTurnDone,
  clearTurnDone,
  writeTurnInput,
  resolveWorkspaceDir,
  resolveWorkspaceRoot,
  resolveSnapshotsRoot,
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

  it("creates turns/history.jsonl (empty file)", async () => {
    const meta = await createStory({ title: "history 初始化测试" });
    const historyPath = path.join(root, meta.storyId, "turns", "history.jsonl");
    await expect(fs.access(historyPath)).resolves.toBeUndefined();
    const content = await fs.readFile(historyPath, "utf8");
    expect(content).toBe("");
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

describe("markStoryInitialized (Issue 7)", () => {
  it("new story is not initialized", async () => {
    const meta = await createStory();
    expect(meta.initialized).toBe(false);
    expect((await getStory(meta.storyId))?.initialized).toBe(false);
  });

  it("flips initialized to true and is visible via getStory", async () => {
    const meta = await createStory({ title: "初始化标记" });
    await markStoryInitialized(meta.storyId);
    const after = await getStory(meta.storyId);
    expect(after?.initialized).toBe(true);
    // 原有 meta 字段不丢
    expect(after?.storyId).toBe(meta.storyId);
    expect(after?.title).toBe("初始化标记");
    expect(after?.createdAt).toBe(meta.createdAt);
  });

  it("writes initialized/initializedAt into frontmatter and preserves body", async () => {
    const meta = await createStory({ title: "正文保留" });
    await markStoryInitialized(meta.storyId);
    const raw = await fs.readFile(path.join(root, meta.storyId, "story.md"), "utf8");
    expect(raw).toContain("initialized: true");
    expect(raw).toMatch(/^initializedAt: \d{4}-\d{2}-\d{2}T/m);
    // frontmatter 原键保留、正文占位保留
    expect(raw).toContain(`id: ${meta.storyId}`);
    expect(raw).toContain("title: 正文保留");
    expect(raw).toContain("# 故事");
    expect(raw.startsWith("---\n")).toBe(true);
  });

  it("is idempotent: re-mark does not duplicate keys", async () => {
    const meta = await createStory();
    await markStoryInitialized(meta.storyId);
    await markStoryInitialized(meta.storyId);
    const raw = await fs.readFile(path.join(root, meta.storyId, "story.md"), "utf8");
    const frontmatter = raw.split("---")[1];
    expect(frontmatter.match(/^initialized: /gm)?.length).toBe(1);
    expect(frontmatter.match(/^initializedAt: /gm)?.length).toBe(1);
  });

  it("throws for invalid storyId", async () => {
    await expect(markStoryInitialized("not-a-uuid")).rejects.toThrow("invalid storyId");
  });

  it("throws when story.md is missing", async () => {
    const meta = await createStory();
    await fs.rm(path.join(root, meta.storyId), { recursive: true });
    await expect(markStoryInitialized(meta.storyId)).rejects.toThrow();
  });
});

describe("turn input/output/done files", () => {
  it("writes input and reads output back", async () => {
    const meta = await createStory();
    await writeTurnInput(meta.storyId, "推开木门");
    // 模拟 runner 直接写 output.md（Issue 3 起 runner 用 fs 写）
    await fs.writeFile(
      path.join(root, meta.storyId, "turn", "output.md"),
      "主角视窗内容",
    );
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

  // --- Issue 9：随机日志读取（供 orchestrator 输出隔离校验） ---
  it("readRandomRollLines returns [] when random-rolls.jsonl does not exist", async () => {
    const meta = await createStory();
    expect(await readRandomRollLines(meta.storyId)).toEqual([]);
  });
  it("readRandomRollLines returns trimmed non-empty lines", async () => {
    const meta = await createStory();
    const line1 = JSON.stringify({ rollId: "perception-check", selectedId: "success" });
    const line2 = JSON.stringify({ rollId: "lockpick", selectedId: "fail" });
    await fs.writeFile(
      path.join(root, meta.storyId, "logs", "random-rolls.jsonl"),
      `${line1}\n${line2}\n\n`,
      "utf8",
    );
    expect(await readRandomRollLines(meta.storyId)).toEqual([line1, line2]);
  });
  it("readRandomRollLines returns [] for invalid storyId", async () => {
    expect(await readRandomRollLines("not-a-uuid")).toEqual([]);
  });

  it("readTurnDone returns null when done.json does not exist", async () => {
    const meta = await createStory();
    expect(await readTurnDone(meta.storyId)).toBeNull();
  });
  it("readTurnDone returns parsed marker when done.json exists", async () => {
    const meta = await createStory();
    await fs.writeFile(
      path.join(root, meta.storyId, "turn", "done.json"),
      JSON.stringify({ status: "success", completedAt: "2026-06-16T12:00:00.000Z" }),
    );
    const done = await readTurnDone(meta.storyId);
    expect(done).toEqual({ status: "success", completedAt: "2026-06-16T12:00:00.000Z" });
  });
  it("readTurnDone returns null for invalid JSON", async () => {
    const meta = await createStory();
    await fs.writeFile(
      path.join(root, meta.storyId, "turn", "done.json"),
      "not-json",
    );
    expect(await readTurnDone(meta.storyId)).toBeNull();
  });
  it("readTurnDone returns null when fields are missing", async () => {
    const meta = await createStory();
    await fs.writeFile(
      path.join(root, meta.storyId, "turn", "done.json"),
      JSON.stringify({ status: "success" }),
    );
    expect(await readTurnDone(meta.storyId)).toBeNull();
  });
  it("readTurnDone returns null for unknown story", async () => {
    expect(await readTurnDone("00000000-0000-4000-8000-000000000000")).toBeNull();
  });

  it("clearTurnDone removes done.json if exists", async () => {
    const meta = await createStory();
    const donePath = path.join(root, meta.storyId, "turn", "done.json");
    await fs.writeFile(donePath, JSON.stringify({ status: "success", completedAt: "2026-06-16T12:00:00.000Z" }));
    await clearTurnDone(meta.storyId);
    await expect(fs.access(donePath)).rejects.toThrow();
  });
  it("clearTurnDone is no-op when done.json does not exist", async () => {
    const meta = await createStory();
    await expect(clearTurnDone(meta.storyId)).resolves.toBeUndefined();
  });
});

describe("resolveWorkspaceDir", () => {
  it("returns absolute path for valid storyId", async () => {
    const meta = await createStory();
    expect(resolveWorkspaceDir(meta.storyId)).toBe(path.resolve(root, meta.storyId));
  });
  it("throws for invalid storyId", () => {
    expect(() => resolveWorkspaceDir("..")).toThrow("invalid storyId");
    expect(() => resolveWorkspaceDir("not-a-uuid")).toThrow("invalid storyId");
    expect(() => resolveWorkspaceDir("")).toThrow("invalid storyId");
  });
});

describe("resolveWorkspaceRoot", () => {
  it("resolves WORKSPACE_ROOT when set", () => {
    expect(resolveWorkspaceRoot()).toBe(path.resolve(root));
  });
});

describe("resolveSnapshotsRoot", () => {
  it("resolves to .snapshots under WORKSPACE_ROOT", () => {
    expect(resolveSnapshotsRoot()).toBe(path.resolve(root, ".snapshots"));
  });
});
