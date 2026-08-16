"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";

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
 * 规范化 output 内容：
 * 如果以 `# 主角视窗` 开头，去掉这一行和紧随其后的空行。
 * UI 标题已负责展示"主角视窗"，避免重复。
 */
function normalizeOutput(output: string): string {
  const lines = output.split("\n");
  // 检查第一行是否是 `# 主角视窗`
  if (lines[0]?.trim() === "# 主角视窗") {
    // 去掉第一行
    lines.shift();
    // 如果下一行是空行，也去掉
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

export default function StoryPage() {
  const params = useParams<{ storyId: string }>();
  const storyId = params.storyId;

  const [title, setTitle] = useState<string>("");
  const [notFound, setNotFound] = useState<boolean>(false);
  const [initialized, setInitialized] = useState<boolean>(false);
  const [history, setHistory] = useState<TurnHistoryEntry[]>([]);
  const [input, setInput] = useState<string>("");
  const [setting, setSetting] = useState<string>("");
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

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
        };
        if (!cancelled) {
          setTitle(data.story.title);
          setInitialized(Boolean(data.story.initialized));
          setHistory(data.history);
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

  // Issue 7：初始化——提交自然语言设定，开场视窗作为第一条 history entry 返回
  async function handleInitSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const text = setting.trim();
    if (!text || loading) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/stories/${storyId}/initialize`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ setting: text }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        applyErrorResponse(res, data, setSetting);
        return;
      }
      const turn = parseTurnResponse(data);
      if (!turn) {
        throw new Error("响应格式错误：缺少 committed turn");
      }
      setHistory((prev) => [...prev, turn]);
      setInitialized(true);
      setSetting("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "未知错误");
    } finally {
      setLoading(false);
    }
  }

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const text = input.trim();
    if (!text || loading) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/story-turn", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ storyId, input: text }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        // Issue 4：失败响应带 retryInput 时回填输入框
        applyErrorResponse(res, data, setInput);
        return;
      }
      const turn = parseTurnResponse(data);
      if (!turn) {
        throw new Error("响应格式错误：缺少 committed turn");
      }
      setHistory((prev) => [...prev, turn]);
      setInput("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "未知错误");
    } finally {
      setLoading(false);
    }
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
        </form>
      )}
      {error && <p className="error">{error}</p>}
    </main>
  );
}
