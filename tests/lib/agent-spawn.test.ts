import { describe, expect, it } from "vitest";
import { defaultSpawn } from "@/lib/agent-spawn";

describe("neutral controlled spawn seam", () => {
  it("exports the shared default spawn implementation", () => {
    expect(typeof defaultSpawn).toBe("function");
  });

  it("逐行回调完整转发，超限输出只保留尾部（诊断不爆 V8 字符串上限）", async () => {
    const lines: string[] = [];
    const res = await defaultSpawn(
      process.execPath,
      [
        "-e",
        // 8 行 × 200KB = 1.6MB，远超 64KB 尾部上限；行必须完整到达回调
        'const fs = require("node:fs"); const big = "x".repeat(200 * 1024); for (let i = 0; i < 8; i++) fs.writeSync(1, big + "\\n");',
      ],
      {
        cwd: process.cwd(),
        env: { PATH: process.env.PATH },
        signal: AbortSignal.timeout(10_000),
        stdinData: "",
        stdio: ["pipe", "pipe", "pipe"],
        onStdoutLine: (l) => lines.push(l),
      },
    );
    expect(res.code).toBe(0);
    expect(lines).toHaveLength(8);
    expect(lines[0].length).toBe(200 * 1024);
    // stdout 聚合被截到尾部上限内，spawn 仍正常完成
    expect(res.stdout.length).toBeLessThanOrEqual(64 * 1024);
  });

  it("回调抛异常不炸主链路（spawn 仍完成并保留 stdout）", async () => {
    const res = await defaultSpawn(
      process.execPath,
      ["-e", 'const fs = require("node:fs"); fs.writeSync(1, "line-a\\n"); fs.writeSync(1, "line-b\\n");'],
      {
        cwd: process.cwd(),
        env: { PATH: process.env.PATH },
        signal: AbortSignal.timeout(10_000),
        stdinData: "",
        stdio: ["pipe", "pipe", "pipe"],
        onStdoutLine: () => {
          throw new Error("preview pipeline bug");
        },
      },
    );
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("line-a");
  });
});
