import { promises as fs } from "node:fs";
import path from "node:path";
import {
  isValidStoryId,
  resolveSnapshotsRoot,
  resolveWorkspaceDir,
  resolveWorkspaceRoot,
} from "./workspace";
import type { BoundTurnRoll } from "./turn-rolls";

export interface TurnRetryCheckpoint {
  turnId: string;
  playerInput: string;
  runnerInput: string;
  historyInput: string;
  replayRolls: BoundTurnRoll[];
}

function retryRoot(): string {
  return path.resolve(resolveWorkspaceRoot(), ".turn-retry");
}

function checkpointDir(storyId: string): string {
  if (!isValidStoryId(storyId)) throw new Error("invalid storyId");
  return path.join(retryRoot(), storyId);
}

/** Preserve the pre-turn snapshot only after the new turn has fully validated. */
export async function saveTurnRetryCheckpoint(
  storyId: string,
  metadata: TurnRetryCheckpoint,
): Promise<void> {
  const source = path.join(resolveSnapshotsRoot(), storyId);
  const destination = checkpointDir(storyId);
  const temporary = `${destination}.tmp`;
  await fs.rm(temporary, { recursive: true, force: true });
  await fs.mkdir(temporary, { recursive: true });
  await fs.cp(source, path.join(temporary, "workspace"), { recursive: true });
  await fs.writeFile(
    path.join(temporary, "metadata.json"),
    `${JSON.stringify(metadata, null, 2)}\n`,
  );
  await fs.rm(destination, { recursive: true, force: true });
  await fs.rename(temporary, destination);
}

export async function readTurnRetryCheckpoint(
  storyId: string,
): Promise<TurnRetryCheckpoint | null> {
  if (!isValidStoryId(storyId)) return null;
  try {
    const raw = await fs.readFile(path.join(checkpointDir(storyId), "metadata.json"), "utf8");
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (
      typeof value.turnId !== "string" ||
      typeof value.playerInput !== "string" ||
      typeof value.runnerInput !== "string" ||
      typeof value.historyInput !== "string" ||
      !Array.isArray(value.replayRolls)
    ) {
      throw new Error("turn retry metadata is invalid");
    }
    return {
      turnId: value.turnId,
      playerInput: value.playerInput,
      runnerInput: value.runnerInput,
      historyInput: value.historyInput,
      replayRolls: value.replayRolls as BoundTurnRoll[],
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** Convert random audit lines appended by the committed turn into frozen bindings. */
export function parseReplayRolls(lines: string[]): BoundTurnRoll[] {
  return lines.map((line, offset) => {
    const value = JSON.parse(line) as Record<string, unknown>;
    if (
      !["pool", "crypto", "injected"].includes(String(value.randomSource)) ||
      typeof value.rollId !== "string" ||
      typeof value.sample !== "number" ||
      typeof value.selectedId !== "string" ||
      !Array.isArray(value.candidates)
    ) {
      throw new Error("retry random binding is invalid");
    }
    return {
      index: offset + 1,
      rollId: value.rollId,
      sample: value.sample,
      selectedId: value.selectedId,
      candidates: value.candidates as BoundTurnRoll["candidates"],
    };
  });
}

/** Replace the live workspace with the exact state before the latest turn. */
export async function restoreTurnRetryCheckpoint(storyId: string): Promise<void> {
  const source = path.join(checkpointDir(storyId), "workspace");
  const workspace = resolveWorkspaceDir(storyId);
  await fs.access(source);
  await fs.rm(workspace, { recursive: true, force: true });
  await fs.cp(source, workspace, { recursive: true });
}
