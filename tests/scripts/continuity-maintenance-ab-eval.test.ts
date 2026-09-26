import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { readFileSync } from "node:fs";
import {
  buildReviewPacket,
  ensureOutputDirectory,
  shouldContinueAfterTurn,
  validateScenario,
} from "../../scripts/continuity-maintenance-ab-eval.cjs";

const scenarioFixture = JSON.parse(readFileSync(
  path.join(process.cwd(), "docs/acceptance/scenarios/continuity-maintenance-ab.json"),
  "utf8",
));
const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rpg4pov-continuity-maintenance-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("continuity-maintenance-ab-eval", () => {
  it("accepts the frozen three-case, two-turn scenario", () => {
    expect(() => validateScenario(scenarioFixture)).not.toThrow();
    expect(scenarioFixture.cases).toHaveLength(3);
    expect(scenarioFixture.cases.every((testCase: { turn1Input?: string; turn2Input?: string }) =>
      Boolean(testCase.turn1Input && testCase.turn2Input))).toBe(true);
  });

  it("rejects wrong runtime policy, unbalanced order, and missing second-turn review fields", () => {
    expect(() => validateScenario({ ...scenarioFixture, model: "other-model" })).toThrow(/model/);
    expect(() => validateScenario({ ...scenarioFixture, piThinking: "high" })).toThrow(/piThinking/);
    expect(() => validateScenario({ ...scenarioFixture, automaticRetries: 1 })).toThrow(/automaticRetries/);
    expect(() => validateScenario({ ...scenarioFixture, cases: scenarioFixture.cases.slice(0, 2) })).toThrow(/exactly 3/);
    expect(() => validateScenario({
      ...scenarioFixture,
      order: [["static", "maintained"], ["static", "maintained"], ["static", "maintained"]],
    })).toThrow(/alternate/);
    expect(() => validateScenario({
      ...scenarioFixture,
      cases: scenarioFixture.cases.map((testCase: Record<string, unknown>, index: number) =>
        index === 0 ? { ...testCase, turn2Checklist: [] } : testCase),
    })).toThrow(/turn2Checklist/);
  });

  it("continues after exactly one call even on a technical failure, but stops on zero or multiple calls", () => {
    expect(shouldContinueAfterTurn({ modelCallRequests: 1, modelCalls: 1, technicalPass: false })).toBe(true);
    expect(shouldContinueAfterTurn({ modelCallRequests: 1, modelCalls: 1, technicalPass: true })).toBe(true);
    expect(shouldContinueAfterTurn({ modelCallRequests: 0, modelCalls: 0 })).toBe(false);
    expect(shouldContinueAfterTurn({ modelCallRequests: 2, modelCalls: 1 })).toBe(false);
    expect(shouldContinueAfterTurn({ modelCallRequests: 2, modelCalls: 2 })).toBe(false);
  });

  it("builds an arm-blind packet while retaining each chain's own first-turn history", () => {
    const packet = buildReviewPacket({
      testCase: scenarioFixture.cases[0],
      records: [
        {
          arm: "static",
          blindTurn2File: "a1b2.md",
          turn1TechnicalPass: true,
          turn2TechnicalPass: true,
          historyBeforeTurn2: [{ input: "turn 1", output: "history from chain A" }],
        },
        {
          arm: "maintained",
          blindTurn2File: "c3d4.md",
          turn1TechnicalPass: true,
          turn2TechnicalPass: true,
          historyBeforeTurn2: [{ input: "turn 1", output: "history from chain B" }],
        },
      ],
      randomizer: () => 0,
    });

    expect(packet.submissions.map((submission: { blindFile: string }) => submission.blindFile))
      .toEqual(["blind/a1b2.md", "blind/c3d4.md"]);
    expect(packet.submissions[0].historyBeforeTurn2[0].output).toBe("history from chain A");
    expect(packet.submissions[1].historyBeforeTurn2[0].output).toBe("history from chain B");
    expect(packet.eligibleForSemanticReview).toBe(true);
    const serialized = JSON.stringify(packet);
    expect(serialized).not.toContain("static");
    expect(serialized).not.toContain("maintained");
    expect(serialized).not.toContain('"arm"');

    const reversed = buildReviewPacket({
      testCase: scenarioFixture.cases[0],
      records: [
        { blindTurn2File: "a1b2.md", turn1TechnicalPass: true, turn2TechnicalPass: true, historyBeforeTurn2: [] },
        { blindTurn2File: "c3d4.md", turn1TechnicalPass: true, turn2TechnicalPass: true, historyBeforeTurn2: [] },
      ],
      randomizer: () => 1,
    });
    expect(reversed.submissions[0].blindFile).toBe("blind/c3d4.md");
  });

  it("refuses a non-empty output directory", async () => {
    const root = await makeTempDir();
    const output = path.join(root, "evidence");
    await fs.mkdir(output);
    await fs.writeFile(path.join(output, "keep.txt"), "existing evidence");

    await expect(ensureOutputDirectory(output)).rejects.toThrow(/new and empty/);
    await expect(fs.readFile(path.join(output, "keep.txt"), "utf8")).resolves.toBe("existing evidence");
  });
});
