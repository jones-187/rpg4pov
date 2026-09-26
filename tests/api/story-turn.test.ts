import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { POST } from "@/app/api/story-turn/route";
import { createStory, markStoryInitialized, readTurnOutput, resolveWorkspaceRoot } from "@/lib/workspace";
import { readTurnHistory } from "@/lib/turn-history";
import { useTempWorkspaceRoot, resetWorkspaceRoot } from "../helpers/workspace-env";

let root: string;
beforeAll(async () => {
  root = await useTempWorkspaceRoot();
});
afterAll(() => resetWorkspaceRoot());

function req(body: unknown): Request {
  return new Request("http://localhost/api/story-turn", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Issue 7 起 turn 前置条件：故事必须已初始化（route 层守卫） */
async function freshStory(): Promise<string> {
  const meta = await createStory({ title: "turn 测试" });
  await markStoryInitialized(meta.storyId);
  return meta.storyId;
}

describe("POST /api/story-turn (Issue 2: storyId-bound, reads only turn/output.md)", () => {
  it("returns 200 and echoes input via turn/output.md", async () => {
    const storyId = await freshStory();
    const res = await POST(req({ storyId, input: "推开木门" }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.playerResponse).toContain("推开木门");
    // 返回内容必须等于 turn/output.md 的落盘内容（Web 唯一来源）
    expect(json.playerResponse).toBe(await readTurnOutput(storyId));
  });

  it("writes player input to turn/input.md", async () => {
    const storyId = await freshStory();
    await POST(req({ storyId, input: "我走向酒馆门口" }));
    const raw = await fs.readFile(
      path.join(resolveWorkspaceRoot(), storyId, "turn", "input.md"),
      "utf8",
    );
    expect(raw).toContain("我走向酒馆门口");
  });

  it("returns 400 when input is missing/blank", async () => {
    const storyId = await freshStory();
    const res = await POST(req({ storyId, input: "   " }));
    expect(res.status).toBe(400);
  });

  it("returns 400 when storyId is invalid", async () => {
    const res = await POST(req({ storyId: "not-a-uuid", input: "x" }));
    expect(res.status).toBe(400);
  });

  it("returns 404 when workspace does not exist", async () => {
    const res = await POST(req({ storyId: "00000000-0000-4000-8000-000000000000", input: "x" }));
    expect(res.status).toBe(404);
  });

  it("returns 400 when body is not valid JSON", async () => {
    const bad = new Request("http://localhost/api/story-turn", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not-json",
    });
    const res = await POST(bad);
    expect(res.status).toBe(400);
  });

  it("reads ONLY turn/output.md — junk in logs/ never leaks", async () => {
    const storyId = await freshStory();
    // 在 logs/ 写入「机密」，断言它不会出现在响应里
    await fs.writeFile(
      path.join(resolveWorkspaceRoot(), storyId, "logs", "secret.md"),
      "机密：主角不应看到的内容",
    );
    const res = await POST(req({ storyId, input: "试探" }));
    const json = await res.json();
    expect(json.playerResponse).not.toContain("机密");
    expect(json.playerResponse).toBe(await readTurnOutput(storyId));
  });

  it("does not leak logs/random-rolls.jsonl through playerResponse", async () => {
    const storyId = await freshStory();
    const randomLogPath = path.join(
      resolveWorkspaceRoot(),
      storyId,
      "logs",
      "random-rolls.jsonl",
    );
    await fs.writeFile(
      randomLogPath,
      JSON.stringify({
        at: "2026-06-17T00:00:00.000Z",
        storyId,
        rollId: "secret-random-roll",
        type: "roll-choice",
        candidates: [{ id: "secret", label: "机密随机结果", weight: 1 }],
        selectedId: "secret",
        randomSource: "injected",
        sample: 0.42,
      }) + "\n",
    );

    const res = await POST(req({ storyId, input: "继续前进" }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.playerResponse).not.toContain("secret-random-roll");
    expect(json.playerResponse).not.toContain("机密随机结果");
    expect(json.playerResponse).toBe(await readTurnOutput(storyId));
  });
});

describe("POST /api/story-turn (Issue 4 regression)", () => {
  it("still returns 200 with playerResponse on success (Fake Agent)", async () => {
    const storyId = await freshStory();
    const res = await POST(req({ storyId, input: "Issue 4 回归" }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.playerResponse).toContain("Issue 4 回归");
  });
});

describe("POST /api/story-turn (Issue 6.5: returns committed turn)", () => {
  it("returns playerResponse and turn on success", async () => {
    const storyId = await freshStory();
    const res = await POST(req({ storyId, input: "推开木门" }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.playerResponse).toContain("推开木门");
    expect(json.turn).toBeDefined();
    expect(json.turn.input).toBe("推开木门");
    expect(json.turn.output).toBe(json.playerResponse);
    expect(json.turn.turnId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });

  it("does not return turn on failure", async () => {
    // 创建一个已存在的故事，然后用无效输入触发失败
    const storyId = await freshStory();
    const res = await POST(req({ storyId, input: "" })); // 空输入
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.turn).toBeUndefined();
  });
});

describe("POST /api/story-turn (Issue 7: init-before-turn guard)", () => {
  it("returns 400 story not initialized when story has no init committed", async () => {
    const meta = await createStory({ title: "未初始化" });
    const res = await POST(req({ storyId: meta.storyId, input: "推开木门" }));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("故事尚未初始化，请先完成初始化");
  });
});

describe("POST /api/story-turn (Issue 9: output isolation)", () => {
  it("500 failure response carries fixed message only — internal error/stdout never leak", async () => {
    const storyId = await freshStory();
    const { orchestrator } = await import("@/lib/runner-selection");
    const spy = vi.spyOn(orchestrator, "executeTurn").mockResolvedValue({
      success: false,
      playerResponse: null,
      error: "INTERNAL-SECRET-REASON claude exit code 1",
    });
    try {
      const res = await POST(req({ storyId, input: "试探" }));
      expect(res.status).toBe(500);
      const raw = JSON.stringify(await res.json());
      expect(raw).not.toContain("INTERNAL-SECRET-REASON");
      expect(raw).not.toContain("claude");
      expect(raw).toContain("回合执行失败，请重试");
      expect(raw).toContain("试探"); // retryInput 回填
    } finally {
      spy.mockRestore();
    }
  });
});

// --- Issue 10：continue 命令与交互状态 ---

describe("POST /api/story-turn interaction state (Issue 10)", () => {
  it("returns interaction in success response", async () => {
    const storyId = await freshStory();
    const res = await POST(req({ storyId, input: "看向店主" }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.interaction).toEqual({ mode: "continue", suggestions: [] });
  });

  it("accepts command=continue without input", async () => {
    const storyId = await freshStory();
    const res = await POST(req({ storyId, command: "continue" }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.turn.input).toBe("（继续）");
    // turn/input.md 收到系统指令文本，不是空输入
    const raw = await fs.readFile(
      path.join(resolveWorkspaceRoot(), storyId, "turn", "input.md"),
      "utf8",
    );
    expect(raw).toContain("【系统指令·继续】");
  });

  it("still 400 when neither input nor continue command", async () => {
    const storyId = await freshStory();
    const res = await POST(req({ storyId }));
    expect(res.status).toBe(400);
  });
});

describe("POST /api/story-turn command+input precedence (Issue 10)", () => {
  it("treats request as a normal turn when both input and command=continue are provided", async () => {
    const storyId = await freshStory();
    const res = await POST(req({ storyId, input: "开口问店主今晚有没有空房", command: "continue" }));
    expect(res.status).toBe(200);
    const json = await res.json();
    // 玩家输入不因 command 字段被静默丢弃
    expect(json.turn.input).toBe("开口问店主今晚有没有空房");
    expect(json.playerResponse).toContain("开口问店主今晚有没有空房");
  });
});

describe("POST /api/story-turn retry latest turn", () => {
  it("rejects retry when no ordinary turn has been committed", async () => {
    const storyId = await freshStory();
    const retried = await POST(req({ storyId, command: "retry" }));
    expect(retried.status).toBe(409);
    expect(await readTurnHistory(storyId)).toEqual([]);
  });

  it("replaces the latest committed turn while preserving its player input", async () => {
    const storyId = await freshStory();
    const first = await POST(req({ storyId, input: "推开木门" }));
    expect(first.status).toBe(200);
    const firstJson = await first.json();

    const retried = await POST(req({
      storyId,
      command: "retry",
      correction: "这次不要写得含糊",
    }));

    expect(retried.status).toBe(200);
    const retriedJson = await retried.json();
    expect(retriedJson.turn.input).toBe("推开木门");
    expect(retriedJson.turn.turnId).toBe(firstJson.turn.turnId);
    const history = await readTurnHistory(storyId);
    expect(history).toHaveLength(1);
    expect(history?.[0]).toEqual(retriedJson.turn);
  });

  it("replaces only the latest turn and keeps earlier history unchanged", async () => {
    const storyId = await freshStory();
    const first = await POST(req({ storyId, input: "先观察门外" }));
    const firstTurn = (await first.json()).turn;
    const second = await POST(req({ storyId, input: "再推开木门" }));
    const secondTurn = (await second.json()).turn;

    const retried = await POST(req({ storyId, command: "retry" }));
    expect(retried.status).toBe(200);
    const retriedTurn = (await retried.json()).turn;
    const history = await readTurnHistory(storyId);
    expect(history).toHaveLength(2);
    expect(history?.[0]).toEqual(firstTurn);
    expect(history?.[1].turnId).toBe(secondTurn.turnId);
    expect(history?.[1]).toEqual(retriedTurn);
  });

  it("treats correction as retry-only context, not a new history input", async () => {
    const storyId = await freshStory();
    await POST(req({ storyId, input: "询问守卫" }));
    const retried = await POST(req({
      storyId,
      command: "retry",
      correction: "守卫已经见过主角，不要写成陌生人",
    }));
    expect(retried.status).toBe(200);
    const history = await readTurnHistory(storyId);
    expect(history?.at(-1)?.input).toBe("询问守卫");
    expect(history?.at(-1)?.input).not.toContain("不要写成陌生人");
  });
});
