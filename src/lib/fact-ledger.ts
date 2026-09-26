/**
 * Experimental read-only fact ledger adapter.
 *
 * The ledger is deliberately narrow: it validates explicit JSON facts and
 * renders them as model-readable context. It does not infer facts, repair
 * data, or become a production default.
 */
export type FactLedgerSource = "player" | "model" | "system";
export type FactLedgerVisibility = "public" | "private";
export type FactEventKind = "event" | "unknown-cause" | "open-decision";

export interface FactEvent {
  id: string;
  kind: FactEventKind;
  text: string;
  source: FactLedgerSource;
  time: string;
  location: string;
  witnesses: string[];
  visibility: FactLedgerVisibility;
  causedBy: string[];
}

export interface FactKnowledgeBoundary {
  id: string;
  holders: string[];
}

export interface FactLedger {
  version: string;
  events: FactEvent[];
  knowledgeBoundaries: FactKnowledgeBoundary[];
}

export const FACT_LEDGER_VERSION = "1";
export const FACT_LEDGER_MAX_EVENTS = 64;
export const FACT_LEDGER_MAX_KNOWLEDGE_BOUNDARIES = 64;
export const FACT_LEDGER_MAX_STRING_LENGTH = 512;
export const FACT_LEDGER_MAX_LIST_ITEMS = 16;

const SOURCES: readonly FactLedgerSource[] = ["player", "model", "system"];
const VISIBILITIES: readonly FactLedgerVisibility[] = ["public", "private"];
const EVENT_KINDS: readonly FactEventKind[] = ["event", "unknown-cause", "open-decision"];

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

function parseFactEvent(
  rawEvent: unknown,
  field: string,
  seenEventIds: Set<string>,
  seenBoundaryIds: Set<string>,
  allowedCauseIds: Set<string>,
): FactEvent {
  if (!isRecord(rawEvent)) {
    throw new Error(`fact ledger: ${field} must be an object`);
  }
  const allowed = [
    "id", "kind", "text", "source", "time", "location", "witnesses", "visibility", "causedBy",
  ];
  if (Object.keys(rawEvent).some((key) => !allowed.includes(key))) {
    throw new Error(`fact ledger: ${field} contains unexpected fields`);
  }

  const id = requireString(rawEvent.id, `${field}.id`);
  if (seenBoundaryIds.has(id)) {
    throw new Error(`fact ledger: ${field}.id conflicts with boundary id ${id}`);
  }
  if (seenEventIds.has(id)) {
    throw new Error(`fact ledger: duplicate event id ${id}`);
  }

  const causedBy = requireStringList(rawEvent.causedBy, `${field}.causedBy`);
  for (const causeId of causedBy) {
    if (!allowedCauseIds.has(causeId)) {
      throw new Error(`fact ledger: ${field}.causedBy references later or unknown event ${causeId}`);
    }
  }
  seenEventIds.add(id);

  const witnesses = requireStringList(rawEvent.witnesses, `${field}.witnesses`);
  const visibility = requireLiteral(rawEvent.visibility, `${field}.visibility`, VISIBILITIES);
  if (visibility === "private" && witnesses.length === 0) {
    throw new Error(`fact ledger: ${field} is private and must have at least one witness`);
  }

  return {
    id,
    kind: rawEvent.kind === undefined
      ? "event"
      : requireLiteral(rawEvent.kind, `${field}.kind`, EVENT_KINDS),
    text: requireString(rawEvent.text, `${field}.text`),
    source: requireLiteral(rawEvent.source, `${field}.source`, SOURCES),
    time: requireString(rawEvent.time, `${field}.time`),
    location: requireString(rawEvent.location, `${field}.location`),
    witnesses,
    visibility,
    causedBy,
  };
}

function parseKnowledgeBoundary(
  rawBoundary: unknown,
  field: string,
  seenBoundaryIds: Set<string>,
  seenEventIds: Set<string>,
  allowExistingBoundaryIds: boolean,
): FactKnowledgeBoundary {
  if (!isRecord(rawBoundary)) {
    throw new Error(`fact ledger: ${field} must be an object`);
  }
  if (Object.keys(rawBoundary).some((key) => !["id", "holders"].includes(key))) {
    throw new Error(`fact ledger: ${field} contains unexpected fields`);
  }

  const id = requireString(rawBoundary.id, `${field}.id`);
  if (seenEventIds.has(id)) {
    throw new Error(`fact ledger: ${field}.id conflicts with event id ${id}`);
  }
  if (seenBoundaryIds.has(id) && !allowExistingBoundaryIds) {
    throw new Error(`fact ledger: duplicate boundary id ${id}`);
  }

  const holders = requireStringList(rawBoundary.holders, `${field}.holders`);
  if (holders.length === 0) {
    throw new Error(`fact ledger: ${field}.holders must have at least one holder`);
  }
  seenBoundaryIds.add(id);
  return { id, holders: [...holders].sort() };
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
  if (Object.keys(value).some((key) => !["version", "events", "knowledgeBoundaries"].includes(key))) {
    throw new Error("fact ledger: root contains unexpected fields");
  }

  const seenEventIds = new Set<string>();
  const seenBoundaryIds = new Set<string>();
  const events = value.events.map((rawEvent, index) =>
    parseFactEvent(
      rawEvent,
      `events[${index}]`,
      seenEventIds,
      seenBoundaryIds,
      new Set(seenEventIds),
    ),
  );

  if (value.knowledgeBoundaries !== undefined && !Array.isArray(value.knowledgeBoundaries)) {
    throw new Error("fact ledger: knowledgeBoundaries must be an array");
  }
  if (value.knowledgeBoundaries !== undefined && value.knowledgeBoundaries.length > FACT_LEDGER_MAX_KNOWLEDGE_BOUNDARIES) {
    throw new Error(`fact ledger: knowledgeBoundaries exceed ${FACT_LEDGER_MAX_KNOWLEDGE_BOUNDARIES}`);
  }
  const knowledgeBoundaries = (value.knowledgeBoundaries ?? []).map((rawBoundary, index) =>
    parseKnowledgeBoundary(
      rawBoundary,
      `knowledgeBoundaries[${index}]`,
      seenBoundaryIds,
      seenEventIds,
      false,
    ),
  );

  return { version, events, knowledgeBoundaries };
}

interface FactLedgerUpdateCandidate {
  version: string;
  appendEvents: FactEvent[];
  upsertKnowledgeBoundaries: FactKnowledgeBoundary[];
  resolve: Array<{ id: string; evidenceIds: string[] }>;
  retireIds: string[];
}

function parseFactLedgerUpdateCandidate(
  value: unknown,
  currentEventIds: Set<string>,
  currentBoundaryIds: Set<string>,
): FactLedgerUpdateCandidate {
  if (!isRecord(value)) {
    throw new Error("fact ledger update: root must be an object");
  }
  const requiredFields = [
    "version", "appendEvents", "upsertKnowledgeBoundaries", "resolve", "retireIds",
  ];
  if (Object.keys(value).some((key) => !requiredFields.includes(key))) {
    throw new Error("fact ledger update: root contains unexpected fields");
  }
  for (const key of requiredFields) {
    if (value[key] === undefined) {
      throw new Error(`fact ledger update: ${key} is required`);
    }
  }
  if (value.version !== FACT_LEDGER_VERSION) {
    throw new Error(`fact ledger update: unsupported version ${String(value.version)}`);
  }
  if (!Array.isArray(value.appendEvents)) {
    throw new Error("fact ledger update: appendEvents must be an array");
  }
  if (!Array.isArray(value.upsertKnowledgeBoundaries)) {
    throw new Error("fact ledger update: upsertKnowledgeBoundaries must be an array");
  }
  if (!Array.isArray(value.resolve)) {
    throw new Error("fact ledger update: resolve must be an array");
  }
  if (!Array.isArray(value.retireIds)) {
    throw new Error("fact ledger update: retireIds must be an array");
  }

  const retireIds = value.retireIds.map((rawId, index) => {
    const id = requireString(rawId, `fact ledger update: retireIds[${index}]`);
    if (!currentEventIds.has(id) && !currentBoundaryIds.has(id)) {
      throw new Error(`fact ledger update: retire id ${id} does not exist`);
    }
    return id;
  });
  if (new Set(retireIds).size !== retireIds.length) {
    throw new Error("fact ledger update: retireIds contains duplicate values");
  }
  const removedIds = new Set(retireIds);

  const resolvedIds = new Set<string>();
  const resolve = value.resolve.map((rawResolution, index) => {
    if (!isRecord(rawResolution)
      || Object.keys(rawResolution).some((key) => !["id", "evidenceIds"].includes(key))) {
      throw new Error(`fact ledger update: resolve[${index}] must contain only id and evidenceIds`);
    }
    const id = requireString(rawResolution.id, `fact ledger update: resolve[${index}].id`);
    if (!currentEventIds.has(id)) {
      throw new Error(`fact ledger update: resolve id ${id} does not exist`);
    }
    if (resolvedIds.has(id)) throw new Error(`fact ledger update: duplicate resolve id ${id}`);
    if (removedIds.has(id)) throw new Error(`fact ledger update: id ${id} cannot be resolved and retired`);
    const evidenceIds = requireStringList(
      rawResolution.evidenceIds,
      `fact ledger update: resolve[${index}].evidenceIds`,
    );
    if (evidenceIds.length === 0) {
      throw new Error(`fact ledger update: resolve[${index}].evidenceIds must not be empty`);
    }
    resolvedIds.add(id);
    removedIds.add(id);
    return { id, evidenceIds };
  });

  const seenBoundaryIds = new Set(currentBoundaryIds);
  const upsertedBoundaryIds = new Set<string>();
  const upsertKnowledgeBoundaries = value.upsertKnowledgeBoundaries.map((rawBoundary, index) => {
    const boundary = parseKnowledgeBoundary(
      rawBoundary,
      `fact ledger update: upsertKnowledgeBoundaries[${index}]`,
      seenBoundaryIds,
      currentEventIds,
      true,
    );
    if (upsertedBoundaryIds.has(boundary.id)) {
      throw new Error(`fact ledger update: duplicate upsert boundary id ${boundary.id}`);
    }
    if (removedIds.has(boundary.id)) {
      throw new Error(`fact ledger update: cannot upsert and retire boundary ${boundary.id}`);
    }
    upsertedBoundaryIds.add(boundary.id);
    seenBoundaryIds.add(boundary.id);
    return boundary;
  });

  const seenEventIds = new Set(currentEventIds);
  const allowedCauseIds = new Set(
    [...currentEventIds].filter((id) => !removedIds.has(id)),
  );
  const appendEvents = value.appendEvents.map((rawEvent, index) => {
    const event = parseFactEvent(
      rawEvent,
      `fact ledger update: appendEvents[${index}]`,
      seenEventIds,
      seenBoundaryIds,
      allowedCauseIds,
    );
    if (event.visibility !== "public") {
      throw new Error(`fact ledger update: appendEvents[${index}].visibility must be public`);
    }
    allowedCauseIds.add(event.id);
    return event;
  });

  return {
    version: value.version,
    appendEvents,
    upsertKnowledgeBoundaries,
    resolve,
    retireIds,
  };
}

export function applyFactLedgerUpdate(
  current: FactLedger,
  candidate: unknown,
): FactLedger {
  const parsedCurrent = parseFactLedger(current);
  const currentEventIds = new Set(parsedCurrent.events.map((event) => event.id));
  const currentBoundaryIds = new Set(
    parsedCurrent.knowledgeBoundaries.map((boundary) => boundary.id),
  );
  const parsedCandidate = parseFactLedgerUpdateCandidate(
    candidate,
    currentEventIds,
    currentBoundaryIds,
  );

  const currentById = new Map(parsedCurrent.events.map((event) => [event.id, event]));
  const removedIds = new Set(parsedCandidate.retireIds);
  for (const retireId of parsedCandidate.retireIds) {
    const event = currentById.get(retireId);
    if (event && event.kind !== "event") {
      throw new Error(`fact ledger update: unresolved id ${retireId} must be resolved with evidence`);
    }
  }
  for (const resolution of parsedCandidate.resolve) {
    const target = currentById.get(resolution.id);
    if (target?.kind !== "unknown-cause" && target?.kind !== "open-decision") {
      throw new Error(`fact ledger update: resolve id ${resolution.id} is not unresolved`);
    }
    for (const evidenceId of resolution.evidenceIds) {
      const evidence = currentById.get(evidenceId)
        ?? parsedCandidate.appendEvents.find((event) => event.id === evidenceId);
      if (!evidence || evidence.visibility !== "public" || removedIds.has(evidenceId)
        || parsedCandidate.resolve.some((item) => item.id === evidenceId)) {
        throw new Error(`fact ledger update: evidence id ${evidenceId} is not a retained public event`);
      }
    }
    removedIds.add(resolution.id);
  }
  const finalEvents = [
    ...parsedCurrent.events
      .filter((event) => !removedIds.has(event.id))
      .map((event) => ({ ...event, witnesses: [...event.witnesses], causedBy: [...event.causedBy] })),
    ...parsedCandidate.appendEvents.map((event) => ({
      ...event,
      witnesses: [...event.witnesses],
      causedBy: [...event.causedBy],
    })),
  ];

  const finalBoundaries = parsedCurrent.knowledgeBoundaries
    .filter((boundary) => !removedIds.has(boundary.id))
    .map((boundary) => ({ ...boundary, holders: [...boundary.holders] }));
  for (const boundary of parsedCandidate.upsertKnowledgeBoundaries) {
    const index = finalBoundaries.findIndex((existing) => existing.id === boundary.id);
    const normalized = { ...boundary, holders: [...boundary.holders] };
    if (index === -1) {
      finalBoundaries.push(normalized);
    } else {
      finalBoundaries[index] = normalized;
    }
  }

  return parseFactLedger({
    version: parsedCurrent.version,
    events: finalEvents,
    knowledgeBoundaries: finalBoundaries,
  });
}

function quote(value: string): string {
  return JSON.stringify(value);
}

function renderKnowledgeBoundary(holders: string[], renderedBoundaries: Set<string>): string {
  const normalizedHolders = [...holders].sort();
  const boundaryKey = normalizedHolders.join("\u0000");
  if (!renderedBoundaries.has(boundaryKey)) {
    renderedBoundaries.add(boundaryKey);
    return [
      "知识边界=",
      `仅以下角色掌握未公开事实：${normalizedHolders.join("、") || "未标明"}；`,
      "其他角色不得表现出知道该事实，也不得用相关话题暗示。",
    ].join("");
  }
  return "";
}

/** Render a validated ledger as compact, read-only model context. */
export function renderFactLedger(ledger: FactLedger): string {
  if (ledger.events.length === 0 && ledger.knowledgeBoundaries.length === 0) {
    return "（无事件）";
  }
  const privacyById = new Map<string, { restricted: boolean; holders: string[] }>();
  const rendered: string[] = [];
  const renderedKnowledgeBoundaries = new Set<string>();

  for (const boundary of ledger.knowledgeBoundaries) {
    const renderedBoundary = renderKnowledgeBoundary(
      boundary.holders,
      renderedKnowledgeBoundaries,
    );
    if (renderedBoundary !== "") rendered.push(renderedBoundary);
  }

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
      const renderedBoundary = renderKnowledgeBoundary(
        normalizedHolders,
        renderedKnowledgeBoundaries,
      );
      if (renderedBoundary !== "") rendered.push(renderedBoundary);
      continue;
    }

    const fields = [
      `id=${event.id}`,
      `kind=${event.kind}`,
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
