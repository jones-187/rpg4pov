/**
 * Turn Interaction 的纯 schema 层（Issue 10）。
 * 不依赖 node:fs —— 客户端组件与服务端（turn-interaction.ts）共用同一份净化规则，
 * 避免两端语义漂移。fs 读写留在 turn-interaction.ts。
 */

export type InteractionMode = "continue" | "decision";

export interface TurnInteraction {
  mode: InteractionMode;
  suggestions: string[];
}

/** 缺失/格式错误/不合法时的降级默认（Issue 10 降级处理）。 */
export const DEFAULT_TURN_INTERACTION: TurnInteraction = {
  mode: "continue",
  suggestions: [],
};

/** Suggestion Gate：建议数量上限（Issue 10：0-4 条）。超出截断，不整体降级。 */
export const MAX_SUGGESTIONS = 4;

/** 单条建议长度上限：建议只填入输入框，应是短句不是段落。超长丢弃该条。 */
export const MAX_SUGGESTION_CHARS = 120;

/**
 * 净化并校验 interaction 数据（来源不可信——agent 写的文件 / API 响应）。
 * mode 非法返回 null（调用方降级到默认值）；建议逐条过滤非法项并截断到上限——
 * 决策点状态本身合法时不应因个别建议不合法而整体退化为连续演出。
 * 额外字段一律丢弃（Issue 12：元数据不外泄）。
 */
export function sanitizeTurnInteraction(value: unknown): TurnInteraction | null {
  if (value === null || typeof value !== "object") return null;
  const v = value as { mode?: unknown; suggestions?: unknown };
  if (v.mode !== "continue" && v.mode !== "decision") return null;

  const suggestions: string[] = [];
  if (v.suggestions !== undefined) {
    if (!Array.isArray(v.suggestions)) return null;
    for (const raw of v.suggestions) {
      if (typeof raw !== "string") continue;
      const s = raw.trim();
      if (s === "" || s.length > MAX_SUGGESTION_CHARS) continue;
      suggestions.push(s);
      if (suggestions.length >= MAX_SUGGESTIONS) break;
    }
  }

  return { mode: v.mode, suggestions };
}
