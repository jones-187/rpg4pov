import type { TurnInteraction } from "./interaction-schema";

/**
 * 回合进行时状态注册表（叙事先行显示的数据通道）。
 *
 * 数据流：PiRunner 解析 pi `--mode json` 事件流，在产物"组合完成"时点
 * （早于 pi 进程退出与服务端收尾）发布到这里 → turn-preview 轮询接口
 * 读取 → 前端提前显示；TurnOrchestrator 在回合终局（成功/失败）清空。
 * 进程内单例——单容器单进程部署下即全局。
 *
 * 契约：这里的数据只是"提前读"的预览，永远不是权威。权威提交仍走
 * POST 响应里的 committed turn；回合最终失败/回滚时前端撤回预览。
 *
 * 迟到发布防御：预览发布前要读盘跑泄密守卫（异步）。旧 attempt 的发布
 * 可能跨越"重试重开"或"回合终局清理"才落地——不防御的话它会推翻已发出
 * 的撤回信号，或在 clear 之后落成僵尸预览泄入下一回合的首次轮询。
 * 方案：每个 attempt 一个单调递增令牌（beginTurnAttempt 发放，handler
 * 闭包捕获），发布携带令牌、落后于当前值即丢弃；clear 亦推进令牌
 * （终局屏障），令牌永不回退。
 */

export type TurnPhase =
  | "generating"
  | "narrative-ready"
  | "interaction-ready";

export interface TurnProgress {
  storyId: string;
  phase: TurnPhase;
  /** 叙事预览原文（发布前已过 validateTurnOutput 泄密守卫） */
  narrative?: string;
  /** 交互建议预览（发布前已过 sanitizeTurnInteraction 净化） */
  interaction?: TurnInteraction;
  updatedAt: number;
}

interface TurnProgressRegistry {
  active: Map<string, TurnProgress>;
  attemptTokens: Map<string, number>;
}

// 单例必须挂在 globalThis：Next 构建可能把本模块复制进多个路由包
// （实测 story-turn 走共享 chunk、turn-preview 内联了只含 read 的副本），
// 模块级 Map 会变成两份，写入方与读取方各持一份、预览永远读不到。
const registryRoot = globalThis as typeof globalThis & {
  __rpg4povTurnProgress?: TurnProgressRegistry;
};
const registry: TurnProgressRegistry = (registryRoot.__rpg4povTurnProgress ??= {
  active: new Map(),
  attemptTokens: new Map(),
});

/**
 * 开启新 attempt：发放令牌并把相位发布为 generating（清空旧预览——
 * 前端据此撤回叙事显示回到等待态）。handler 闭包应捕获返回值，
 * 后续该 attempt 的所有发布必须携带此令牌。
 */
export function beginTurnAttempt(storyId: string): number {
  const token = (registry.attemptTokens.get(storyId) ?? 0) + 1;
  registry.attemptTokens.set(storyId, token);
  registry.active.set(storyId, { storyId, phase: "generating", updatedAt: Date.now() });
  return token;
}

/**
 * 发布进度。token 落后于当前值（迟到发布）直接丢弃。
 * phase 回退到 "generating" 时清空已发布的产物预览。
 */
export function publishTurnProgress(
  storyId: string,
  patch: Partial<Omit<TurnProgress, "storyId" | "updatedAt">>,
  token?: number,
): void {
  const current = registry.attemptTokens.get(storyId) ?? 0;
  if (token !== undefined && token < current) return;
  let next: TurnProgress;
  if (patch.phase === "generating") {
    next = { storyId, phase: "generating", updatedAt: Date.now() };
  } else {
    const prev = registry.active.get(storyId);
    next = {
      storyId,
      phase: patch.phase ?? prev?.phase ?? "generating",
      ...(patch.narrative !== undefined || prev?.narrative !== undefined
        ? { narrative: patch.narrative ?? prev?.narrative }
        : {}),
      ...(patch.interaction !== undefined || prev?.interaction !== undefined
        ? { interaction: patch.interaction ?? prev?.interaction }
        : {}),
      updatedAt: Date.now(),
    };
  }
  registry.active.set(storyId, next);
}

export function readTurnProgress(storyId: string): TurnProgress | null {
  return registry.active.get(storyId) ?? null;
}

export function clearTurnProgress(storyId: string): void {
  registry.active.delete(storyId);
  // 终局本身也是一道屏障：推进令牌，让最后一个 attempt 的迟到发布
  // （clear 之后才落地）同样被丢弃，不落成下一回合首次轮询的僵尸预览；
  // 下一回合 beginTurnAttempt 从新值 +1 继续单调递增
  registry.attemptTokens.set(storyId, (registry.attemptTokens.get(storyId) ?? 0) + 1);
}
