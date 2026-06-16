import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

let savedRoot: string | undefined;

export async function useTempWorkspaceRoot(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rpg4pov-ws-"));
  savedRoot = process.env.WORKSPACE_ROOT;
  const root = path.join(dir, "workspaces");
  await fs.mkdir(root, { recursive: true });
  process.env.WORKSPACE_ROOT = root;
  return root;
}

export function resetWorkspaceRoot(): void {
  if (savedRoot === undefined) {
    delete process.env.WORKSPACE_ROOT;
  } else {
    process.env.WORKSPACE_ROOT = savedRoot;
  }
}
