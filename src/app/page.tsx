"use client";

import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

interface StoryMeta {
  storyId: string;
  title: string;
  createdAt: string;
}

export default function HomePage() {
  const router = useRouter();
  const [stories, setStories] = useState<StoryMeta[]>([]);
  const [title, setTitle] = useState<string>("");
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    try {
      const res = await fetch("/api/stories");
      if (!res.ok) throw new Error(`加载失败（HTTP ${res.status}）`);
      const data = (await res.json()) as { stories: StoryMeta[] };
      setStories(data.stories);
    } catch (err) {
      setError(err instanceof Error ? err.message : "未知错误");
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  async function handleCreate(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (loading) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/stories", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: title.trim() || undefined }),
      });
      if (!res.ok) throw new Error(`创建失败（HTTP ${res.status}）`);
      const meta = (await res.json()) as StoryMeta;
      router.push(`/stories/${meta.storyId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "未知错误");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="container">
      <h1>小场景故事模拟</h1>

      <form onSubmit={handleCreate} className="input-form" aria-label="创建故事">
        <textarea
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="故事标题（可选，留空为「未命名故事」）"
          rows={2}
          disabled={loading}
        />
        <button type="submit" disabled={loading}>
          {loading ? "创建中…" : "创建新故事"}
        </button>
      </form>

      <section aria-label="故事列表">
        <h2 className="section-title">已有故事</h2>
        {stories.length === 0 ? (
          <p className="muted">还没有故事。创建一个开始吧。</p>
        ) : (
          <ul className="story-list">
            {stories.map((s) => (
              <li key={s.storyId}>
                <Link href={`/stories/${s.storyId}`} className="story-item">
                  <span className="story-item-title">{s.title}</span>
                  <span className="story-item-meta">{s.storyId.slice(0, 8)}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      {error && <p className="error">{error}</p>}
    </main>
  );
}
