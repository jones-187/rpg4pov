import { promises as fs } from "node:fs";
import crypto from "node:crypto";
import path from "node:path";

/** A filesystem entry captured for an init attempt write boundary. */
export interface WorkspaceManifestEntry {
  kind: "file" | "directory" | "symlink" | "other";
  fingerprint: string;
}

export type WorkspaceManifest = ReadonlyMap<string, WorkspaceManifestEntry>;

/**
 * Capture every file and directory below a workspace without following
 * symlinks. File contents, metadata, and link targets are fingerprinted so a
 * same-sized rewrite is still visible to the caller.
 */
export async function captureWorkspaceManifest(workspaceDir: string): Promise<WorkspaceManifest> {
  const entries = new Map<string, WorkspaceManifestEntry>();

  async function visit(directory: string, relativeDirectory: string): Promise<void> {
    const children = await fs.readdir(directory, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      const absolute = path.join(directory, child.name);
      const relative = relativeDirectory
        ? `${relativeDirectory}/${child.name}`
        : child.name;

      if (child.isDirectory()) {
        const stat = await fs.stat(absolute);
        entries.set(relative, {
          kind: "directory",
          fingerprint: `${stat.mode}:${stat.uid}:${stat.gid}`,
        });
        await visit(absolute, relative);
        continue;
      }

      if (child.isFile()) {
        const stat = await fs.stat(absolute);
        const content = await fs.readFile(absolute);
        const digest = crypto.createHash("sha256").update(content).digest("hex");
        entries.set(relative, {
          kind: "file",
          fingerprint: [
            stat.mode,
            stat.size,
            stat.mtimeMs,
            stat.ctimeMs,
            digest,
          ].join(":"),
        });
        continue;
      }

      if (child.isSymbolicLink()) {
        const target = await fs.readlink(absolute);
        entries.set(relative, { kind: "symlink", fingerprint: target });
        continue;
      }

      const stat = await fs.lstat(absolute);
      entries.set(relative, {
        kind: "other",
        fingerprint: [stat.mode, stat.size, stat.mtimeMs, stat.ctimeMs].join(":"),
      });
    }
  }

  await visit(workspaceDir, "");
  return entries;
}

/**
 * Return a concise description of the first unauthorized workspace change.
 * Changes to an explicitly allowed candidate path are ignored; every other
 * add, delete, type change, or fingerprint change is a boundary violation.
 */
export function findUnauthorizedWorkspaceChange(
  before: WorkspaceManifest,
  after: WorkspaceManifest,
  allowedPaths: readonly string[],
): string | null {
  const allowed = new Set(allowedPaths);
  const paths = new Set<string>([...before.keys(), ...after.keys()]);

  for (const relative of [...paths].sort()) {
    const previous = before.get(relative);
    const current = after.get(relative);
    if (allowed.has(relative)) {
      // Candidate files may be replaced or removed during an attempt, but a
      // candidate path must never turn into a directory/symlink escape.
      if (!current || current.kind === "file") continue;
      return `modified ${relative}`;
    }
    if (!previous && current) return `created ${relative}`;
    if (previous && !current) return `deleted ${relative}`;
    if (previous && current && (previous.kind !== current.kind || previous.fingerprint !== current.fingerprint)) {
      return `modified ${relative}`;
    }
  }
  return null;
}
