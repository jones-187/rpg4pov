import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createStory, getStory, resolveWorkspaceRoot } from "@/lib/workspace";
import { readTurnHistory } from "@/lib/turn-history";
import { useTempWorkspaceRoot, resetWorkspaceRoot } from "../helpers/workspace-env";

/**
 * Issue 8 本机验证：ClaudeCodeRunner（真实 spawn 路径）走完整 API 链路。
 * 用 fake-claude fixture 替身 claude CLI——覆盖 stdin prompt 注入、env 白名单、
 * cwd、done.json 磁盘权威、Issue 7 init 校验、Issue 9 输出契约，缺的只是真实 LLM。
 * 真实凭证/Docker 环境验收留 HITL。
 */
vi.mock("@/lib/runner-selection", async () => {
  const pathMod = await import("node:path");
  const { TurnOrchestrator } = await import("@/lib/turn-orchestrator");
  const { ClaudeCodeRunner } = await import("@/lib/claude-code-runner");
  const { defaultSpawn } = await import("@/lib/agent-spawn");
  const FAKE = pathMod.resolve(__dirname, "../fixtures/fake-claude.mjs");
  const wrappedSpawn = (cmd: string, args: string[], opts: unknown) =>
    defaultSpawn("node", [FAKE, ...args], opts as Parameters<typeof defaultSpawn>[2]);
  return {
    orchestrator: new TurnOrchestrator(new ClaudeCodeRunner({ spawnFn: wrappedSpawn })),
  };
});

import { POST as postInitialize } from "@/app/api/stories/[storyId]/initialize/route";
import { POST as postTurn } from "@/app/api/story-turn/route";

let root: string;
beforeAll(async () => {
  root = await useTempWorkspaceRoot();
});
afterAll(() => resetWorkspaceRoot());

const SETTING = "雾中的废弃灯塔，主角是守塔人的学徒";

function initReq(storyId: string): Request {
  return new Request(`http://localhost/api/stories/${storyId}/initialize`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ setting: SETTING }),
  });
}

function turnReq(storyId: string, input: string): Request {
  return new Request("http://localhost/api/story-turn", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ storyId, input }),
  });
}

function ctx(storyId: string) {
  return { params: Promise.resolve({ storyId }) };
}

describe("ClaudeCodeRunner full chain via API (Issue 8, fake-claude fixture)", () => {
  it("initialize → opening committed, docs filled, canon preserved, story marked", async () => {
    const meta = await createStory({ title: "claude 链路" });
    const res = await postInitialize(initReq(meta.storyId), ctx(meta.storyId));

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.playerResponse).toContain("主角视窗");
    expect(json.playerResponse).toContain("fake-claude");

    // 概念文档被 fixture 写实（Issue 7 init 校验通过才会到这里）
    const wsDir = path.join(root, meta.storyId);
    const world = await fs.readFile(path.join(wsDir, "world.md"), "utf8");
    expect(world).not.toContain("占位");
    // canon 保留：fixture 从 prompt 抽取设定原文写入 player.md
    const player = await fs.readFile(path.join(wsDir, "player.md"), "utf8");
    expect(player).toContain(SETTING);
    // Emotional Continuity：actor 卡四块情感结构经真实 spawn 链路落盘
    const actor = await fs.readFile(path.join(wsDir, "actors", "keeper.md"), "utf8");
    expect(actor).toContain("## Emotional Core");
    expect(actor).toContain("## Relationship State: 主角");
    expect(actor).toContain("## Emotionally Salient Memories");
    expect(actor).toContain("## Current Intent");
    expect(actor).toContain("restraint");

    expect((await getStory(meta.storyId))?.initialized).toBe(true);
    expect((await readTurnHistory(meta.storyId))!.length).toBe(1);
  });

  it("story-turn → fake-claude turn output committed as second entry, no God State leak", async () => {
    const meta = await createStory({ title: "claude 链路-回合" });
    await postInitialize(initReq(meta.storyId), ctx(meta.storyId));

    const res = await postTurn(turnReq(meta.storyId, "沿楼梯上到灯塔顶层"));
    expect(res.status).toBe(200);
    const json = await res.json();
    // fake-claude turn 模式输出
    expect(json.playerResponse).toContain("回合执行完成");
    expect(json.turn.input).toBe("沿楼梯上到灯塔顶层");

    const history = await readTurnHistory(meta.storyId);
    expect(history!.length).toBe(2);

    // God State 不外泄：fixture world.md 的隐藏事实只在 workspace，不在响应
    const world = await fs.readFile(
      path.join(root, meta.storyId, "world.md"),
      "utf8",
    );
    const hidden = world.split("\n").find((l) => l.includes("隐藏事实"));
    if (hidden) {
      expect(json.playerResponse).not.toContain(hidden.trim());
    }
  });
});
