import { promises as fs } from "node:fs";
import path from "node:path";
import { isValidStoryId, resolveWorkspaceDir } from "./workspace";
import { sanitizeTurnInteraction, DEFAULT_TURN_INTERACTION } from "./interaction-schema";

/**
 * Turn Interaction（Issue 10）：回合结束后的交互状态。
 * 由回合 agent 写入 turn/interaction.json，Web 只返回 sanitize 后的内容。
 * mode：
 * - "continue"：连续演出阶段——尚未到达真正需要玩家决定的位置（无建议）
 * - "decision"：决策点——需要玩家判断，可附 0-4 条建议
 *
 * 纯 schema/净化规则在 interaction-schema.ts（客户端共用）。
 */

export type { TurnInteraction, InteractionMode } from "./interaction-schema";
export {
  sanitizeTurnInteraction,
  DEFAULT_TURN_INTERACTION,
  MAX_SUGGESTIONS,
} from "./interaction-schema";

function resolveInteractionPath(storyId: string): string {
  return path.join(resolveWorkspaceDir(storyId), "turn", "interaction.json");
}

/**
 * 读取当前交互状态（Issue 10：刷新后恢复 continue/decision 状态与建议）。
 * 文件缺失、JSON 非法或结构不合法一律降级为 DEFAULT_TURN_INTERACTION——
 * 交互状态缺失不应让故事不可玩，也不影响回合成败。
 */
export async function readTurnInteraction(
  storyId: string,
): Promise<import("./interaction-schema").TurnInteraction> {
  if (!isValidStoryId(storyId)) return DEFAULT_TURN_INTERACTION;
  try {
    const raw = await fs.readFile(resolveInteractionPath(storyId), "utf8");
    const parsed = sanitizeTurnInteraction(JSON.parse(raw));
    return parsed ?? DEFAULT_TURN_INTERACTION;
  } catch {
    return DEFAULT_TURN_INTERACTION;
  }
}

/**
 * 读取 interaction.json 的原始压缩行，供输出隔离校验当外泄指纹用
 * （Issue 12 扩展：interaction metadata 不得逐字出现在 output.md）。
 * 文件不存在返回 null。
 */
export async function readTurnInteractionRawLine(storyId: string): Promise<string | null> {
  if (!isValidStoryId(storyId)) return null;
  try {
    const raw = await fs.readFile(resolveInteractionPath(storyId), "utf8");
    const compact = JSON.stringify(JSON.parse(raw));
    return typeof compact === "string" && compact.length > 0 ? compact : null;
  } catch {
    return null;
  }
}
