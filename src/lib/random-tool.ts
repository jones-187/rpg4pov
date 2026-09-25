import { promises as fs } from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { isValidStoryId, RANDOM_ROLLS_LOG } from "./workspace";

// 文件名常量定义在 workspace.ts（避免循环依赖），此处 re-export 保持既有导入不变
export { RANDOM_ROLLS_LOG };

export type RandomSource = "crypto" | "injected" | "pool";

export type RollChoiceRng = () => number;

export interface RollChoiceCandidate {
  id: string;
  label?: string;
  weight: number;
}

export interface RollChoiceInput {
  storyId: string;
  workspaceDir: string;
  rollId: string;
  candidates: RollChoiceCandidate[];
  rng?: RollChoiceRng;
}

export interface RollChoiceResult {
  rollId: string;
  selectedId: string;
  selectedCandidate: RollChoiceCandidate;
  sample: number;
  randomSource: RandomSource;
}

interface NormalizedCandidates {
  candidates: RollChoiceCandidate[];
  totalWeight: number;
}

export async function rollChoice(input: RollChoiceInput): Promise<RollChoiceResult> {
  if (!isValidStoryId(input.storyId)) {
    throw new Error("invalid storyId");
  }
  if (typeof input.workspaceDir !== "string" || input.workspaceDir.trim() === "") {
    throw new Error("workspaceDir is required");
  }

  const rollId = normalizeRollId(input.rollId);
  const { candidates, totalWeight } = normalizeCandidates(input.candidates);
  const randomSource: RandomSource = input.rng ? "injected" : "crypto";
  const sample = input.rng ? input.rng() : cryptoSample();
  assertValidSample(sample);

  const selectedCandidate = selectCandidate(candidates, totalWeight, sample);
  const result: RollChoiceResult = {
    rollId,
    selectedId: selectedCandidate.id,
    selectedCandidate,
    sample,
    randomSource,
  };

  await appendRandomLog(input.storyId, input.workspaceDir, result, candidates);
  return result;
}

function normalizeRollId(raw: string): string {
  if (typeof raw !== "string") throw new Error("rollId is required");
  const rollId = raw.trim();
  if (!rollId) throw new Error("rollId is required");
  return rollId;
}

function normalizeCandidates(raw: RollChoiceCandidate[]): NormalizedCandidates {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error("candidates must be a non-empty array");
  }

  const ids = new Set<string>();
  let totalWeight = 0;
  const candidates = raw.map((candidate) => {
    if (typeof candidate.id !== "string" || candidate.id.trim() === "") {
      throw new Error("candidate id is required");
    }
    const id = candidate.id.trim();
    if (ids.has(id)) throw new Error(`duplicate candidate id: ${id}`);
    ids.add(id);

    if (
      typeof candidate.weight !== "number" ||
      !Number.isFinite(candidate.weight) ||
      candidate.weight <= 0
    ) {
      throw new Error(`candidate weight must be a finite positive number: ${id}`);
    }

    if (candidate.label !== undefined && typeof candidate.label !== "string") {
      throw new Error(`candidate label must be a string when provided: ${id}`);
    }

    totalWeight += candidate.weight;
    return {
      id,
      ...(candidate.label !== undefined ? { label: candidate.label } : {}),
      weight: candidate.weight,
    };
  });

  if (!Number.isFinite(totalWeight) || totalWeight <= 0) {
    throw new Error("totalWeight must be a finite positive number");
  }

  return { candidates, totalWeight };
}

function assertValidSample(sample: number): void {
  if (
    typeof sample !== "number" ||
    !Number.isFinite(sample) ||
    sample < 0 ||
    sample >= 1
  ) {
    throw new Error("rng sample must be a finite number in [0, 1)");
  }
}

function cryptoSample(): number {
  const bytes = crypto.randomBytes(6);
  return bytes.readUIntBE(0, 6) / 0x1000000000000;
}

function selectCandidate(
  candidates: RollChoiceCandidate[],
  totalWeight: number,
  sample: number,
): RollChoiceCandidate {
  if (candidates.length === 1) return candidates[0];

  const target = sample * totalWeight;
  let cumulative = 0;
  for (const candidate of candidates) {
    cumulative += candidate.weight;
    if (target < cumulative) return candidate;
  }
  return candidates[candidates.length - 1];
}

async function appendRandomLog(
  storyId: string,
  workspaceDir: string,
  result: RollChoiceResult,
  candidates: RollChoiceCandidate[],
): Promise<void> {
  const logsDir = path.join(workspaceDir, "logs");
  const logPath = path.join(logsDir, RANDOM_ROLLS_LOG);
  const line = JSON.stringify({
    at: new Date().toISOString(),
    storyId,
    rollId: result.rollId,
    type: "roll-choice",
    candidates,
    selectedId: result.selectedId,
    randomSource: result.randomSource,
    sample: result.sample,
  });

  try {
    await fs.mkdir(logsDir, { recursive: true });
    await fs.appendFile(logPath, line + "\n", "utf8");
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`failed to append random log: ${detail}`);
  }
}

/**
 * Generate private samples only after the complete candidate batch is fixed.
 * The runner retains them across generation retries; they never enter prompts.
 */
export function generateRollPool(size: number, rng?: RollChoiceRng): number[] {
  const n = Math.max(0, Math.floor(size));
  const pool: number[] = [];
  for (let i = 0; i < n; i++) {
    const sample = rng ? rng() : cryptoSample();
    assertValidSample(sample);
    pool.push(sample);
  }
  return pool;
}

export interface PoolRollRecordInput {
  storyId: string;
  workspaceDir: string;
  rollId: string;
  /** 来自服务端预生成池的样本值（服务端持有，模型不可自选） */
  sample: number;
  candidates: RollChoiceCandidate[];
  /** 模型申报结果；调用方必须在提交前拒绝与绑定结果不一致的确认。 */
  declaredSelectedId?: string;
}

export interface PoolRollRecordResult {
  result: RollChoiceResult;
  /** 申报结果 ≠ 权威重算结果 */
  mismatch: boolean;
}

/**
 * 服务端权威落账一次池判定：用自己持有的池样本重算加权选择（与
 * rollChoice 完全同一算法），写入与 claude 路径同形状的审计日志行——
 * orchestrator 的随机日志泄密守卫（readRandomRollLines）无需感知路径差异。
 *
 * PiRunner 在候选冻结、结果绑定、确认一致后调用本函数。日志由服务端
 * 写入；自然语言是否服从结果仍需要行为验收。
 */
export async function recordPoolRoll(input: PoolRollRecordInput): Promise<PoolRollRecordResult> {
  const recorded = resolvePoolRoll(input);
  await appendRandomLog(input.storyId, input.workspaceDir, recorded.result, normalizeCandidates(input.candidates).candidates);
  return recorded;
}

/** Resolve a previously fixed candidate list without writing an audit entry. */
export function resolvePoolRoll(input: PoolRollRecordInput): PoolRollRecordResult {
  if (!isValidStoryId(input.storyId)) {
    throw new Error("invalid storyId");
  }
  if (typeof input.workspaceDir !== "string" || input.workspaceDir.trim() === "") {
    throw new Error("workspaceDir is required");
  }
  const rollId = normalizeRollId(input.rollId);
  const { candidates, totalWeight } = normalizeCandidates(input.candidates);
  assertValidSample(input.sample);

  const selectedCandidate = selectCandidate(candidates, totalWeight, input.sample);
  const result: RollChoiceResult = {
    rollId,
    selectedId: selectedCandidate.id,
    selectedCandidate,
    sample: input.sample,
    randomSource: "pool",
  };
  return {
    result,
    mismatch: input.declaredSelectedId !== undefined && input.declaredSelectedId !== selectedCandidate.id,
  };
}
