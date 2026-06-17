import { promises as fs } from "node:fs";
import path from "node:path";
import { isValidStoryId, resolveWorkspaceDir, resolveSnapshotsRoot } from "./workspace";

/**
 * 整目录回合快照（Issue 4）。
 * 快照存放在 Story Workspace 之外（{WORKSPACE_ROOT}/.snapshots/{storyId}/）。
 * 不是故事状态——见 CONTEXT.md「Turn Snapshot」。存活期不超过一次回合。
 */

function resolveSnapshotDir(storyId: string): string {
  if (!isValidStoryId(storyId)) throw new Error("invalid storyId");
  return path.resolve(resolveSnapshotsRoot(), storyId);
}

/**
 * 创建整目录快照（覆盖上一份）。
 * 在 lock 之后、clearTurnDone 之前调用——捕获"本回合开始前的完整提交态"。
 */
export async function createSnapshot(storyId: string): Promise<void> {
  const src = resolveWorkspaceDir(storyId);
  const dest = resolveSnapshotDir(storyId);
  // 清掉旧快照再拷，确保 dest 是 src 的精确镜像
  await fs.rm(dest, { recursive: true, force: true });
  await fs.mkdir(resolveSnapshotsRoot(), { recursive: true });
  await fs.cp(src, dest, { recursive: true });
}

/**
 * 从快照整目录恢复 workspace。
 * 先清空目标 workspace（rm -rf），再从快照拷回。
 * fs.cp 默认不删目标多余文件，不清空会导致 runner 新增的文件残留——回滚不干净。
 */
export async function restoreSnapshot(storyId: string): Promise<void> {
  const snap = resolveSnapshotDir(storyId);
  const ws = resolveWorkspaceDir(storyId);
  // 快照必须存在，否则是编排逻辑错误
  await fs.access(snap);
  await fs.rm(ws, { recursive: true, force: true });
  await fs.cp(snap, ws, { recursive: true });
}

/**
 * 删除本次快照。成功回合结束 / 失败 restore 完成后调用。
 * best-effort：删除失败不抛（调用方记内部日志即可，不影响用户响应）。
 */
export async function deleteSnapshot(storyId: string): Promise<void> {
  await fs.rm(resolveSnapshotDir(storyId), { recursive: true, force: true });
}

/**
 * 写入 workspace unsafe marker。
 * 当 restoreSnapshot 失败时调用——workspace 可能已损坏（半成品状态），
 * 后续回合检测到此 marker 时应拒绝执行，提示需人工处理。
 * best-effort：写入失败不抛。
 */
export async function markWorkspaceUnsafe(
  storyId: string,
  reason: string,
): Promise<void> {
  try {
    if (!isValidStoryId(storyId)) return;
    const markerPath = path.join(resolveWorkspaceDir(storyId), ".workspace-unsafe");
    const content = JSON.stringify({
      at: new Date().toISOString(),
      reason,
    });
    await fs.writeFile(markerPath, content);
  } catch {
    // best-effort：workspace 本身可能已不可写
  }
}

/**
 * 检查 workspace 是否被标记为 unsafe。
 * TurnOrchestrator 在回合开始前检查；route 层也可检查。
 * 返回标记内容（含 reason）或 null（安全）。
 */
export async function readWorkspaceUnsafeMarker(
  storyId: string,
): Promise<{ at: string; reason: string } | null> {
  try {
    if (!isValidStoryId(storyId)) return null;
    const raw = await fs.readFile(
      path.join(resolveWorkspaceDir(storyId), ".workspace-unsafe"),
      "utf8",
    );
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as Record<string, unknown>).at === "string" &&
      typeof (parsed as Record<string, unknown>).reason === "string"
    ) {
      return parsed as { at: string; reason: string };
    }
    return null;
  } catch {
    return null;
  }
}
