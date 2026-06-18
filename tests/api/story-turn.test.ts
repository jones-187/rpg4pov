import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { POST } from "@/app/api/story-turn/route";
import { createStory, readTurnOutput, resolveWorkspaceRoot } from "@/lib/workspace";
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

async function freshStory(): Promise<string> {
  const meta = await createStory({ title: "turn 测试" });
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
