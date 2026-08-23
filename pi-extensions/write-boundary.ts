import { promises as fs } from "node:fs";
import path from "node:path";

const ALLOWED_WRITE_PATHS = new Set([
  "turn/output.md",
  "turn/interaction.json",
  "turn/state-update.md",
]);

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
 * Validate a write target before Pi executes the tool. This intentionally
 * accepts only the three literal POSIX-relative paths; manifest validation
 * remains the post-execution defense in depth.
 */
export async function validatePiWriteTarget(
  cwd: string,
  candidatePath: unknown,
): Promise<PiWriteBoundaryDecision> {
  if (typeof candidatePath !== "string") {
    return { allowed: false, reason: "write path must be a string" };
  }
  if (!ALLOWED_WRITE_PATHS.has(candidatePath)) {
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
  api.on("tool_call", async (event, context) => {
    if (event.toolName !== "write") return undefined;
    const input = isRecord(event.input) ? event.input : undefined;
    const decision = await validatePiWriteTarget(context.cwd, input?.path);
    return decision.allowed ? undefined : { block: true, reason: decision.reason };
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
