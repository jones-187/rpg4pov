// tests/lib/turn-history.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  appendTurnHistory,
  readTurnHistory,
  type TurnHistoryEntry,
} from "@/lib/turn-history";
import { createStory, resolveWorkspaceRoot } from "@/lib/workspace";
import { useTempWorkspaceRoot, resetWorkspaceRoot } from "../helpers/workspace-env";

let root: string;
beforeAll(async () => {
  root = await useTempWorkspaceRoot();
});
afterAll(() => resetWorkspaceRoot());

describe("turn-history", () => {
  describe("TurnHistoryEntry type", () => {
    it("has required fields: turnId, at, input, output", () => {
      const entry: TurnHistoryEntry = {
        turnId: "test-id",
        at: "2026-06-18T00:00:00.000Z",
        input: "推开木门",
        output: "你推开木门，走进房间。",
      };
      expect(entry.turnId).toBe("test-id");
      expect(entry.at).toBe("2026-06-18T00:00:00.000Z");
      expect(entry.input).toBe("推开木门");
      expect(entry.output).toBe("你推开木门，走进房间。");
    });
  });

  describe("appendTurnHistory", () => {
    it("appends entry to turns/history.jsonl", async () => {
      const meta = await createStory({ title: "history 测试" });
      const entry: TurnHistoryEntry = {
        turnId: "turn-1",
        at: "2026-06-18T00:00:00.000Z",
        input: "推开木门",
        output: "你推开木门。",
      };
      await appendTurnHistory(meta.storyId, entry);

      const historyPath = path.join(root, meta.storyId, "turns", "history.jsonl");
      const raw = await fs.readFile(historyPath, "utf8");
      expect(raw).toContain("turn-1");
      expect(raw).toContain("推开木门");
    });

    it("appends multiple entries as JSONL lines", async () => {
      const meta = await createStory();
      await appendTurnHistory(meta.storyId, {
        turnId: "turn-1",
        at: "2026-06-18T00:00:00.000Z",
        input: "第一次输入",
        output: "第一次输出",
      });
      await appendTurnHistory(meta.storyId, {
        turnId: "turn-2",
        at: "2026-06-18T00:01:00.000Z",
        input: "第二次输入",
        output: "第二次输出",
      });

      const history = await readTurnHistory(meta.storyId);
      expect(history).not.toBeNull();
      expect(history!.length).toBe(2);
      expect(history![0].turnId).toBe("turn-1");
      expect(history![1].turnId).toBe("turn-2");
    });

    // Issue 6.5 反馈 1：兼容旧 story workspace（turns/ 不存在）
    it("creates turns/ directory if missing (old workspace compatibility)", async () => {
      const meta = await createStory();
      const turnsDir = path.join(root, meta.storyId, "turns");
      // 删除 createStory 创建的 turns/ 目录，模拟旧 workspace
      await fs.rm(turnsDir, { recursive: true });

      const entry: TurnHistoryEntry = {
        turnId: "turn-1",
        at: "2026-06-18T00:00:00.000Z",
        input: "兼容测试",
        output: "成功追加。",
      };
      // 应自动创建 turns/ 并写入
      await appendTurnHistory(meta.storyId, entry);

      const historyPath = path.join(turnsDir, "history.jsonl");
      const raw = await fs.readFile(historyPath, "utf8");
      expect(raw).toContain("turn-1");
    });
  });

  describe("readTurnHistory", () => {
    it("returns empty array when history.jsonl does not exist", async () => {
      const meta = await createStory();
      const historyPath = path.join(root, meta.storyId, "turns", "history.jsonl");
      // 真正删除文件，测试 ENOENT 场景
      await fs.unlink(historyPath);

      const history = await readTurnHistory(meta.storyId);
      expect(history).toEqual([]);
    });

    it("returns empty array for empty file", async () => {
      const meta = await createStory();
      const historyPath = path.join(root, meta.storyId, "turns", "history.jsonl");
      // 确保文件存在但为空
      await fs.writeFile(historyPath, "");

      const history = await readTurnHistory(meta.storyId);
      expect(history).toEqual([]);
    });

    it("returns parsed entries from history.jsonl", async () => {
      const meta = await createStory();
      await appendTurnHistory(meta.storyId, {
        turnId: "turn-1",
        at: "2026-06-18T00:00:00.000Z",
        input: "输入",
        output: "输出",
      });

      const history = await readTurnHistory(meta.storyId);
      expect(history).not.toBeNull();
      expect(history!.length).toBe(1);
      expect(history![0].input).toBe("输入");
      expect(history![0].output).toBe("输出");
    });

    it("returns null for invalid storyId", async () => {
      const history = await readTurnHistory("not-a-uuid");
      expect(history).toBeNull();
    });

    // Issue 6.5 反馈 2：malformed JSONL 应抛错，不静默返回 []
    it("throws on malformed JSONL (not silent empty array)", async () => {
      const meta = await createStory();
      const historyPath = path.join(root, meta.storyId, "turns", "history.jsonl");
      await fs.writeFile(historyPath, "not valid json\n");

      await expect(readTurnHistory(meta.storyId)).rejects.toThrow();
    });
  });
});