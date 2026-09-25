import { describe, expect, it } from "vitest";
import { buildReviewPacket, shouldContinueAfterRun, validateScenario } from "../../scripts/fact-ledger-ab-eval.cjs";

const scenarioFixture = {
  experiment: "fact-ledger-injection",
  model: "deepseek-v4.1-flash",
  repeatsPerArm: 3,
  automaticRetries: 0,
  arms: ["baseline", "ledger"],
  order: [
    ["baseline", "ledger"],
    ["ledger", "baseline"],
    ["baseline", "ledger"],
  ],
  cases: [],
};

const validCase = {
  id: "case-1",
  dimension: "information-disclosure",
  title: "私密信息越权",
  fixture: {
    world: "world",
    player: "player",
    actorFile: "actor.md",
    actor: "actor",
    opening: "# 主角视窗\n\n开场",
    priorHistory: [
      { turnId: "t1", at: "2026-09-25T10:00:00.000Z", input: "开场", output: "开场正文" },
    ],
  },
  playerInput: "我继续问。",
  ledger: {
    version: "1",
    events: [
      {
        id: "e1",
        text: "主角知道北门暗格里有半张海图。",
        source: "player",
        time: "第三夜",
        location: "北门暗格",
        witnesses: ["主角"],
        visibility: "private",
        causedBy: [],
      },
    ],
  },
  blindChecklist: ["正文是否避免泄露主角私密信息"],
  advisoryTokens: ["北门暗格", "半张海图"],
};

for (let i = 0; i < 3; i += 1) scenarioFixture.cases.push({ ...validCase, id: `case-${i + 1}` });

describe("fact-ledger-ab-eval", () => {
  it("accepts a structurally valid scenario", () => {
    expect(() => validateScenario(scenarioFixture)).not.toThrow();
  });

  it("rejects wrong model, retries, arm order, and malformed ledger", () => {
    expect(() => validateScenario({ ...scenarioFixture, model: "other-model" })).toThrow(/model/);
    expect(() => validateScenario({ ...scenarioFixture, automaticRetries: 1 })).toThrow(/automaticRetries/);
    expect(() => validateScenario({ ...scenarioFixture, order: [["baseline"], ["ledger", "baseline"], ["baseline", "ledger"]] })).toThrow(/order/);
    expect(() => validateScenario({
      ...scenarioFixture,
      cases: scenarioFixture.cases.map((testCase, index) => index === 0
        ? { ...testCase, ledger: { ...testCase.ledger, version: "2" } }
        : testCase),
    })).toThrow(/ledger.version/);
  });

  it("rejects unsafe actor paths and malformed history", () => {
    expect(() => validateScenario({
      ...scenarioFixture,
      cases: scenarioFixture.cases.map((testCase, index) => index === 0
        ? { ...testCase, fixture: { ...testCase.fixture, actorFile: "../actor.md" } }
        : testCase),
    })).toThrow(/actorFile/);

    expect(() => validateScenario({
      ...scenarioFixture,
      cases: scenarioFixture.cases.map((testCase, index) => index === 0
        ? {
            ...testCase,
            fixture: {
              ...testCase.fixture,
              priorHistory: [{ ...testCase.fixture.priorHistory[0], input: "" }],
            },
          }
        : testCase),
    })).toThrow(/priorHistory\[0\]\.input/);
  });

  it("continues after one-call technical failures but stops on invalid call counts", () => {
    expect(shouldContinueAfterRun({ modelCalls: 1, technicalPass: false })).toBe(true);
    expect(shouldContinueAfterRun({ modelCalls: 0, technicalPass: false })).toBe(false);
    expect(shouldContinueAfterRun({ modelCalls: 2, technicalPass: true })).toBe(false);
  });

  it("builds pair packets without leaking arms", () => {
    const testCase = {
      ...validCase,
      fixture: {
        ...validCase.fixture,
        opening: "opening",
        priorHistory: [{ turnId: "t1", at: "a", input: "i", output: "o" }],
      },
    };
    const records = [
      { blindFile: "a.md", technicalPass: true },
      { blindFile: "b.md", technicalPass: false },
    ];
    const packet = buildReviewPacket({
      testCase,
      records,
      randomizer: () => 0,
    });

    expect(JSON.stringify(packet)).not.toContain("arm");
    expect(packet.blindFiles).toEqual(["blind/a.md", "blind/b.md"]);
    expect(packet.history.at(-1)).toMatchObject({ output: "opening" });
    expect(packet.blindChecklist).toEqual(testCase.blindChecklist);
    expect(packet.eligibleForSemanticReview).toBe(false);

    const reversed = buildReviewPacket({ testCase, records, randomizer: () => 1 });
    expect(reversed.blindFiles).toEqual(["blind/b.md", "blind/a.md"]);
  });
});
