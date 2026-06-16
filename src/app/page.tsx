"use client";

import { useState, type FormEvent } from "react";

export default function HomePage() {
  const [narration, setNarration] = useState<string>(
    "故事将从这里开始。在下方输入主角的行动或台词，然后点击发送。"
  );
  const [input, setInput] = useState<string>("");
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

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
        body: JSON.stringify({ input: text }),
      });

      if (!res.ok) {
        throw new Error(`请求失败（HTTP ${res.status}）`);
      }

      const data = (await res.json()) as { playerResponse: string };
      setNarration(data.playerResponse);
      setInput("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "未知错误");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="container">
      <h1>小场景故事模拟</h1>
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
