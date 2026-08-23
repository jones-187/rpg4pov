import { promises as fs } from "node:fs";
import path from "node:path";

const ALL_WRITE_PATHS = [
  "turn/output.md",
  "turn/interaction.json",
  "turn/state-update.md",
] as const;
const ALL_WRITE_PATHS_SET = new Set<string>(ALL_WRITE_PATHS);

export type PiWriteBoundaryDecision =
  | { allowed: true }
  | { allowed: false; reason: string };

export interface PiToolCallEvent {
  toolName: string;
  input: unknown;
}

export interface PiExtensionContext {
  cwd: string;
}

export type PiToolCallBlock = { block: true; reason: string };
export type PiToolCallHandler = (
  event: PiToolCallEvent,
  context: PiExtensionContext,
) => Promise<PiToolCallBlock | undefined>;

export interface PiExtensionApi {
  on(event: "tool_call", handler: PiToolCallHandler): void;
}

/**
 * Parse the runner-injected phase allowlist. The extension deliberately has
 * no permissive default: a Pi child must receive a known, non-empty list.
 */
export function parsePiWriteAllowlist(raw: unknown): readonly string[] | null {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  const paths = raw.split(",").map((entry) => entry.trim());
  if (paths.length === 0 || paths.some((entry) => !entry || !ALL_WRITE_PATHS_SET.has(entry))) {
    return null;
  }
  if (new Set(paths).size !== paths.length) return null;
  return paths;
}

/**
 * Validate a write target before Pi executes the tool. This intentionally
 * accepts only the three literal POSIX-relative paths; manifest validation
 * remains the post-execution defense in depth.
 */
export async function validatePiWriteTarget(
  cwd: string,
  candidatePath: unknown,
  allowedPaths: readonly string[] = ALL_WRITE_PATHS,
): Promise<PiWriteBoundaryDecision> {
  if (!isValidAllowlist(allowedPaths)) {
    return { allowed: false, reason: "write allowlist is missing or invalid" };
  }
  if (typeof candidatePath !== "string") {
    return { allowed: false, reason: "write path must be a string" };
  }
  if (!allowedPaths.includes(candidatePath)) {
    return { allowed: false, reason: `write path is not an allowed candidate: ${candidatePath}` };
  }

  const workspace = path.resolve(cwd);
  const candidate = path.join(workspace, candidatePath);
  const parent = path.dirname(candidate);
  let workspaceReal: string;
  let parentReal: string;
  try {
    workspaceReal = await fs.realpath(workspace);
    parentReal = await fs.realpath(parent);
  } catch {
    return { allowed: false, reason: "write path parent is not a real workspace turn directory" };
  }
  if (parentReal !== path.join(workspaceReal, "turn")) {
    return { allowed: false, reason: "write path parent escapes the workspace turn directory" };
  }

  try {
    const stat = await fs.lstat(candidate);
    if (stat.isSymbolicLink()) {
      return { allowed: false, reason: "write candidate must not be a symlink" };
    }
    if (stat.isDirectory()) {
      return { allowed: false, reason: "write candidate must be a file, not a directory" };
    }
    if (!stat.isFile()) {
      return { allowed: false, reason: "write candidate must be a regular file" };
    }
  } catch (error) {
    if (!isNotFound(error)) {
      return { allowed: false, reason: "write candidate could not be inspected" };
    }
    // A missing candidate (especially the first state-update.md) is safe to
    // create under the already-real turn directory.
  }

  return { allowed: true };
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

/** Pi extension entrypoint: block unauthorized write calls before execution. */
export default function registerWriteBoundary(api: PiExtensionApi): void {
  const allowedPaths = parsePiWriteAllowlist(process.env.PI_WRITE_ALLOWED_PATHS);
  api.on("tool_call", async (event, context) => {
    if (event.toolName !== "write") return undefined;
    if (allowedPaths === null) {
      return { block: true, reason: "write allowlist is missing or invalid" };
    }
    const input = isRecord(event.input) ? event.input : undefined;
    const decision = await validatePiWriteTarget(context.cwd, input?.path, allowedPaths);
    return decision.allowed ? undefined : { block: true, reason: decision.reason };
  });
}

function isValidAllowlist(paths: readonly string[]): boolean {
  return (
    paths.length > 0 &&
    new Set(paths).size === paths.length &&
    paths.every((candidate) => ALL_WRITE_PATHS_SET.has(candidate))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
