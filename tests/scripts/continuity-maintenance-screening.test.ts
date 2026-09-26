import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  assertRuntimeModel,
  buildScreeningPlan,
  isExactSingleCall,
  isWithinCallBudget,
  validateScreeningScenario,
} from "../../scripts/continuity-maintenance-screening.cjs";
import { validateScenario as validateAbScenario } from "../../scripts/continuity-maintenance-ab-eval.cjs";

const scenario = JSON.parse(readFileSync(
  path.join(process.cwd(), "docs/acceptance/scenarios/continuity-maintenance-kimi-k3-screening.json"),
  "utf8",
));
const frozenAbScenario = JSON.parse(readFileSync(
  path.join(process.cwd(), "docs/acceptance/scenarios/continuity-maintenance-ab.json"),
  "utf8",
));

describe("continuity-maintenance-screening", () => {
  it("plans only the maintained first turn for each frozen case and repeat", () => {
    expect(() => validateAbScenario(frozenAbScenario)).not.toThrow();
    expect(() => validateScreeningScenario(scenario)).not.toThrow();
    const plan = buildScreeningPlan(scenario, frozenAbScenario);
    expect(plan).toHaveLength(9);
    expect(plan.every((entry: { arm: string }) => entry.arm === "maintained")).toBe(true);
    expect(plan.every((entry: { testCase: { turn1Input?: string }; repeat: number }) =>
      Boolean(entry.testCase.turn1Input) && entry.repeat >= 1 && entry.repeat <= 3)).toBe(true);
    for (const testCase of frozenAbScenario.cases) {
      expect(plan.filter((entry: { testCase: { id: string } }) =>
        entry.testCase.id === testCase.id)).toHaveLength(3);
    }
  });

  it("pins the screen to the exact frozen source scenario", () => {
    const sourceBytes = readFileSync(
      path.join(process.cwd(), "docs/acceptance/scenarios", scenario.sourceScenario),
    );
    expect(createHash("sha256").update(sourceBytes).digest("hex"))
      .toBe(scenario.sourceScenarioSha256);
  });

  it("requires Kimi K3 in the screening config and an exact temporary runtime match", () => {
    expect(() => validateScreeningScenario({ ...scenario, model: "deepseek-v4.1-flash" }))
      .toThrow(/scenario.model/);
    expect(() => assertRuntimeModel(scenario.model, "deepseek-v4.1-flash")).toThrow(/does not match/);
    expect(() => assertRuntimeModel(scenario.model, "kimi-k3")).not.toThrow();
  });

  it("locks the promotion gate to 9 technical passes and zero hard semantic errors", () => {
    expect(() => validateScreeningScenario({
      ...scenario,
      promotionGate: { ...scenario.promotionGate, technicalPasses: 8 },
    })).toThrow(/promotionGate/);
    expect(() => validateScreeningScenario({
      ...scenario,
      automaticRetries: 1,
    })).toThrow(/automaticRetries/);
  });

  it("accepts one real spawn attempt even when its response fails technically, but rejects missing or failed spawns", () => {
    expect(isExactSingleCall({
      modelCallRequests: 1,
      modelCalls: 1,
      budgetViolation: false,
      turnErrorCategory: null,
      callSummaries: [{ failure: null }],
      technicalPass: false,
    })).toBe(true);
    expect(isExactSingleCall({
      modelCallRequests: 0,
      modelCalls: 0,
      callSummaries: [],
    })).toBe(false);
    expect(isExactSingleCall({
      modelCallRequests: 1,
      modelCalls: 1,
      turnErrorCategory: "spawn-failed",
      callSummaries: [{ failure: "spawn failed" }],
    })).toBe(false);
    expect(isExactSingleCall({
      modelCallRequests: 2,
      modelCalls: 2,
      budgetViolation: true,
      callSummaries: [{}, {}],
    })).toBe(false);
  });

  it("accepts one or two real calls in the bounded repair screen", () => {
    const record = {
      modelCallRequests: 2,
      modelCalls: 2,
      budgetViolation: false,
      turnErrorCategory: null,
      callSummaries: [{ failure: null }, { failure: null }],
    };
    expect(isWithinCallBudget(record, 2)).toBe(true);
    expect(isWithinCallBudget(record, 1)).toBe(false);
    expect(isWithinCallBudget({ ...record, modelCallRequests: 0, modelCalls: 0, callSummaries: [] }, 2)).toBe(false);
  });
});
