#!/usr/bin/env node
/**
 * fake-claude fixture（Issue 6 集成测试）。
 * 模拟 claude CLI 行为：读 prompt 文件，写 output.md + done.json，退出 0。
 * 支持环境变量 FAKE_CLAUDE_MODE 控制行为：
 *   - "success"（默认）：写 output + done，退出 0
 *   - "fail"：不写文件，退出 1
 *   - "timeout"：不写文件，不退出（由测试 abort）
 *   - "missing-output"：只写 done.json，不写 output.md
 */
import { promises as fs } from "node:fs";
import path from "node:path";

async function main() {
  const mode = process.env.FAKE_CLAUDE_MODE ?? "success";
  // 最后一个 argv 是 prompt 文件路径
  const promptFile = process.argv[process.argv.length - 1];
  const cwd = process.cwd();

  if (mode === "timeout") {
    // 不退出，等 abort（用 setInterval 保持 event loop 活跃）
    await new Promise(() => {
      setInterval(() => {}, 1000);
    });
    return;
  }

  if (mode === "fail") {
    process.stderr.write("fake-claude simulated failure");
    process.exit(1);
  }

  const turnDir = path.join(cwd, "turn");
  await fs.mkdir(turnDir, { recursive: true });

  if (mode === "missing-output") {
    await fs.writeFile(
      path.join(turnDir, "done.json"),
      JSON.stringify({ status: "success", completedAt: new Date().toISOString() }),
    );
    process.exit(0);
  }

  // success
  await fs.writeFile(
    path.join(turnDir, "output.md"),
    "# 主角视窗\n\n（fake-claude 输出）\n\n回合执行完成。\n",
  );
  await fs.writeFile(
    path.join(turnDir, "done.json"),
    JSON.stringify({ status: "success", completedAt: new Date().toISOString() }),
  );
  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(String(err));
  process.exit(1);
});
