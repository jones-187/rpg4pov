"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import {
  sanitizeTurnInteraction,
  DEFAULT_TURN_INTERACTION,
  type TurnInteraction,
} from "@/lib/interaction-schema";

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
  const [, setTick] = useState(0);

  useEffect(() => {
    if (pendingSince === null) return;
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [pendingSince]);

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
  // 差异只有 URL/payload、失败回填的 state 与成功后的额外动作。
  async function submitTurnLike(
    url: string,
    payload: Record<string, string>,
    refill: (text: string) => void,
    onSuccess: () => void,
  ) {
    setLoading(true);
    setPendingSince(Date.now());
    setError(null);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        applyErrorResponse(res, data, refill);
        return;
      }
      const turn = parseTurnResponse(data);
      if (!turn) {
        throw new Error("响应格式错误：缺少 committed turn");
      }
      setHistory((prev) => [...prev, turn]);
      // Issue 10：更新交互状态（缺失/不合法时降级为连续演出态）
      setInteraction(parseInteraction((data as { interaction?: unknown }).interaction));
      onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : "未知错误");
    } finally {
      setLoading(false);
      setPendingSince(null);
    }
  }

  // Issue 7：初始化——提交自然语言设定，开场视窗作为第一条 history entry 返回
  async function handleInitSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const text = setting.trim();
    if (!text || loading) return;
    await submitTurnLike(
      `/api/stories/${storyId}/initialize`,
      { setting: text },
      setSetting,
      () => {
        setInitialized(true);
        setSetting("");
      },
    );
  }

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const text = input.trim();
    if (!text || loading) return;
    await submitTurnLike("/api/story-turn", { storyId, input: text }, setInput, () => setInput(""));
  }

  // Issue 10：系统级"继续"——让人物和事件自然发展，不是主角台词。
  async function handleContinue() {
    if (loading) return;
    await submitTurnLike(
      "/api/story-turn",
      { storyId, command: "continue" },
      () => {},
      () => setInput(""),
    );
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
          history.map((turn) => (
            <div key={turn.turnId} className="turn-entry">
              <div className="turn-input-block">
                <h3 className="turn-block-title">你</h3>
                <div className="turn-input-content">{turn.input}</div>
              </div>
              <div className="turn-output-block">
                <h3 className="turn-block-title">主角视窗</h3>
                <div className="turn-output-content">{normalizeOutput(turn.output)}</div>
              </div>
            </div>
          ))
        )}
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
        <form onSubmit={handleSubmit} className="input-form" aria-label="主角输入">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="输入主角的行动或台词…"
            rows={4}
            disabled={loading}
          />
          <button type="submit" disabled={loading || !input.trim()}>
            {loading ? "处理中…" : "发送"}
          </button>
          {interaction.mode === "continue" && history.length > 0 && (
            <button type="button" onClick={handleContinue} disabled={loading}>
              继续
            </button>
          )}
        </form>
      )}
      {loading && pendingSince !== null && (
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
