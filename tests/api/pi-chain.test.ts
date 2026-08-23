import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createStory, getStory, resolveWorkspaceRoot } from "@/lib/workspace";
import { readTurnHistory } from "@/lib/turn-history";
import { useTempWorkspaceRoot, resetWorkspaceRoot } from "../helpers/workspace-env";

/** Run the real PiRunner + Orchestrator + API path without network/model access. */
vi.mock("@/lib/runner-selection", async () => {
  const pathMod = await import("node:path");
  const { TurnOrchestrator } = await import("@/lib/turn-orchestrator");
  const { PiRunner } = await import("@/lib/pi-runner");
  const { defaultSpawn } = await import("@/lib/agent-spawn");
  const fakePi = pathMod.resolve(__dirname, "../fixtures/fake-pi.mjs");
  const wrappedSpawn = (cmd: string, args: string[], opts: Parameters<typeof defaultSpawn>[2]) =>
    defaultSpawn("node", [fakePi, ...args], opts);
  return { orchestrator: new TurnOrchestrator(new PiRunner({ spawnFn: wrappedSpawn })) };
});

import { POST as postInitialize } from "@/app/api/stories/[storyId]/initialize/route";
import { POST as postTurn } from "@/app/api/story-turn/route";

let root: string;
const savedEnv: Record<string, string | undefined> = {};
beforeAll(async () => {
  root = await useTempWorkspaceRoot();
  for (const key of ["PI_HOME", "ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN"]) {
    savedEnv[key] = process.env[key];
  }
  process.env.PI_HOME = await fs.mkdtemp(path.join(root, "pi-home-"));
  process.env.ANTHROPIC_BASE_URL = "http://fake.invalid";
  process.env.ANTHROPIC_AUTH_TOKEN = "fake-token";
});
afterAll(() => {
  resetWorkspaceRoot();
  for (const key of ["PI_HOME", "ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN"]) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const SETTING = "雾中的废弃灯塔，主角是守塔学徒，指定第一人称限知视角";

function request(url: string, body: unknown): Request {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function ctx(storyId: string) {
  return { params: Promise.resolve({ storyId }) };
}

describe("fake-pi initialization chain", () => {
  it("submits init through PiRunner and keeps canon/output isolation", async () => {
    const meta = await createStory({ title: "fake pi 链路" });
    // The fake CLI must receive PiRunner's workspace cwd. Guard against a
    // fixture accidentally writing candidate artifacts into the repository
    // root (which would contaminate the shared checkout).
    const rootTurn = path.join(process.cwd(), "turn");
    const rootArtifacts = ["output.md", "interaction.json", "done.json"].map((name) =>
      path.join(rootTurn, name),
    );
    const rootExistedBefore = await Promise.all(
      rootArtifacts.map(async (file) => {
        try {
          await fs.access(file);
          return true;
        } catch {
          return false;
        }
      }),
    );
    const init = await postInitialize(
      request(`http://localhost/api/stories/${meta.storyId}/initialize`, { setting: SETTING }),
      ctx(meta.storyId),
    );
    expect(init.status).toBe(200);
    const json = await init.json();
    expect(json.playerResponse).toContain("主角视窗");
    expect(json.playerResponse).not.toContain("隐藏事实");

    const dir = path.join(resolveWorkspaceRoot(), meta.storyId);
    await expect(fs.readFile(path.join(dir, "player.md"), "utf8")).resolves.toContain(SETTING);
    await expect(fs.readFile(path.join(dir, "actors/keeper.md"), "utf8")).resolves.toContain("Emotional Core");
    await expect(fs.readFile(path.join(dir, "turn/done.json"), "utf8")).resolves.toContain("success");
    expect((await getStory(meta.storyId))?.initialized).toBe(true);
    expect((await readTurnHistory(meta.storyId))?.length).toBe(1);

    const turn = await postTurn(
      request("http://localhost/api/story-turn", { storyId: meta.storyId, input: "走向地下室" }),
    );
    expect(turn.status).toBe(200);
    const turnJson = await turn.json();
    expect(turnJson.playerResponse).toContain("主角视窗");
    expect((await readTurnHistory(meta.storyId))?.length).toBe(2);
    for (const [index, file] of rootArtifacts.entries()) {
      if (!rootExistedBefore[index]) await expect(fs.access(file)).rejects.toThrow();
    }
  });
});
