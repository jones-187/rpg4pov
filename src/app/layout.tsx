import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "小场景故事模拟",
  description: "主角视角受限的多角色异步故事模拟",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
