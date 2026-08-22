import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * turn/state-update.md 的解析与合并（性能优化分支）。
 *
 * pi 回合 agent 把所有状态文件的变更合并写进 turn/state-update.md 单文件
 * （替代逐文件 write，把 9+ 次工具往返压成 1 次并行写），由服务端在快照
 * 保护窗口内解析并应用到真实状态文件。
 *
 * 格式（pi-prompt.ts 中约定的子集）：
 * === FILE: world.md ===
 * APPEND: 追加到文件末尾的行
 * REPLACE: 旧文本 → 新文本
 *
 * 安全边界：
 * - 目标文件白名单：world.md / player.md / adjustments.md / tendencies.md / actors/*.md
 * - 禁止目录穿越与绝对路径；白名单外文件段整段拒绝
 * - REPLACE 找不到旧文本时该条操作跳过并记入 errors（不失败回合，降级处理）
 */

/** 允许经 state-update 写入的顶层文件 */
const TOP_LEVEL_FILES = new Set(["world.md", "player.md", "adjustments.md", "tendencies.md"]);

export interface AppendOp {
  kind: "append";
  text: string;
}

export interface ReplaceOp {
  kind: "replace";
  from: string;
  to: string;
}

export type StateUpdateOp = AppendOp | ReplaceOp;

export interface StateUpdateSection {
  file: string;
  ops: StateUpdateOp[];
}

/** 随机数池消耗申报（=== RANDOM === 段内一行一次判定） */
export interface RollDeclaration {
  /** R 编号（1 起，服务端按序号回查池样本） */
  index: number;
  rollId: string;
  candidates: Array<{ id: string; weight: number }>;
  /** 模型申报的判定结果（服务端重算核对用） */
  declaredSelectedId?: string;
}

export interface ParseStateUpdateResult {
  sections: StateUpdateSection[];
  /** 随机数池消耗申报（乱序/超池的过滤在 pi-runner 结合池实例做） */
  rolls: RollDeclaration[];
  /** 非致命问题（未知文件、无法解析的操作行），供诊断日志 */
  problems: string[];
}

const FILE_HEADER_RE = /^===\s*FILE:\s*(\S+)\s*===$/;
const RANDOM_HEADER_RE = /^===\s*RANDOM\s*===$/;
/** R1: rollId=lockpick candidates=success:25,fail:75 → success */
const ROLL_LINE_RE = /^R(\d+):\s*rollId=(\S+)\s+candidates=(\S+)(?:\s*→\s*(\S+))?$/;

/** 校验 state-update 目标文件是否在白名单内（相对路径，actors/ 只允许一层 .md） */
export function isAllowedStateFile(file: string): boolean {
  if (TOP_LEVEL_FILES.has(file)) return true;
  if (file.startsWith("actors/") && file.endsWith(".md")) {
    const rest = file.slice("actors/".length);
    return rest.length > 0 && !rest.includes("/");
  }
  return false;
}

/**
 * 解析 state-update.md 原文。宽松容错：不认识的行忽略并记 problems，
 * 保证模型输出小幅抖动不至于整回合失败。
 *
 * === RANDOM === 是申报段不是文件段：声明行进 rolls，不参与
 * applyStateUpdates；必须显式识别，否则申报行会被当作上一段的
 * APPEND 续行混入状态文件。
 */
export function parseStateUpdate(raw: string): ParseStateUpdateResult {
  const sections: StateUpdateSection[] = [];
  const rolls: RollDeclaration[] = [];
  const problems: string[] = [];
  let current: StateUpdateSection | null = null;
  let inRandom = false;

  for (const rawLine of raw.split("\n")) {
    const line = rawLine.trim();
    if (RANDOM_HEADER_RE.test(line)) {
      inRandom = true;
      current = null;
      continue;
    }
    const header = line.match(FILE_HEADER_RE);
    if (header) {
      inRandom = false;
      const file = header[1];
      if (!isAllowedStateFile(file)) {
        problems.push(`file not allowed: ${file}`);
        current = null;
        continue;
      }
      current = { file, ops: [] };
      sections.push(current);
      continue;
    }
    if (inRandom) {
      if (line === "") continue;
      const decl = parseRollLine(line);
      if (decl) rolls.push(decl);
      else problems.push(`unparseable roll line: ${line.slice(0, 60)}`);
      continue;
    }
    if (!current) continue; // 段外内容忽略（含文件头说明文字）

    if (line.startsWith("APPEND:")) {
      const text = line.slice("APPEND:".length).trim();
      if (text) current.ops.push({ kind: "append", text });
      continue;
    }
    if (line.startsWith("REPLACE:")) {
      const body = line.slice("REPLACE:".length).trim();
      const sep = body.indexOf("→");
      if (sep <= 0) {
        problems.push(`unparseable REPLACE in ${current.file}: ${line.slice(0, 60)}`);
        continue;
      }
      const from = body.slice(0, sep).trim();
      const to = body.slice(sep + "→".length).trim();
      if (from && to) current.ops.push({ kind: "replace", from, to });
      continue;
    }
    // 多行 APPEND 续行：上一条是 append 且本行非空 → 追加为同一条的换行内容
    const last = current.ops[current.ops.length - 1];
    if (line && last && last.kind === "append" && !line.startsWith("===")) {
      last.text += `\n${line}`;
    }
  }
  return { sections, rolls, problems };
}

function parseRollLine(line: string): RollDeclaration | null {
  const m = line.match(ROLL_LINE_RE);
  if (!m) return null;
  const index = Number(m[1]);
  if (!Number.isInteger(index) || index < 1) return null;

  const candidates: Array<{ id: string; weight: number }> = [];
  for (const pair of m[3].split(",")) {
    const sep = pair.indexOf(":");
    if (sep <= 0) return null;
    const id = pair.slice(0, sep).trim();
    const weight = Number(pair.slice(sep + 1));
    if (!id || !Number.isFinite(weight) || weight <= 0) return null;
    candidates.push({ id, weight });
  }
  if (candidates.length === 0) return null;

  return {
    index,
    rollId: m[2],
    candidates,
    ...(m[4] !== undefined ? { declaredSelectedId: m[4] } : {}),
  };
}

export interface ApplyStateUpdateResult {
  /** 成功应用的操作数 */
  applied: number;
  /** 跳过的操作及原因（REPLACE 未命中、读文件失败等） */
  errors: string[];
}

/**
 * 把解析出的 sections 应用到 workspaceDir 下的真实状态文件。
 * 逐文件读改写；actors 新文件允许通过 APPEND 创建。
 * 任何单条操作失败只降级不抛出（调用方在快照保护内，最终一致性由回滚兜底）。
 */
export async function applyStateUpdates(
  workspaceDir: string,
  sections: StateUpdateSection[],
): Promise<ApplyStateUpdateResult> {
  let applied = 0;
  const errors: string[] = [];

  for (const section of sections) {
    const target = path.join(workspaceDir, section.file);
    let content: string;
    try {
      content = await fs.readFile(target, "utf8");
    } catch {
      if (section.ops[0]?.kind === "append") {
        content = "";
      } else {
        errors.push(`read failed: ${section.file}`);
        continue;
      }
    }

    let next = content;
    for (const op of section.ops) {
      if (op.kind === "append") {
        const glued = next === "" ? op.text : next.endsWith("\n") ? `${next}${op.text}\n` : `${next}\n${op.text}\n`;
        next = glued;
        applied++;
      } else {
        const idx = next.indexOf(op.from);
        if (idx === -1) {
          errors.push(`REPLACE miss in ${section.file}: ${op.from.slice(0, 40)}`);
          continue;
        }
        next = next.slice(0, idx) + op.to + next.slice(idx + op.from.length);
        applied++;
      }
    }

    if (next !== content) {
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, next);
    }
  }
  return { applied, errors };
}
