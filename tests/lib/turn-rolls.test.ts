import { describe, it, expect, vi } from "vitest";
import { bindTurnRolls, bindingRollContext, validateBoundRolls } from "@/lib/turn-rolls";
import { parseStateUpdate } from "@/lib/state-update";

const storyId = "11111111-1111-4111-8111-111111111111";
const rolls = [{ rollId: "lockpick", candidates: [{ id: "success", weight: 25 }, { id: "fail", weight: 75 }] }];

describe("binding random judgments", () => {
  it("validates all candidates before drawing and never includes samples in model context", () => {
    const rng = vi.fn(() => 0.912345678);
    const bound = bindTurnRolls(JSON.stringify({ rolls }), storyId, "/tmp/unused", rng);
    expect(rng).toHaveBeenCalledTimes(1);
    expect(bound[0].selectedId).toBe("fail");
    const context = bindingRollContext(bound);
    expect(context).toContain("→ fail");
    expect(context).not.toContain("0.912345");
    expect(context).not.toContain("sample");
    expect(() => validateBoundRolls(bound, parseStateUpdate("=== RANDOM ===\nR1: rollId=lockpick candidates=success:25,fail:75 → fail").rolls)).not.toThrow();
  });

  it("invalid later requests consume no randomness", () => {
    const rng = vi.fn(() => 0.5);
    expect(() => bindTurnRolls(JSON.stringify({ rolls: [...rolls, { rollId: "broken", candidates: [{ id: "bad", weight: -1 }] }] }), storyId, "/tmp/unused", rng)).toThrow();
    expect(rng).not.toHaveBeenCalled();
  });

  it.each([
    "R1: rollId=lockpick candidates=success:25,fail:75 → success",
    "R1: rollId=lockpick candidates=success:1,fail:99 → fail",
    "R2: rollId=lockpick candidates=success:25,fail:75 → fail",
    "R1: rollId=another candidates=success:25,fail:75 → fail",
    "R1: rollId=lockpick candidates=success:25,fail:75",
    "",
  ])("rejects altered, missing or mismatched acknowledgment: %s", (line) => {
    const bound = bindTurnRolls(JSON.stringify({ rolls }), storyId, "/tmp/unused", () => 0.9);
    expect(() => validateBoundRolls(bound, parseStateUpdate(`=== RANDOM ===\n${line}`).rolls)).toThrow();
  });

  it("rejects unsolicited rolls and duplicate request identifiers", () => {
    expect(() => validateBoundRolls([], parseStateUpdate("=== RANDOM ===\nR1: rollId=x candidates=a:1,b:1 → a").rolls)).toThrow();
    expect(() => bindTurnRolls(JSON.stringify({ rolls: [...rolls, ...rolls] }), storyId, "/tmp/unused")).toThrow("duplicate");
  });
});
