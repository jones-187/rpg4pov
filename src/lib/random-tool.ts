import { promises as fs } from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { isValidStoryId } from "./workspace";

export const RANDOM_ROLLS_LOG = "random-rolls.jsonl";

export type RandomSource = "crypto" | "injected";

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
