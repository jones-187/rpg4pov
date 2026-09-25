import { generateRollPool, resolvePoolRoll, type RollChoiceCandidate, type RollChoiceRng } from "./random-tool";
import type { RollDeclaration } from "./state-update";

export interface TurnRollRequest {
  rollId: string;
  candidates: RollChoiceCandidate[];
}

export interface BoundTurnRoll extends TurnRollRequest {
  index: number;
  sample: number;
  selectedId: string;
}

/** Validate the whole batch before drawing anything. Samples never enter model context. */
export function bindTurnRolls(
  raw: string,
  storyId: string,
  workspaceDir: string,
  rng?: RollChoiceRng,
): BoundTurnRoll[] {
  const value = JSON.parse(raw) as { rolls?: unknown };
  if (!value || !Array.isArray(value.rolls) || value.rolls.length < 1 || value.rolls.length > 6) {
    throw new Error("roll request must contain 1-6 rolls");
  }
  const ids = new Set<string>();
  const requests = value.rolls.map((item: unknown) => {
    if (!item || typeof item !== "object") throw new Error("invalid roll request");
    const request = item as TurnRollRequest;
    if (typeof request.rollId !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(request.rollId)) throw new Error("invalid rollId");
    if (!Array.isArray(request.candidates) || request.candidates.length > 8 || request.candidates.some((c) => !c || typeof c.id !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(c.id))) {
      throw new Error("invalid roll candidates");
    }
    // Reuse the authoritative candidate validator before consuming randomness.
    const checked = resolvePoolRoll({ storyId, workspaceDir, rollId: request.rollId, candidates: request.candidates, sample: 0 }).result;
    if (ids.has(checked.rollId)) throw new Error("duplicate rollId");
    ids.add(checked.rollId);
    if (request.candidates.length < 2) throw new Error("random judgment requires at least two outcomes");
    return { rollId: checked.rollId, candidates: request.candidates.map((c) => ({
      id: c.id.trim(), weight: c.weight, ...(c.label === undefined ? {} : { label: c.label }),
    })) };
  });
  const samples = generateRollPool(requests.length, rng);
  return requests.map((request, index) => ({
    ...request,
    index: index + 1,
    sample: samples[index],
    selectedId: resolvePoolRoll({ storyId, workspaceDir, ...request, sample: samples[index] }).result.selectedId,
  }));
}

/** The same batch and outcomes must be acknowledged exactly once, in order. */
export function validateBoundRolls(bound: BoundTurnRoll[], declarations: RollDeclaration[]): void {
  if (bound.length !== declarations.length) throw new Error("binding random outcomes missing or unsolicited");
  for (const [i, roll] of bound.entries()) {
    const declared = declarations[i];
    if (declared.index !== roll.index || declared.rollId !== roll.rollId || declared.declaredSelectedId !== roll.selectedId) {
      throw new Error(`binding random outcome mismatch: R${roll.index}`);
    }
    const pairs = (candidates: RollChoiceCandidate[]) => candidates.map(({ id, weight }) => ({ id, weight }));
    if (JSON.stringify(pairs(declared.candidates)) !== JSON.stringify(pairs(roll.candidates))) {
      throw new Error(`binding random candidates changed: R${roll.index}`);
    }
  }
}

export function bindingRollContext(bound: BoundTurnRoll[]): string {
  return [
    "## 服务端绑定随机结果（候选已冻结，必须服从，不得再次请求或改权重）",
    ...bound.map((roll) => `R${roll.index}: rollId=${roll.rollId} candidates=${roll.candidates.map((c) => `${c.id}:${c.weight}`).join(",")} → ${roll.selectedId}`),
    `候选含义：${JSON.stringify(bound.map(({ rollId, candidates }) => ({ rollId, candidates })))}`,
    `stateUpdate.rolls 必须原样采用：${JSON.stringify(bound.map(roll => ({ index: roll.index, rollId: roll.rollId, candidates: roll.candidates.map(({ id, weight }) => ({ id, weight })), declaredSelectedId: roll.selectedId })))}`,
    "只按以上结果生成正文与状态，不要把申报写进正文。",
  ].join("\n");
}
