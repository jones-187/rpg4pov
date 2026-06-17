#!/usr/bin/env node
/**
 * Random Tool CLI Wrapper（Issue 6）。
 * 把 rollChoice 库函数包装成 CLI 子进程可调用接口，供 Claude Code Runner 经 Bash 调用。
 *
 * 输入：stdin JSON（RollChoiceInput，不含 rng）
 * 输出：stdout JSON（RollChoiceResult），成功退出码 0
 * 失败：stderr 错误信息，退出码 1
 *
 * 调用示例（heredoc，避免 pipe 导致 Bash permission pattern 不匹配）：
 *   node /app/cli/roll-choice.js <<'JSON'
 *   {"storyId":"...","workspaceDir":"...","rollId":"lockpick","candidates":[{"id":"success","weight":25}]}
 *   JSON
 */
import { rollChoice } from "../lib/random-tool";
import type { RollChoiceInput } from "../lib/random-tool";

async function main(): Promise<void> {
  let raw: string;
  try {
    raw = await readStdin();
  } catch (err) {
    process.stderr.write(`failed to read stdin: ${errMessage(err)}\n`);
    process.exit(1);
  }

  let input: RollChoiceInput;
  try {
    input = JSON.parse(raw) as RollChoiceInput;
  } catch (err) {
    process.stderr.write(`invalid JSON input: ${errMessage(err)}\n`);
    process.exit(1);
  }

  try {
    const result = await rollChoice(input);
    process.stdout.write(JSON.stringify(result) + "\n");
    process.exit(0);
  } catch (err) {
    process.stderr.write(`${errMessage(err)}\n`);
    process.exit(1);
  }
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

main().catch((err) => {
  process.stderr.write(`unexpected: ${errMessage(err)}\n`);
  process.exit(1);
});
