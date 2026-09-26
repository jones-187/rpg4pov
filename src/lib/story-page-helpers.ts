import type { TurnHistoryEntry } from "./turn-history";

export function canRetryLatestTurn(
  historyLength: number,
  loading: boolean,
  hasQueuedInput: boolean,
): boolean {
  return historyLength > 1 && !loading && !hasQueuedInput;
}

export function replaceLatestTurn(
  history: TurnHistoryEntry[],
  replacement: TurnHistoryEntry,
): TurnHistoryEntry[] {
  if (history.length === 0) return history;
  return [...history.slice(0, -1), replacement];
}
