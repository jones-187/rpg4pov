"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";

interface StoryMeta {
  storyId: string;
  title: string;
  createdAt: string;
}

export default function StoryPage() {
  const params = useParams<{ storyId: string }>();
  const storyId = params.storyId;

  const [title, setTitle] = useState<string>("");
  const [notFound, setNotFound] = useState<boolean>(false);
  const [narration, setNarration] = useState<string>(
    "故事已创建。在下方输入主角的第一回合行动，然后点击发送。"
  );
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
        const meta = (await res.json()) as StoryMeta;
        if (!cancelled) setTitle(meta.title);
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
      if (!res.ok) throw new Error(`请求失败（HTTP ${res.status}）`);
      const data = (await res.json()) as { playerResponse: string };
      setNarration(data.playerResponse);
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
        {narration}
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
