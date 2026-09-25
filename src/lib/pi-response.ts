import type { TurnInteraction } from "./interaction-schema";
import { MAX_STATE_UPDATE_CHARS, parseStateUpdate } from "./state-update";
import { MAX_TURN_OUTPUT_CHARS, TURN_OUTPUT_HEADING } from "./turn-output";

/** Maximum text retained from one Pi assistant response. */
export const MAX_PI_RESPONSE_CHARS = 1_048_576;
/** State bundles are useful diagnostics, but must not become an unbounded sink. */
export const MAX_RESPONSE_STATE_UPDATE_CHARS = MAX_STATE_UPDATE_CHARS;
/** A JSON event has a small envelope around the one-megabyte response text. */
const MAX_EVENT_LINE_CHARS = 2 * 1024 * 1024;
/** Keep malformed stdout from becoming a second, unbounded input channel. */
const MAX_RESPONSE_INPUT_CHARS = 4 * 1024 * 1024;

export type PiTurnResponse = {
  kind: "turn";
  output: string;
  interaction: TurnInteraction;
  stateUpdate: string;
};

export type PiRollRequestResponse = {
  kind: "roll-request";
  rolls: unknown[];
};

export type PiTurnResponseValue = PiTurnResponse | PiRollRequestResponse;

export type { TurnInteraction } from "./interaction-schema";

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function fail(reason: string): never {
  throw new Error(`invalid Pi response: ${reason}`);
}

function hasExactlyKeys(value: UnknownRecord, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

/**
 * Parse one complete JSON value. Pi sometimes wraps its final text in a
 * Markdown JSON fence; accepting only the complete fence prevents a prose
 * prefix/suffix from being silently stripped.
 */
export function parseResponseJson(raw: string): unknown {
  if (typeof raw !== "string") fail("response text must be a string");
  const source = raw.trim();
  if (source === "") fail("response text is empty");
  if (source.length > MAX_RESPONSE_INPUT_CHARS) fail("response text is too large");

  let json = source;
  if (source.startsWith("```")) {
    const match = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/i.exec(source);
    if (!match) fail("JSON fence must contain exactly one complete value");
    json = match[1].trim();
    if (json === "") fail("JSON fence is empty");
  }

  try {
    return JSON.parse(json) as unknown;
  } catch {
    fail("response is not valid JSON");
  }
}

/** Strict parser shared by response consumers and scene/render paths. */
export function parseResponseInteraction(value: unknown): TurnInteraction {
  if (!isRecord(value) || !hasExactlyKeys(value, ["mode", "suggestions"])) {
    fail("interaction keys are invalid");
  }
  if (value.mode !== "continue" && value.mode !== "decision") {
    fail("interaction mode is invalid");
  }
  if (!Array.isArray(value.suggestions) || value.suggestions.length > 4) {
    fail("interaction suggestions must contain 0-4 items");
  }

  for (const suggestion of value.suggestions) {
    if (
      typeof suggestion !== "string" ||
      suggestion.trim() === "" ||
      suggestion.length > 120
    ) {
      fail("interaction suggestion is invalid");
    }
  }

  return {
    mode: value.mode,
    suggestions: [...value.suggestions],
  };
}

/** Strict player-visible output validation shared by turn and render paths. */
export function parseResponseOutput(value: unknown): string {
  if (typeof value !== "string") fail("turn output must be a string");
  if (value.length === 0 || value.length > MAX_TURN_OUTPUT_CHARS) {
    fail("turn output length is invalid");
  }
  const outputLines = value.split("\n");
  if (outputLines[0]?.trim() !== TURN_OUTPUT_HEADING) {
    fail(`turn output must start with ${TURN_OUTPUT_HEADING}`);
  }
  if (outputLines.slice(1).join("\n").trim() === "") {
    fail("turn output body is empty");
  }
  return value;
}

/** Accept legacy Markdown state updates and canonicalize strict JSON bundles. */
export function parseResponseStateUpdate(value: unknown): string {
  if (typeof value === "string") {
    if (value.trim() === "" || value.length > MAX_STATE_UPDATE_CHARS) {
      fail("state update is invalid");
    }
    return value;
  }
  if (!isRecord(value)) fail("state update must be a string or object");

  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    fail("state update object is not serializable");
  }
  if (serialized.length > MAX_STATE_UPDATE_CHARS) {
    fail("state update is too large");
  }
  const parsed = parseStateUpdate(serialized);
  if (parsed.problems.length > 0) {
    fail("structured state update is invalid");
  }
  return serialized;
}

function parseTurn(value: UnknownRecord): PiTurnResponse {
  if (!hasExactlyKeys(value, ["kind", "output", "interaction", "stateUpdate"])) {
    fail("turn response keys are invalid");
  }
  if (value.kind !== "turn") fail("response kind is invalid");
  const output = parseResponseOutput(value.output);

  const stateUpdate = parseResponseStateUpdate(value.stateUpdate);

  return {
    kind: "turn",
    output,
    interaction: parseResponseInteraction(value.interaction),
    stateUpdate,
  };
}

function parseRollRequest(value: UnknownRecord): PiRollRequestResponse {
  if (!hasExactlyKeys(value, ["kind", "rolls"])) fail("roll request keys are invalid");
  if (value.kind !== "roll-request") fail("response kind is invalid");
  if (!Array.isArray(value.rolls) || value.rolls.length < 1 || value.rolls.length > 6) {
    fail("roll request must contain 1-6 rolls");
  }

  // Candidate semantics (ids, weights, duplicates, etc.) belong to the
  // authoritative bindTurnRolls boundary. This parser only owns the envelope.
  return { kind: "roll-request", rolls: [...value.rolls] };
}

/** Parse and strictly validate the complete model response envelope. */
export function parseTurnResponse(raw: string): PiTurnResponseValue {
  const parsed = parseResponseJson(raw);
  if (!isRecord(parsed) || typeof parsed.kind !== "string") {
    fail("response must be a JSON object with a kind");
  }
  if (parsed.kind === "turn") return parseTurn(parsed);
  if (parsed.kind === "roll-request") return parseRollRequest(parsed);
  fail("response kind is unknown");
}

type EventResult =
  | { kind: "ignore" }
  | { kind: "valid"; text: string }
  | { kind: "invalid"; reason: string };

const KNOWN_STOP_REASONS = new Set(["length", "error", "aborted", "toolUse", "stop"]);

function safeStopReason(value: unknown): string {
  return typeof value === "string" && KNOWN_STOP_REASONS.has(value) ? value : "unknown";
}

function looksLikeMessageEnd(line: string): boolean {
  // Only a JSON-object-looking line can be a malformed terminal event. A
  // diagnostic sentence that happens to mention `message_end` is still a
  // non-event line and may be ignored.
  return /^\s*\{/.test(line) && /"type"\s*:\s*"message_end"/.test(line);
}

/** Extract only the final assistant message; partial events never enter here. */
function inspectEvent(event: unknown): EventResult {
  if (!isRecord(event) || event.type !== "message_end") return { kind: "ignore" };

  const message = event.message;
  if (!isRecord(message) || message.role !== "assistant") {
    // Pi also emits the original user message as message_end. It is not a
    // candidate response and must not poison an otherwise valid assistant end.
    return { kind: "ignore" };
  }
  if (message.stopReason !== "stop") {
    return {
      kind: "invalid",
      reason: "assistant message did not stop normally (stopReason=" + safeStopReason(message.stopReason) + ")",
    };
  }
  if (!Array.isArray(message.content)) {
    return { kind: "invalid", reason: "assistant message content is invalid" };
  }

  let text = "";
  for (const block of message.content) {
    if (!isRecord(block) || typeof block.type !== "string") {
      return { kind: "invalid", reason: "assistant content block is invalid" };
    }
    if (block.type === "thinking") continue;
    if (block.type !== "text") {
      // This includes toolCall/tool_use and any future block type. Failing
      // closed avoids turning a tool-bearing answer into a normal response.
      return { kind: "invalid", reason: "assistant response contains a non-text block" };
    }
    if (typeof block.text !== "string") {
      return { kind: "invalid", reason: "assistant text block is invalid" };
    }
    text += block.text;
    if (text.length > MAX_PI_RESPONSE_CHARS) {
      return { kind: "invalid", reason: "assistant response is too large" };
    }
  }

  if (text.trim() === "") return { kind: "invalid", reason: "assistant response has no text" };
  return { kind: "valid", text };
}

interface EventAccumulator {
  assistantTerminalSeen: boolean;
  text: string | null;
  failure: string | null;
}

function consumeLine(accumulator: EventAccumulator, line: string): void {
  if (typeof line !== "string") return;
  if (line.length > MAX_EVENT_LINE_CHARS) {
    if (looksLikeMessageEnd(line)) {
      accumulator.assistantTerminalSeen = true;
      accumulator.failure ??= "message_end event is too large";
    }
    return;
  }

  let event: unknown;
  try {
    event = JSON.parse(line) as unknown;
  } catch {
    if (looksLikeMessageEnd(line)) {
      accumulator.assistantTerminalSeen = true;
      accumulator.failure ??= "message_end event is malformed";
    }
    // Diagnostics and other non-event lines are deliberately ignored.
    return;
  }

  const result = inspectEvent(event);
  if (result.kind === "ignore") return;
  if (accumulator.assistantTerminalSeen) {
    accumulator.failure ??= "multiple assistant message_end events";
    return;
  }
  accumulator.assistantTerminalSeen = true;
  if (result.kind === "invalid") {
    accumulator.failure ??= result.reason;
    return;
  }
  accumulator.text = result.text;
}

function consumeStdout(accumulator: EventAccumulator, stdout: string): void {
  // The process seam already supplies a bounded stdout tail. Keep a second
  // limit here for direct callers and tests that pass untrusted diagnostics.
  if (typeof stdout !== "string") {
    accumulator.failure ??= "stdout must be a string";
    return;
  }
  if (stdout.length > MAX_RESPONSE_INPUT_CHARS) {
    accumulator.failure ??= "stdout is too large";
    return;
  }
  for (const line of stdout.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    consumeLine(accumulator, line);
  }
}

export interface PiResponseCollector {
  onLine(line: string): void;
  finish(stdout: string): string;
}

/**
 * Collect Pi's final message through the line callback. The callback is the
 * authoritative path for large responses; stdout is only a bounded fallback
 * for tests and runtimes that do not wire the callback.
 */
export function createPiResponseCollector(): PiResponseCollector {
  const callback: EventAccumulator = {
    assistantTerminalSeen: false,
    text: null,
    failure: null,
  };
  let finishedText: string | null = null;
  let finishedFailure: string | null = null;

  return {
    onLine(line: string): void {
      if (finishedText !== null || finishedFailure !== null) return;
      consumeLine(callback, line);
    },

    finish(stdout: string): string {
      if (finishedText !== null) return finishedText;
      if (finishedFailure !== null) fail(finishedFailure);

      if (callback.failure !== null) {
        finishedFailure = callback.failure;
        fail(finishedFailure);
      }
      if (callback.text !== null) {
        finishedText = callback.text;
        return finishedText;
      }

      const fallback: EventAccumulator = {
        assistantTerminalSeen: false,
        text: null,
        failure: null,
      };
      consumeStdout(fallback, stdout);
      if (fallback.failure !== null) {
        finishedFailure = fallback.failure;
        fail(finishedFailure);
      }
      if (fallback.text === null) {
        finishedFailure = "complete assistant message_end response is missing";
        fail(finishedFailure);
      }
      finishedText = fallback.text;
      return finishedText;
    },
  };
}
