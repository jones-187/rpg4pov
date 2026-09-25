/**
 * Experimental read-only fact ledger adapter.
 *
 * The ledger is deliberately narrow: it validates explicit JSON facts and
 * renders them as model-readable context. It does not infer facts, repair
 * data, or become a production default.
 */
export type FactLedgerSource = "player" | "model" | "system";
export type FactLedgerVisibility = "public" | "private";

export interface FactEvent {
  id: string;
  text: string;
  source: FactLedgerSource;
  time: string;
  location: string;
  witnesses: string[];
  visibility: FactLedgerVisibility;
  causedBy: string[];
}

export interface FactLedger {
  version: string;
  events: FactEvent[];
}

export const FACT_LEDGER_VERSION = "1";
export const FACT_LEDGER_MAX_EVENTS = 64;
export const FACT_LEDGER_MAX_STRING_LENGTH = 512;
export const FACT_LEDGER_MAX_LIST_ITEMS = 16;

const SOURCES: readonly FactLedgerSource[] = ["player", "model", "system"];
const VISIBILITIES: readonly FactLedgerVisibility[] = ["public", "private"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(
  value: unknown,
  field: string,
): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`fact ledger: ${field} must be a non-empty string`);
  }
  if (value.length > FACT_LEDGER_MAX_STRING_LENGTH) {
    throw new Error(
      `fact ledger: ${field} exceeds ${FACT_LEDGER_MAX_STRING_LENGTH} characters`,
    );
  }
  return value;
}

function requireStringList(
  value: unknown,
  field: string,
): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`fact ledger: ${field} must be an array`);
  }
  if (value.length > FACT_LEDGER_MAX_LIST_ITEMS) {
    throw new Error(`fact ledger: ${field} exceeds ${FACT_LEDGER_MAX_LIST_ITEMS} items`);
  }
  const result = value.map((item, index) => {
    if (typeof item !== "string" || item.length === 0) {
      throw new Error(`fact ledger: ${field}[${index}] must be a non-empty string`);
    }
    if (item.length > FACT_LEDGER_MAX_STRING_LENGTH) {
      throw new Error(
        `fact ledger: ${field}[${index}] exceeds ${FACT_LEDGER_MAX_STRING_LENGTH} characters`,
      );
    }
    return item;
  });
  if (new Set(result).size !== result.length) {
    throw new Error(`fact ledger: ${field} contains duplicate values`);
  }
  return result;
}

function requireLiteral<T extends string>(
  value: unknown,
  field: string,
  allowed: readonly T[],
): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new Error(`fact ledger: ${field} must be one of ${allowed.join(", ")}`);
  }
  return value as T;
}

/** Parse and strictly validate unknown JSON. Invalid data always throws. */
export function parseFactLedger(value: unknown): FactLedger {
  if (!isRecord(value)) {
    throw new Error("fact ledger: root must be an object");
  }

  const version = requireString(value.version, "version");
  if (version !== FACT_LEDGER_VERSION) {
    throw new Error(`fact ledger: unsupported version ${version}`);
  }

  if (!Array.isArray(value.events)) {
    throw new Error("fact ledger: events must be an array");
  }
  if (value.events.length > FACT_LEDGER_MAX_EVENTS) {
    throw new Error(`fact ledger: events exceed ${FACT_LEDGER_MAX_EVENTS}`);
  }
  if (Object.keys(value).some((key) => !["version", "events"].includes(key))) {
    throw new Error("fact ledger: root contains unexpected fields");
  }

  const seenIds = new Set<string>();
  const events = value.events.map((rawEvent, index) => {
    const field = `events[${index}]`;
    if (!isRecord(rawEvent)) {
      throw new Error(`fact ledger: ${field} must be an object`);
    }
    const allowed = [
      "id", "text", "source", "time", "location", "witnesses", "visibility", "causedBy",
    ];
    if (Object.keys(rawEvent).some((key) => !allowed.includes(key))) {
      throw new Error(`fact ledger: ${field} contains unexpected fields`);
    }

    const id = requireString(rawEvent.id, `${field}.id`);
    if (seenIds.has(id)) throw new Error(`fact ledger: duplicate event id ${id}`);

    const causedBy = requireStringList(rawEvent.causedBy, `${field}.causedBy`);
    for (const causeId of causedBy) {
      if (!seenIds.has(causeId)) {
        throw new Error(`fact ledger: ${field}.causedBy references later or unknown event ${causeId}`);
      }
    }
    seenIds.add(id);

    const witnesses = requireStringList(rawEvent.witnesses, `${field}.witnesses`);
    const visibility = requireLiteral(rawEvent.visibility, `${field}.visibility`, VISIBILITIES);
    if (visibility === "private" && witnesses.length === 0) {
      throw new Error(`fact ledger: ${field} is private and must have at least one witness`);
    }

    return {
      id,
      text: requireString(rawEvent.text, `${field}.text`),
      source: requireLiteral(rawEvent.source, `${field}.source`, SOURCES),
      time: requireString(rawEvent.time, `${field}.time`),
      location: requireString(rawEvent.location, `${field}.location`),
      witnesses,
      visibility,
      causedBy,
    };
  });

  return { version, events };
}

function quote(value: string): string {
  return JSON.stringify(value);
}

/** Render a validated ledger as compact, read-only model context. */
export function renderFactLedger(ledger: FactLedger): string {
  if (ledger.events.length === 0) return "（无事件）";
  const privacyById = new Map<string, { restricted: boolean; holders: string[] }>();
  const rendered: string[] = [];
  const renderedKnowledgeBoundaries = new Set<string>();

  for (const event of ledger.events) {
    const restrictedCauses = event.causedBy
      .map((causeId) => privacyById.get(causeId))
      .filter((cause): cause is { restricted: true; holders: string[] } => cause?.restricted === true);
    const restricted = event.visibility === "private" || restrictedCauses.length > 0;
    const holders = event.witnesses.length > 0
      ? [...event.witnesses]
      : [...new Set(restrictedCauses.flatMap((cause) => cause.holders))];
    const normalizedHolders = [...holders].sort();
    privacyById.set(event.id, { restricted, holders: normalizedHolders });

    if (restricted) {
      const boundaryKey = normalizedHolders.join("\u0000");
      if (!renderedKnowledgeBoundaries.has(boundaryKey)) {
        renderedKnowledgeBoundaries.add(boundaryKey);
        rendered.push([
          "知识边界=",
          `仅以下角色掌握未公开事实：${normalizedHolders.join("、") || "未标明"}；`,
          "其他角色不得表现出知道该事实，也不得用相关话题暗示。",
        ].join(""));
      }
      continue;
    }

    const fields = [
      `id=${event.id}`,
      `text=${event.text}`,
      `source=${event.source}`,
      `time=${event.time}`,
      `location=${event.location}`,
      `witnesses=${event.witnesses.join(" | ") || "none"}`,
      `visibility=${event.visibility}`,
      `causedBy=${event.causedBy.join(" | ") || "none"}`,
    ];
    rendered.push(fields.map(quote).join(" "));
  }

  return rendered.join("\n");
}
