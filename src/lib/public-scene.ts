/**
 * The small, explicit hand-off from initialization to the opening narrator.
 * This schema separates the data region that is allowed into the opening
 * prompt; it does not prove that the text itself is semantically leak-free.
 */

export interface PublicSceneActor {
  name: string;
  appearance: string;
  voice: string;
}

export interface PublicScene {
  time: string;
  location: string;
  narrativeVoice: string;
  knownFacts: string[];
  visibleActors: PublicSceneActor[];
}

/** Keep a malformed model output from becoming an unbounded prompt. */
export const MAX_PUBLIC_SCENE_STRING_LENGTH = 2_000;
export const MAX_PUBLIC_SCENE_FACTS = 20;
export const MAX_PUBLIC_SCENE_ACTORS = 20;

const PUBLIC_SCENE_KEYS = [
  "time",
  "location",
  "narrativeVoice",
  "knownFacts",
  "visibleActors",
] as const;

const PUBLIC_SCENE_ACTOR_KEYS = ["name", "appearance", "voice"] as const;

/**
 * Extract and validate the single `## Public Scene` section in player.md.
 * The section body is either one JSON object or one `json` fenced block.
 */
export function parsePublicSceneFromPlayer(raw: string): PublicScene {
  if (typeof raw !== "string") throw new Error("player.md must be text");

  const lines = raw.replace(/\r\n?/gu, "\n").split("\n");
  const headings = lines
    .map((line, index) => {
      const match = line.match(/^\s*(#{1,6})\s+(.+?)\s*$/u);
      return match
        ? { index, level: match[1]?.length ?? 0, title: match[2]?.trim() ?? "" }
        : null;
    })
    .filter((heading): heading is { index: number; level: number; title: string } => heading !== null);
  const publicTitleHeadings = headings.filter((heading) => heading.title === "Public Scene");
  const publicHeadings = publicTitleHeadings.filter((heading) => heading.level === 2);
  if (publicTitleHeadings.length !== 1 || publicHeadings.length !== 1) {
    throw new Error("player.md requires exactly one ## Public Scene section");
  }

  const heading = publicHeadings[0];
  if (!heading) throw new Error("player.md requires exactly one ## Public Scene section");
  const nextSection = headings.find(
    (candidate) => candidate.index > heading.index && candidate.level <= heading.level,
  );
  const body = lines.slice(heading.index + 1, nextSection?.index ?? lines.length).join("\n").trim();
  if (body === "") throw new Error("Public Scene section must contain one JSON object");

  const jsonText = extractPublicSceneJson(body);
  let value: unknown;
  try {
    value = JSON.parse(jsonText) as unknown;
  } catch {
    throw new Error("Public Scene section must contain valid JSON");
  }
  return parsePublicScene(value);
}

/** Validate an already decoded public scene without silently dropping fields. */
export function parsePublicScene(value: unknown): PublicScene {
  if (!isRecord(value) || Array.isArray(value)) {
    throw new Error("Public Scene must be a JSON object");
  }
  assertExactKeys(value, PUBLIC_SCENE_KEYS, "Public Scene");

  const time = parseText(value.time, "Public Scene.time");
  const location = parseText(value.location, "Public Scene.location");
  const narrativeVoice = parseText(value.narrativeVoice, "Public Scene.narrativeVoice");
  const knownFacts = parseTextArray(value.knownFacts, "Public Scene.knownFacts", MAX_PUBLIC_SCENE_FACTS);
  const visibleActors = parseActors(value.visibleActors);

  return { time, location, narrativeVoice, knownFacts, visibleActors };
}

function extractPublicSceneJson(body: string): string {
  const lines = body.split("\n");
  const first = lines[0]?.trim() ?? "";
  if (!first.startsWith("```")) return body;

  if (!/^```json[ \t]*$/iu.test(first) || lines.length < 3) {
    throw new Error("Public Scene permits only one ```json fenced block");
  }
  const last = lines[lines.length - 1]?.trim() ?? "";
  if (last !== "```") throw new Error("Public Scene JSON fence is not closed");
  const inner = lines.slice(1, -1);
  if (inner.some((line) => line.trim().startsWith("```"))) {
    throw new Error("Public Scene permits only one JSON fenced block");
  }
  const json = inner.join("\n").trim();
  if (json === "") throw new Error("Public Scene section must contain one JSON object");
  return json;
}

function parseActors(value: unknown): PublicSceneActor[] {
  if (!Array.isArray(value) || value.length > MAX_PUBLIC_SCENE_ACTORS) {
    throw new Error(`Public Scene.visibleActors must contain 0-${MAX_PUBLIC_SCENE_ACTORS} actors`);
  }
  const actors: PublicSceneActor[] = [];
  for (let index = 0; index < value.length; index++) {
    const actor = value[index];
    if (!isRecord(actor) || Array.isArray(actor)) {
      throw new Error(`Public Scene.visibleActors[${index}] must be an object`);
    }
    assertExactKeys(actor, PUBLIC_SCENE_ACTOR_KEYS, `Public Scene.visibleActors[${index}]`);
    actors.push({
      name: parseText(actor.name, `Public Scene.visibleActors[${index}].name`),
      appearance: parseText(actor.appearance, `Public Scene.visibleActors[${index}].appearance`),
      voice: parseText(actor.voice, `Public Scene.visibleActors[${index}].voice`),
    });
  }
  return actors;
}

function parseTextArray(value: unknown, label: string, max: number): string[] {
  if (!Array.isArray(value) || value.length > max) {
    throw new Error(`${label} must contain 0-${max} strings`);
  }
  const values: string[] = [];
  for (let index = 0; index < value.length; index++) {
    values.push(parseText(value[index], `${label}[${index}]`));
  }
  return values;
}

function parseText(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  if (value.trim() === "") throw new Error(`${label} must not be empty`);
  if (value.length > MAX_PUBLIC_SCENE_STRING_LENGTH) {
    throw new Error(`${label} exceeds ${MAX_PUBLIC_SCENE_STRING_LENGTH} characters`);
  }
  return value;
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const keys = Object.keys(value);
  if (keys.length !== expected.length || keys.some((key) => !expected.includes(key))) {
    throw new Error(`${label} has unknown or missing keys`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
