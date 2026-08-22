import type { TurnInteraction } from "./interaction-schema";

/**
 * 回合进行时状态注册表（叙事先行显示的数据通道）。
 *
 * 数据流：PiRunner 解析 pi `--mode json` 事件流，在产物"组合完成"时点
 * （早于 pi 进程退出与服务端收尾）发布到这里 → turn-preview 轮询接口
 * 读取 → 前端提前显示；TurnOrchestrator 在回合终局（成功/失败）清空。
 * 进程内单例 Map——单容器单进程部署下即全局。
 *
 * 契约：这里的数据只是"提前读"的预览，永远不是权威。权威提交仍走
 * POST 响应里的 committed turn；回合最终失败/回滚时前端撤回预览。
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

const active = new Map<string, TurnProgress>();

/**
 * 发布进度。phase 回退到 "generating"（重试 attempt 重开）时清空已发布
 * 的产物预览——前端据此撤回已显示的叙事/选项。
 */
export function publishTurnProgress(
  storyId: string,
  patch: Partial<Omit<TurnProgress, "storyId" | "updatedAt">>,
): void {
  let next: TurnProgress;
  if (patch.phase === "generating") {
    next = { storyId, phase: "generating", updatedAt: Date.now() };
  } else {
    const prev = active.get(storyId);
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
  active.set(storyId, next);
}

export function readTurnProgress(storyId: string): TurnProgress | null {
  return active.get(storyId) ?? null;
}

export function clearTurnProgress(storyId: string): void {
  active.delete(storyId);
}
