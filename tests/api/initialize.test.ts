import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { POST } from "@/app/api/stories/[storyId]/initialize/route";
import { TurnBusyError } from "@/lib/turn-lock";
import { orchestrator } from "@/lib/runner-selection";
import { readTurnHistory } from "@/lib/turn-history";
import {
  createStory,
  getStory,
  markStoryInitialized,
  resolveWorkspaceRoot,
} from "@/lib/workspace";
import { useTempWorkspaceRoot, resetWorkspaceRoot } from "../helpers/workspace-env";

let root: string;
beforeAll(async () => {
  root = await useTempWorkspaceRoot();
});
afterAll(() => resetWorkspaceRoot());

function req(storyId: string, body: unknown): Request {
  return new Request(`http://localhost/api/stories/${storyId}/initialize`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function ctx(storyId: string) {
  return { params: Promise.resolve({ storyId }) };
}

const SETTING = "雨夜的路边旅店，主角是逃亡的炼金术士，带着一只会说话的猫";

describe("POST /api/stories/{storyId}/initialize (Issue 7)", () => {
  it("returns 200 with playerResponse + committed turn on success", async () => {
    const meta = await createStory({ title: "初始化成功" });
    const res = await POST(req(meta.storyId, { setting: SETTING }), ctx(meta.storyId));

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.playerResponse).toContain("主角视窗");
    expect(json.turn).toBeDefined();
    expect(json.turn.input).toBe(SETTING);
    expect(json.turn.output).toBe(json.playerResponse);
    expect(json.turn.turnId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });

  it("marks story initialized and appends opening to history on success", async () => {
    const meta = await createStory();
    await POST(req(meta.storyId, { setting: SETTING }), ctx(meta.storyId));

    expect((await getStory(meta.storyId))?.initialized).toBe(true);
    const history = await readTurnHistory(meta.storyId);
    expect(history).not.toBeNull();
    expect(history!.length).toBe(1);
    expect(history![0].input).toBe(SETTING);
  });

  it("initializes workspace conceptual documents (fake runner)", async () => {
    const meta = await createStory();
    await POST(req(meta.storyId, { setting: SETTING }), ctx(meta.storyId));

    const wsDir = path.join(resolveWorkspaceRoot(), meta.storyId);
    const player = await fs.readFile(path.join(wsDir, "player.md"), "utf8");
    expect(player).toContain(SETTING); // canon 保留
    const world = await fs.readFile(path.join(wsDir, "world.md"), "utf8");
    expect(world).not.toContain("占位");
  });

  it("returns 400 when setting is missing/blank", async () => {
    const meta = await createStory();
    const res = await POST(req(meta.storyId, { setting: "   " }), ctx(meta.storyId));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("设定不能为空");
  });

  it("returns 400 when body is not valid JSON", async () => {
    const meta = await createStory();
    const bad = new Request(
      `http://localhost/api/stories/${meta.storyId}/initialize`,
      { method: "POST", headers: { "content-type": "application/json" }, body: "not-json" },
    );
    const res = await POST(bad, ctx(meta.storyId));
    expect(res.status).toBe(400);
  });

  it("returns 404 when story does not exist (unknown or invalid id)", async () => {
    const unknown = "00000000-0000-4000-8000-000000000000";
    const res1 = await POST(req(unknown, { setting: "x" }), ctx(unknown));
    expect(res1.status).toBe(404);
    const res2 = await POST(req("not-a-uuid", { setting: "x" }), ctx("not-a-uuid"));
    expect(res2.status).toBe(404);
  });

  it("returns 409 when story is already initialized", async () => {
    const meta = await createStory();
    await markStoryInitialized(meta.storyId);
    const res = await POST(req(meta.storyId, { setting: SETTING }), ctx(meta.storyId));
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error).toBe("故事已初始化");
  });

  it("returns 409 busy when TurnBusyError is thrown", async () => {
    const meta = await createStory();
    const spy = vi.spyOn(orchestrator, "executeTurn").mockRejectedValue(
      new TurnBusyError(meta.storyId),
    );
    try {
      const res = await POST(req(meta.storyId, { setting: SETTING }), ctx(meta.storyId));
      expect(res.status).toBe(409);
      const json = await res.json();
      expect(json.error).toBe("故事正在执行，请稍候");
    } finally {
      spy.mockRestore();
    }
  });

  it("returns 500 with retryInput when initialization fails, story stays retryable", async () => {
    const meta = await createStory();
    const spy = vi.spyOn(orchestrator, "executeTurn").mockResolvedValue({
      success: false,
      playerResponse: null,
      error: "timeout",
    });
    try {
      const res = await POST(req(meta.storyId, { setting: SETTING }), ctx(meta.storyId));
      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json.error).toBe("初始化失败，请重试");
      expect(json.retryInput).toBe(SETTING);
    } finally {
      spy.mockRestore();
    }

    // 失败后故事仍未初始化，可原 storyId 重试（fake runner 成功）
    const retry = await POST(req(meta.storyId, { setting: SETTING }), ctx(meta.storyId));
    expect(retry.status).toBe(200);
    expect((await getStory(meta.storyId))?.initialized).toBe(true);
  });
});
