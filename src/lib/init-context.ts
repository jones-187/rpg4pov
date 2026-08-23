import { promises as fs } from "node:fs";
import path from "node:path";

/** Files whose complete scaffold text is pre-injected for either init runner. */
export const INIT_SKELETON_FILES = ["story.md", "world.md", "player.md", "rules.md"] as const;

/**
 * Read the shared initialization scaffold context. Missing files retain the
 * same explicit marker used by both Claude and Pi prompt builders.
 */
export async function readInitSkeletonContext(workspaceDir: string): Promise<string> {
  const parts: string[] = [];
  for (const file of INIT_SKELETON_FILES) {
    let content: string;
    try {
      content = (await fs.readFile(path.join(workspaceDir, file), "utf8")).trimEnd();
    } catch {
      content = "（不存在）";
    }
    parts.push(`=== ${file} ===\n${content}`);
  }
  return parts.join("\n\n");
}
