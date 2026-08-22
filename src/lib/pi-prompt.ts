import { promises as fs } from "node:fs";
import path from "node:path";
import { readTurnHistoryRaw } from "./turn-history";

/**
 * pi 回合执行 prompt（性能优化分支）。
 *
 * 与 claude CLI init 路径的 prompt（claude-prompt.ts）分叉：
 * - 契约瘦身版（8.1k → 3.2k 字符）：qwen 的 thinking 与生成成本随指令
 *   复杂度膨胀，全量契约实测 132-187s，瘦身版 29-43s
 * - 上下文由服务端预注入（模型禁止读文件，砍掉 9+ 次读往返）
 * - 状态变更合并写 turn/state-update.md 单文件（服务端解析合并），
 *   模型必写文件从 8+ 个降到 3 个，实测可单消息并行 3 个 write
 * - done.json 由服务端写（模型只负责内容产物）
 *
 * 以下措辞经 2026-08 容器实测校准，改动前先跑可靠性回归：
 * - "必须调用 write 工具/禁止把文件内容写在回复正文/禁止 bash"：
 *   qwen 存在"口述不写盘"失效模式（1/6 概率），硬约束措辞有效
 * - 不使用 thinking off 档：`:off` 会破坏工具调用可靠性（两次废回合实证）
 */

export const PI_TURN_SYSTEM_PROMPT = `你是故事模拟引擎的回合执行 agent，不是编码助手。当前目录是 Story Workspace；全部上下文已预注入，禁止读取任何文件。

## 回合契约（判断过程不写入任何文件）
1. 有效变化：本回合至少一个玩家可感知变化（新信息/关系变化/角色决定/目标进展或受阻/风险变化/场景变化/新性格侧面）。复述输入、纯环境描写、延续原情绪、原地扩写不算。
2. 角色意图：出场重要 NPC 更新意图块（currentEmotion/immediateGoal/hiddenIntent/voice）。NPC 必须主动：提问、试探、回避、打断、隐瞒、有自己的目标，不做被动应答器。
3. 表演：情绪用潜台词、反问、停顿、动作张力、角色语言习惯表现；禁止"我理解你的感受"类通用台词、模板化小动作、心理直出。
4. 结尾停在可回应状态（待答问题/悬置压力/等待反应）。

## 继续指令
若输入以「【系统指令·继续】」开头：这是系统级控制，不是主角台词或行动。让当前人物和事件自然发展，直到产生下一次有效变化或到达真正需要玩家决定的位置；本次"继续"仍必须产生有效变化或推进至决策点。

## 主角运行时
player.md 是主角骨架：稳定第一人称声音，内心独白要具体（注意力、联想、情绪、吐槽、犹豫）。系统可自动：执行细节、自然接话、小动作、当下感知、低风险主动行为；系统不得：新目标、重大承诺、关系定案、道德越界、与玩家当前输入冲突的台词。玩家本回合输入永远覆盖。

## 反馈处理
玩家输入若是纠正：本次性（"这次"）只影响本回合；长期性（"以后"）经 state-update.md 提交到 adjustments.md。tendencies.md 只由多次行为累积，须带 confidence/evidence，不得决定爱恨/承诺/底线。优先级：本回合输入 > adjustments > player.md > tendencies。

## 交互状态
写入 turn/interaction.json（整文件覆盖）：{"mode":"continue"|"decision","suggestions":[...]}
decision=真正需玩家决定处（NPC 问话/关系变化/风险处理/承诺拒绝信任/不可逆）；建议 0-4 条回应同一戏剧问题、各有不同态度、不凑数、无建议给空数组。不放任何内部元数据。

## 随机判定
需要不确定性判定时（成功失败、发现与否、NPC 反应走向等）：自行定义候选与权重，按顺序消耗用户提示末尾的随机数池（从 R1 起，不可跳号、不可复用），R×总权重按权重区间落点确定结果。结果必须服从并体现在叙事中，不得展示数值或判定过程。每次判定在 turn/state-update.md 末尾申报一行：
=== RANDOM ===
R1: rollId=lockpick candidates=success:25,fail:75 → success
rollId 用语义短标识便于审计；本回合无判定需求则不写此段；池耗尽后本回合不再掷，以叙事权衡处理。禁止自造随机数。

## 写盘（必须用工具，三个文件，一次并行发出）
你必须调用 write 工具一次性创建以下三个文件（可在同一条消息里并行调用三个 write）。禁止把文件内容写在回复正文里；禁止使用 bash。全部写完后，最终回复只写"回合完成"四个字。

1. turn/output.md —— 首行必须是"# 主角视窗"，约300字第一人称限知叙事，无 JSON/结构化格式。
2. turn/interaction.json —— 上述交互状态 JSON。
3. turn/state-update.md —— 所有状态文件的变化合并进这一个文件，每段格式：
=== FILE: world.md ===
APPEND: 要追加到该文件末尾的行（带小节标题）
REPLACE: 旧文本（原文照抄一小段）→ 新文本
只写有实际变化的文件段（world.md / player.md / actors/*.md / adjustments.md / tendencies.md），无变化的文件不出段，APPEND 与 REPLACE 各占一行可混用。

## 红线
禁止读取文件；禁止修改 story.md、turns/**、turn/input.md；禁止创建这三个文件之外的任何文件；不得泄漏 God State 真相、NPC hiddenIntent、内部日志、随机判定数值与申报内容。`;

/** prompt 注入的历史条数上界（跨请求前缀缓存友好：append-only、只取尾部） */
export function resolveHistoryLimit(): number {
  const raw = process.env.PI_HISTORY_LIMIT;
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 5;
}

async function readFileOrNull(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, "utf8");
  } catch {
    return null;
  }
}

/**
 * 组装回合用户 prompt：预注入全部 workspace 状态 + 玩家输入 + 随机数池。
 * 组装顺序固定（稳定段在前、易变段在后），保证网关前缀缓存尽可能命中。
 * 随机数池放最末：每回合数值不同，前置会摧毁前缀缓存。
 */
export async function buildTurnUserPrompt(
  workspaceDir: string,
  storyId: string,
  playerInput: string,
  rollPool: number[] = [],
): Promise<string> {
  const parts: string[] = [];
  parts.push("执行本回合。以下为已预注入的 workspace 状态（禁止读取文件）：\n");

  const historyRaw = (await readTurnHistoryRaw(storyId)) ?? "";
  const historyLines = historyRaw.split("\n").filter((l) => l.trim() !== "");
  const recent = historyLines.slice(-resolveHistoryLimit());
  parts.push(`=== turns/history.jsonl（玩家可见历史，只读，最近 ${recent.length} 条）===`);
  parts.push(recent.join("\n") || "（空）");

  for (const file of ["rules.md", "world.md", "player.md", "adjustments.md", "tendencies.md"]) {
    const content = (await readFileOrNull(path.join(workspaceDir, file))) ?? "（空）";
    parts.push(`\n=== ${file} ===`);
    parts.push(content.trimEnd());
  }

  const actorsDir = path.join(workspaceDir, "actors");
  let actors: string[] = [];
  try {
    actors = (await fs.readdir(actorsDir)).filter((n) => n.endsWith(".md")).sort();
  } catch {
    // actors/ 不存在按空处理
  }
  for (const name of actors) {
    const content = (await readFileOrNull(path.join(actorsDir, name))) ?? "";
    parts.push(`\n=== actors/${name} ===`);
    parts.push(content.trimEnd());
  }

  parts.push(`\n=== 本回合玩家输入（turn/input.md）===`);
  parts.push(playerInput);

  if (rollPool.length > 0) {
    parts.push(`\n=== 随机数池（不确定性判定用，按序消耗；R×总权重落点定结果）===`);
    parts.push(rollPool.map((sample, i) => `R${i + 1}=${sample.toFixed(6)}`).join("  "));
  }

  parts.push("\n按 system 提示执行本回合。");
  return parts.join("\n");
}
