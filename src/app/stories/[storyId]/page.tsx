"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";

interface StoryMeta {
  storyId: string;
  title: string;
  createdAt: string;
}

interface TurnHistoryEntry {
  turnId: string;
  at: string;
  input: string;
  output: string;
}

export default function StoryPage() {
  const params = useParams<{ storyId: string }>();
  const storyId = params.storyId;

  const [title, setTitle] = useState<string>("");
  const [notFound, setNotFound] = useState<boolean>(false);
  const [history, setHistory] = useState<TurnHistoryEntry[]>([]);
  const [input, setInput] = useState<string>("");
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
        if (data && typeof data.retryInput === "string") {
          setInput(data.retryInput);
        }
        const errorMsg =
          data && typeof data.error === "string"
            ? data.error
            : `请求失败（HTTP ${res.status}）`;
        setError(errorMsg);
        return;
      }
      if (!data || typeof data.playerResponse !== "string") {
        throw new Error("响应格式错误");
      }
      // Issue 6.5 反馈 4：成功响应必须有 committed turn
      if (!data.turn || typeof data.turn !== "object") {
        throw new Error("响应格式错误：缺少 committed turn");
      }
      // 验证 turn 结构
      const turn = data.turn as TurnHistoryEntry;
      if (
        typeof turn.turnId !== "string" ||
        typeof turn.at !== "string" ||
        typeof turn.input !== "string" ||
        typeof turn.output !== "string"
      ) {
        throw new Error("响应格式错误：turn 结构不正确");
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
          <p className="muted">故事已创建。在下方输入主角的第一回合行动，然后点击发送。</p>
        ) : (
          history.map((turn, idx) => (
            <div key={turn.turnId} className="turn-entry">
              <div className="turn-input">
                <strong>玩家输入：</strong>{turn.input}
              </div>
              <div className="turn-output">
                {turn.output}
              </div>
            </div>
          ))
        )}
      </section>

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
      {error && <p className="error">{error}</p>}
    </main>
  );
}