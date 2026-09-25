import { promises as fs } from "node:fs";
import path from "node:path";
import { parsePublicSceneFromPlayer, type PublicScene } from "./public-scene";

export { parsePublicScene, parsePublicSceneFromPlayer } from "./public-scene";
export type { PublicScene, PublicSceneActor } from "./public-scene";

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

/**
 * Read the explicit public-scene hand-off used by the opening phase.
 *
 * Only the validated JSON object from player.md crosses this boundary. This
 * is data-region isolation, not a claim that the model-authored strings are
 * semantically free of secrets.
 */
export async function readInitOpeningContext(workspaceDir: string): Promise<string> {
  let player: string;
  try {
    player = await fs.readFile(path.join(workspaceDir, "player.md"), "utf8");
  } catch {
    throw new Error("player.md is required for the public opening context");
  }
  const scene: PublicScene = parsePublicSceneFromPlayer(player);
  return JSON.stringify(scene);
}
