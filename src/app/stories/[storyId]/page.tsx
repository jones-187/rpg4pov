"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import {
  sanitizeTurnInteraction,
  DEFAULT_TURN_INTERACTION,
  type TurnInteraction,
} from "@/lib/interaction-schema";
import type { TurnProgress } from "@/lib/turn-progress";
import { canRetryLatestTurn, replaceLatestTurn } from "@/lib/story-page-helpers";

interface StoryMeta {
  storyId: string;
  title: string;
  createdAt: string;
  initialized: boolean;
}

interface TurnHistoryEntry {
  turnId: string;
  at: string;
  input: string;
  output: string;
}

/**
 * 打字机渐显（VN 质感）：叙事预览到达后逐字浮现，点击任意位置立即显示全部。
 * 只作用于预览；committed entry 全文直出（预览期已被读过，不重复动画）。
 */
function Typewriter({ text }: { text: string }) {
  // 3 字/50ms ≈ 60 字/秒：350 字叙事约 6 秒铺完，跟得上朗读节奏
  const charsPerTick = 3;
  const [shown, setShown] = useState(0);
  const done = shown >= text.length;
  useEffect(() => {
    setShown(0);
  }, [text]);
  useEffect(() => {
    if (done) return;
    const id = setInterval(() => {
      setShown((s) => Math.min(text.length, s + charsPerTick));
    }, 50);
    return () => clearInterval(id);
  }, [text, done, charsPerTick]);
  if (done) return <>{text}</>;
  return (
    <span
      role="presentation"
      onClick={() => setShown(text.length)}
      title="点击显示全部"
      style={{ cursor: "pointer" }}
    >
      {text.slice(0, shown)}
      <span className="tw-caret" aria-hidden="true">▌</span>
    </span>
  );
}

/** 校验响应体/GET 中的 interaction 字段，失败降级为默认连续演出态 */
function parseInteraction(data: unknown): TurnInteraction {
  return sanitizeTurnInteraction(data) ?? DEFAULT_TURN_INTERACTION;
}

/**
 * 规范化 output 内容：
 * 如果第一个非空行是 `# 主角视窗`，去掉该行及随后的空行。
 * UI 标题已负责展示"主角视窗"，避免重复。
 * 与校验器 src/lib/turn-output.ts 的"第一个非空行"规则对齐
 * （客户端组件不能 import turn-output——它会拉入 node:fs）。
 */
function normalizeOutput(output: string): string {
  const lines = output.split("\n");
  const headingIdx = lines.findIndex((line) => line.trim() !== "");
  if (headingIdx !== -1 && lines[headingIdx].trim() === "# 主角视窗") {
    // 去掉标题行及其前面的空白行；标题后若紧跟空行也去掉
    lines.splice(0, headingIdx + 1);
    if (lines[0]?.trim() === "") {
      lines.shift();
    }
  }
  return lines.join("\n");
}

/** 校验响应体中的 committed turn 结构，失败返回 null（Issue 7 起初始化与回合共用） */
function parseTurnResponse(data: unknown): TurnHistoryEntry | null {
  if (!data || typeof data !== "object") return null;
  const d = data as { playerResponse?: unknown; turn?: unknown };
  if (typeof d.playerResponse !== "string" || !d.turn || typeof d.turn !== "object") {
    return null;
  }
  const turn = d.turn as {
    turnId: unknown;
    at: unknown;
    input: unknown;
    output: unknown;
  };
  if (
    typeof turn.turnId !== "string" ||
    typeof turn.at !== "string" ||
    typeof turn.input !== "string" ||
    typeof turn.output !== "string"
  ) {
    return null;
  }
  return {
    turnId: turn.turnId,
    at: turn.at,
    input: turn.input,
    output: turn.output,
  };
}

/**
 * 提交等待期的阶段化反馈文案。回合产物经工具写盘一次性返回，无法真流式；
 * 阶段文案只描述正在发生的事（与实际执行阶段大致对齐，不做假进度承诺）。
 */
function pendingPhaseLabel(elapsedSec: number, initializing: boolean): string {
  if (initializing) {
    if (elapsedSec < 30) return "构建世界与人物…";
    if (elapsedSec < 75) return "铺陈开场与隐藏张力…";
    return "收束开场视窗…";
  }
  if (elapsedSec < 10) return "理解输入与当前局面…";
  if (elapsedSec < 25) return "推进人物与事件…";
  if (elapsedSec < 45) return "撰写主角视窗…";
  return "生成交互建议…";
}

export default function StoryPage() {
  const params = useParams<{ storyId: string }>();
  const storyId = params.storyId;

  const [title, setTitle] = useState<string>("");
  const [notFound, setNotFound] = useState<boolean>(false);
  const [initialized, setInitialized] = useState<boolean>(false);
  const [history, setHistory] = useState<TurnHistoryEntry[]>([]);
  const [interaction, setInteraction] = useState<TurnInteraction>(DEFAULT_TURN_INTERACTION);
  const [input, setInput] = useState<string>("");
  const [setting, setSetting] = useState<string>("");
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  // 感知延迟优化：提交起计时 + 每秒重渲染驱动阶段文案
  const [pendingSince, setPendingSince] = useState<number | null>(null);
  // 叙事先行预览：回合 pending 期间轮询 turn-preview，叙事/选项组合完成即先显示
  const [preview, setPreview] = useState<{ narrative?: string; interaction?: TurnInteraction } | null>(null);
  // 乐观回显：提交瞬间先显示"你"的输入（未提交态），落定后被 committed entry 取代
  const [pendingInput, setPendingInput] = useState<string | null>(null);
  // 预排队：等待期允许打好下一步，上一回合落定即自动发送（think/打字时间藏进生成时间）
  const [queuedInput, setQueuedInput] = useState<string | null>(null);
  const [retryOpen, setRetryOpen] = useState(false);
  const [retryCorrection, setRetryCorrection] = useState("");
  const [, setTick] = useState(0);

  useEffect(() => {
    if (pendingSince === null) return;
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [pendingSince]);

  // 预排队自动开火：上一回合落定（loading=false）且已有排队输入时立即发送。
  // 先清队列再提交、loading 同步置位，effect 依赖变化后条件即假——只开火一次
  useEffect(() => {
    if (loading || queuedInput === null || !initialized) return;
    const text = queuedInput;
    setQueuedInput(null);
    void submitTurnLike(
      "/api/story-turn",
      { storyId, input: text },
      { refill: refillIfEmpty, onSuccess: () => {}, pollPreview: true },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, queuedInput, initialized, storyId]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/stories/${storyId}`);
        if (res.status === 404) {
          if (!cancelled) setNotFound(true);
          return;
        }
        if (!res.ok) throw new Error(`加载失败（HTTP ${res.status}）`);
        const data = (await res.json()) as {
          story: StoryMeta;
          history: TurnHistoryEntry[];
          interaction?: unknown;
        };
        if (!cancelled) {
          setTitle(data.story.title);
          setInitialized(Boolean(data.story.initialized));
          setHistory(data.history);
          setInteraction(parseInteraction(data.interaction));
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "未知错误");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [storyId]);

  // 失败响应统一处理：带 retryInput 时回填输入框（Issue 4 模式）
  function applyErrorResponse(
    res: Response,
    data: unknown,
    refill: (text: string) => void,
  ) {
    if (data && typeof data === "object") {
      const retryInput = (data as { retryInput?: unknown }).retryInput;
      if (typeof retryInput === "string") refill(retryInput);
    }
    const errorMsg =
      data && typeof data === "object" && typeof (data as { error?: unknown }).error === "string"
        ? (data as { error: string }).error
        : `请求失败（HTTP ${res.status}）`;
    setError(errorMsg);
  }

  // 初始化与回合共用一条提交路径：POST → 校验 committed turn → 追加 history。
  // 差异只有 URL/payload 与 opts（回填/成功动作/是否轮询预览）。
  // pollPreview（回合路径）：pending 期间轮询 turn-preview，叙事组合完成
  // 即先显示（早于 POST 返回）；POST 落定后预览被 committed entry 取代，
  // 失败则撤回预览回到错误态。
  // 注意：onSuccess 里不做"清空输入框"——清空发生在各调用方提交的瞬间
  // （同步、用户意图明确）；落定时刻用户可能已在打下一步草稿。
  async function submitTurnLike(
    url: string,
    payload: Record<string, string>,
    opts: {
      refill: (text: string) => void;
      onSuccess: () => void;
      pollPreview?: boolean;
      historyMode?: "append" | "replace-latest";
      echoInput?: string;
    },
  ) {
    setLoading(true);
    setPendingSince(Date.now());
    setError(null);
    // 乐观回显：继续命令显示固定标签（与 committed history 的 label 一致）
    const echoText = opts.echoInput ??
      payload.input ?? (payload.command === "continue" ? "（继续）" : payload.setting) ?? "";
    setPendingInput(echoText !== "" ? echoText : null);
    let pollAlive = true;
    const pollPreview = async () => {
      try {
        const res = await fetch(`/api/stories/${storyId}/turn-preview`);
        if (!pollAlive || !res.ok) return;
        const data = (await res.json()) as {
          active?: boolean;
          phase?: TurnProgress["phase"];
          narrative?: string;
          interaction?: unknown;
        };
        if (!pollAlive || !data.active) return;
        if (data.phase === "generating") {
          // 重试重开：服务端已撤回预览，前端同步撤回
          setPreview(null);
          return;
        }
        setPreview({
          narrative: typeof data.narrative === "string" ? data.narrative : undefined,
          // 交互建议未到时不给默认值（默认值会被当成"已就绪"）
          ...(data.interaction !== undefined
            ? { interaction: parseInteraction(data.interaction) }
            : {}),
        });
      } catch {
        // 轮询失败静默——权威结果仍由 POST 返回
      }
    };
    if (opts.pollPreview) {
      void pollPreview();
    }
    const pollTimer = opts.pollPreview ? setInterval(pollPreview, 1000) : undefined;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        applyErrorResponse(res, data, opts.refill);
        return;
      }
      const turn = parseTurnResponse(data);
      if (!turn) {
        throw new Error("响应格式错误：缺少 committed turn");
      }
      setHistory((prev) => opts.historyMode === "replace-latest"
        ? replaceLatestTurn(prev, turn)
        : [...prev, turn]);
      // Issue 10：更新交互状态（缺失/不合法时降级为连续演出态）
      setInteraction(parseInteraction((data as { interaction?: unknown }).interaction));
      opts.onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : "未知错误");
    } finally {
      pollAlive = false;
      if (pollTimer) clearInterval(pollTimer);
      // 预览与回显的生命周期与回合一致：落定即撤（成功由 committed entry 取代，
      // 失败回到错误态——1/6 口述 flake 重试期间用户看到的预览会被收回）
      setPreview(null);
      setPendingInput(null);
      setLoading(false);
      setPendingSince(null);
    }
  }

  // 失败回填：仅当输入框为空时回填 retryInput——pending 期间用户可能已
  // 打好下一步草稿，无条件覆盖会吞掉它（错误信息仍照常展示）
  const refillIfEmpty = (text: string) => setInput((cur) => (cur.trim() === "" ? text : cur));

  // Issue 7：初始化——提交自然语言设定，开场视窗作为第一条 history entry 返回
  async function handleInitSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const text = setting.trim();
    if (!text || loading) return;
    await submitTurnLike(
      `/api/stories/${storyId}/initialize`,
      { setting: text },
      {
        refill: (t) => setSetting((cur) => (cur.trim() === "" ? t : cur)),
        onSuccess: () => {
          setInitialized(true);
          setSetting("");
        },
      },
    );
  }

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const text = input.trim();
    if (!text) return;
    // 等待期提交 → 预排队：上一回合落定即自动发送，think/打字时间藏进生成时间
    if (loading) {
      setQueuedInput(text);
      setInput("");
      return;
    }
    // 清空发生在提交瞬间（同步、用户意图明确）；onSuccess 不再清空——
    // 落定时用户可能已在打下一步草稿
    setInput("");
    await submitTurnLike(
      "/api/story-turn",
      { storyId, input: text },
      { refill: refillIfEmpty, onSuccess: () => {}, pollPreview: true },
    );
  }

  // Issue 10：系统级"继续"——让人物和事件自然发展，不是主角台词。
  async function handleContinue() {
    if (loading) return;
    await submitTurnLike("/api/story-turn", { storyId, command: "continue" }, {
      refill: () => {},
      onSuccess: () => {},
      pollPreview: true,
    });
  }

  async function handleRetryLatest() {
    if (!canRetryLatestTurn(history.length, loading, queuedInput !== null)) return;
    const latest = history.at(-1);
    if (!latest) return;
    const correction = retryCorrection.trim();
    await submitTurnLike("/api/story-turn", {
      storyId,
      command: "retry",
      ...(correction ? { correction } : {}),
    }, {
      refill: () => {},
      onSuccess: () => {
        setRetryOpen(false);
        setRetryCorrection("");
      },
      pollPreview: true,
      historyMode: "replace-latest",
      echoInput: latest.input,
    });
  }

  if (notFound) {
    return (
      <main className="container">
        <h1>故事不存在</h1>
        <p className="muted">找不到该 storyId。</p>
        <Link href="/" className="link">← 返回首页</Link>
      </main>
    );
  }

  return (
    <main className="container">
      <Link href="/" className="link">← 返回首页</Link>
      <h1>{title || "…"}</h1>

      <section className="story" aria-label="故事显示区">
        {history.length === 0 ? (
          initialized ? (
            <p className="muted">故事已初始化。在下方输入主角的第一回合行动，然后点击发送。</p>
          ) : (
            <p className="muted">故事已创建。先在下方输入故事设定完成初始化，然后开始第一回合。</p>
          )
        ) : (
          history.map((turn, index) => (
            <div key={turn.turnId} className="turn-entry">
              <div className="turn-input-block">
                <h3 className="turn-block-title">你</h3>
                <div className="turn-input-content">{turn.input}</div>
              </div>
              <div className="turn-output-block">
                <h3 className="turn-block-title">主角视窗</h3>
                <div className="turn-output-content">{normalizeOutput(turn.output)}</div>
              </div>
              {index === history.length - 1 && history.length > 1 && (
                <div className="turn-retry">
                  {!retryOpen ? (
                    <button
                      type="button"
                      className="turn-retry-link"
                      disabled={!canRetryLatestTurn(history.length, loading, queuedInput !== null)}
                      onClick={() => setRetryOpen(true)}
                    >
                      重写本回合
                    </button>
                  ) : (
                    <div className="turn-retry-editor">
                      <textarea
                        value={retryCorrection}
                        onChange={(event) => setRetryCorrection(event.target.value)}
                        placeholder="可选：指出这次哪里需要改正（不会记成主角行动）"
                        rows={2}
                        maxLength={2000}
                        disabled={loading}
                      />
                      <div className="turn-retry-actions">
                        <button type="button" disabled={loading} onClick={() => void handleRetryLatest()}>
                          {loading ? "重写中…" : "确认重写"}
                        </button>
                        <button type="button" disabled={loading} onClick={() => {
                          setRetryOpen(false);
                          setRetryCorrection("");
                        }}>
                          取消
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          ))
        )}
        {preview?.narrative || pendingInput !== null ? (
          <div className="turn-entry turn-entry-preview" aria-label="本回合进行中（预览未提交）">
            {pendingInput !== null && (
              <div className="turn-input-block">
                <h3 className="turn-block-title">你</h3>
                <div className="turn-input-content">{pendingInput}</div>
              </div>
            )}
            {preview?.narrative && (
              <div className="turn-output-block">
                <h3 className="turn-block-title">主角视窗</h3>
                <div className="turn-output-content">
                  <Typewriter text={normalizeOutput(preview.narrative)} />
                </div>
                {!preview.interaction && <p className="muted">生成交互建议…</p>}
              </div>
            )}
            {preview?.interaction?.mode === "decision" &&
              preview.interaction.suggestions.length > 0 && (
                <div className="suggestions" aria-label="交互建议预览（未提交）">
                  {preview.interaction.suggestions.map((s, i) => (
                    <button
                      key={`preview-${i}-${s}`}
                      type="button"
                      className="suggestion-chip"
                      onClick={() => setInput(s)}
                    >
                      {s}
                    </button>
                  ))}
                </div>
              )}
          </div>
        ) : null}
      </section>

      {!initialized ? (
        <form onSubmit={handleInitSubmit} className="input-form" aria-label="故事初始化">
          <textarea
            value={setting}
            onChange={(e) => setSetting(e.target.value)}
            placeholder="描述一个小场景设定：时间、地点、主角（可含角色卡）与其他人物…"
            rows={5}
            disabled={loading}
          />
          <button type="submit" disabled={loading || !setting.trim()}>
            {loading ? "初始化中…" : "初始化故事"}
          </button>
        </form>
      ) : (
        <>
          <form onSubmit={handleSubmit} className="input-form" aria-label="主角输入">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={
              loading ? "等待期间可先想好下一步，发送即自动排队…" : "输入主角的行动或台词…"
            }
            rows={4}
          />
          <button type="submit" disabled={!input.trim()}>
            {loading ? "排队发送" : "发送"}
          </button>
          {interaction.mode === "continue" && history.length > 0 && (
            <button type="button" onClick={handleContinue} disabled={loading}>
              继续
            </button>
          )}
        </form>
          {queuedInput !== null && (
            <p className="muted" aria-live="polite">
              已排队下一回合：{queuedInput}
            </p>
          )}
        </>
      )}
      {loading && pendingSince !== null && !preview?.narrative && (
        <p className="muted" aria-live="polite">
          {(() => {
            const elapsed = Math.floor((Date.now() - pendingSince) / 1000);
            return `${pendingPhaseLabel(elapsed, !initialized)}（已等待 ${elapsed} 秒）`;
          })()}
        </p>
      )}
      {initialized && interaction.mode === "decision" && interaction.suggestions.length > 0 && (
        <div className="suggestions" aria-label="建议选项">
          {interaction.suggestions.map((s, i) => (
            <button key={`${i}-${s}`} type="button" className="suggestion-chip" onClick={() => setInput(s)}>
              {s}
            </button>
          ))}
        </div>
      )}
      {error && <p className="error">{error}</p>}
    </main>
  );
}
