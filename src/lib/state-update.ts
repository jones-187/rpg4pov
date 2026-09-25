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
 * - 禁止目录穿越、Windows 分隔符、NUL 与绝对路径；白名单外文件段整段拒绝
 * - 解析和应用都采用全量校验；任一错误都不会产生部分状态写入
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
  /** 解析问题（未知文件、无法解析的操作行）；调用方应拒绝整批提交 */
  problems: string[];
}

/** Maximum untrusted state-update input accepted by either syntax. */
export const MAX_STATE_UPDATE_CHARS = 100_000;

const FILE_HEADER_RE = /^===\s*FILE:\s*(\S+)\s*===$/;
const RANDOM_HEADER_RE = /^===\s*RANDOM\s*===$/;
/** R1: rollId=lockpick candidates=success:25,fail:75 → success */
const ROLL_LINE_RE = /^R(\d+):\s*rollId=(\S+)\s+candidates=(\S+)(?:\s*→\s*(\S+))?$/;

/**
 * 校验 state-update 目标文件是否在白名单内（相对路径，actors/ 只允许一层 .md）。
 *
 * 这里不能只依赖 path.join/normalize：在 POSIX 上反斜杠不是分隔符，
 * 但 state-update 可能来自其他平台或不可信 agent；先拒绝所有这类字符，
 * 再按明确的相对路径形状判断。
 */
export function isAllowedStateFile(file: string): boolean {
  if (typeof file !== "string" || file.length === 0) return false;
  if (file.includes("\0") || file.includes("\\") || file.startsWith("/")) return false;
  if (/^[A-Za-z]:/.test(file)) return false;

  const parts = file.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) return false;

  if (TOP_LEVEL_FILES.has(file)) return true;
  if (file.startsWith("actors/") && file.endsWith(".md")) {
    const rest = file.slice("actors/".length);
    if (rest.length === 0 || rest.includes("/")) return false;
    const basename = rest.slice(0, -3);
    return basename.length > 0 && basename !== "." && basename !== "..";
  }
  return false;
}

/**
 * 解析 state-update.md 原文。
 *
 * 这里仍兼容 Markdown 形式的 APPEND/REPLACE，以及 APPEND 的多行续行，
 * 但不再把未知内容静默丢弃。只要有一个解析问题，sections 会清空，
 * 这样调用方即使继续调用 applyStateUpdates 也不会得到部分成功。
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
  let randomHasDeclaration = false;
  let sawNoChangesMarker = false;
  let sawMeaningfulLine = false;
  const seenFiles = new Set<string>();

  if (typeof raw !== "string" || raw.trim() === "") {
    return { sections: [], rolls: [], problems: ["state-update is blank"] };
  }
  if (raw.length > MAX_STATE_UPDATE_CHARS) {
    return { sections: [], rolls: [], problems: ["state-update exceeds " + MAX_STATE_UPDATE_CHARS + " chars"] };
  }

  // A leading JSON object is the structured state-update contract. It is
  // intentionally fail-closed: malformed JSON must not fall through to the
  // legacy Markdown parser and gain a different interpretation.
  if (raw.trimStart().startsWith("{")) {
    return parseStructuredStateUpdate(raw.trim());
  }

  // 单独的 NO CHANGES 可以快速返回；与 RANDOM 组合时由下面的逐行解析
  // 继续收集申报。
  if (NO_CHANGES_HEADER_RE.test(raw.trim())) {
    return { sections: [], rolls: [], problems: [] };
  }

  const rawLines = raw.split("\n");
  for (let lineIndex = 0; lineIndex < rawLines.length; lineIndex += 1) {
    // split("\\n") 会把末尾换行变成一个仅用于分隔的空元素；它不应额外
    // 变成 APPEND 正文，但中间的空行必须保留下来。
    if (lineIndex === rawLines.length - 1 && raw.endsWith("\n") && rawLines[lineIndex] === "") continue;
    const rawLine = rawLines[lineIndex]?.replace(/\r$/, "") ?? "";
    const line = rawLine.trim();

    if (NO_CHANGES_HEADER_RE.test(line)) {
      if (current || seenFiles.size > 0) {
        closeSection(current, problems);
        problems.push("NO CHANGES cannot be combined with FILE sections");
        current = null;
      }
      if (sawNoChangesMarker) problems.push("duplicate NO CHANGES marker");
      sawNoChangesMarker = true;
      sawMeaningfulLine = true;
      continue;
    }

    if (RANDOM_HEADER_RE.test(line)) {
      closeRandom(inRandom, randomHasDeclaration, problems);
      closeSection(current, problems);
      inRandom = true;
      randomHasDeclaration = false;
      current = null;
      sawMeaningfulLine = true;
      continue;
    }

    const header = line.match(FILE_HEADER_RE);
    if (header) {
      closeRandom(inRandom, randomHasDeclaration, problems);
      closeSection(current, problems);
      inRandom = false;
      randomHasDeclaration = false;
      const file = header[1];
      if (sawNoChangesMarker) problems.push("NO CHANGES cannot be combined with FILE sections");
      if (!isAllowedStateFile(file)) {
        problems.push(`file path not allowed: ${file}`);
        current = null;
        sawMeaningfulLine = true;
        continue;
      }
      if (seenFiles.has(file)) problems.push(`duplicate file section: ${file}`);
      seenFiles.add(file);
      current = { file, ops: [] };
      sections.push(current);
      sawMeaningfulLine = true;
      continue;
    }

    // 任意看起来像段头、但不是 FILE/RANDOM/NO CHANGES 的内容都不能
    // 被当成 APPEND 续行吞掉。
    if (/^===/.test(line)) {
      closeRandom(inRandom, randomHasDeclaration, problems);
      closeSection(current, problems);
      problems.push(`unknown section: ${line.slice(0, 80)}`);
      current = null;
      inRandom = false;
      sawMeaningfulLine = true;
      continue;
    }

    if (inRandom) {
      if (line === "") continue;
      const decl = parseRollLine(line);
      if (decl) {
        rolls.push(decl);
        randomHasDeclaration = true;
      } else {
        problems.push(`unparseable roll line: ${line.slice(0, 60)}`);
      }
      continue;
    }

    if (!current) {
      if (line !== "") problems.push(`content outside section: ${line.slice(0, 80)}`);
      continue;
    }

    if (line.startsWith("APPEND:")) {
      const text = line.slice("APPEND:".length).trim();
      if (!text) {
        problems.push(`empty APPEND in ${current.file}`);
      } else {
        current.ops.push({ kind: "append", text });
      }
      continue;
    }

    if (line.startsWith("REPLACE:")) {
      const body = line.slice("REPLACE:".length).trim();
      const sep = body.indexOf("→");
      if (sep < 0) {
        problems.push(`unparseable REPLACE in ${current.file}: ${line.slice(0, 60)}`);
        continue;
      }
      const from = body.slice(0, sep).trim();
      const to = body.slice(sep + "→".length).trim();
      if (!from) {
        problems.push(`REPLACE from is empty in ${current.file}`);
        continue;
      }
      // to 允许为空：这是删除操作。
      current.ops.push({ kind: "replace", from, to });
      continue;
    }

    // 没有冒号的 APPEND/REPLACE 以及其他大写指令都属于无法识别的操作，
    // 不能借由 APPEND 续行规则静默放过。
    if (/^(?:APPEND|REPLACE)\b/.test(line) || /^[A-Z][A-Z0-9_-]*\s*:/.test(line)) {
      problems.push(`unrecognized operation in ${current.file}: ${line.slice(0, 80)}`);
      continue;
    }

    // 多行 APPEND 续行：上一条是 append 且本行非空 → 追加为同一条的换行内容
    const last = current.ops[current.ops.length - 1];
    if (last && last.kind === "append") {
      // 这里使用未 trim 的原文，保留 Markdown 缩进和空行。
      last.text += `\n${rawLine}`;
      continue;
    }

    if (line !== "") problems.push(`unrecognized operation in ${current.file}: ${line.slice(0, 80)}`);
  }

  closeSection(current, problems);
  closeRandom(inRandom, randomHasDeclaration, problems);
  if (!sawMeaningfulLine) problems.push("state-update has no changes");

  // 解析错误与应用错误必须遵循同一条原子性边界；保留 rolls 供调用方诊断，
  // 但不让任何一个合法文件段在错误 bundle 中落盘。
  return { sections: problems.length > 0 ? [] : sections, rolls, problems };
}

function parseStructuredStateUpdate(raw: string): ParseStateUpdateResult {
  const problems: string[] = [];
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return { sections: [], rolls: [], problems: ["state-update JSON is invalid"] };
  }

  if (!isRecord(value) || !hasExactlyKeys(value, ["sections", "rolls"])) {
    problems.push("structured state-update keys are invalid");
    return { sections: [], rolls: [], problems };
  }
  if (!Array.isArray(value.sections)) problems.push("structured sections must be an array");
  if (!Array.isArray(value.rolls)) problems.push("structured rolls must be an array");

  const sections: StateUpdateSection[] = [];
  const seenFiles = new Set<string>();
  if (Array.isArray(value.sections)) {
    for (const sectionValue of value.sections) {
      if (!isRecord(sectionValue) || !hasExactlyKeys(sectionValue, ["file", "ops"])) {
        problems.push("structured section keys are invalid");
        continue;
      }
      if (typeof sectionValue.file !== "string" || !isAllowedStateFile(sectionValue.file)) {
        problems.push("file path not allowed: " + String(sectionValue.file ?? ""));
      } else if (seenFiles.has(sectionValue.file)) {
        problems.push("duplicate file section: " + sectionValue.file);
      } else {
        seenFiles.add(sectionValue.file);
      }

      if (!Array.isArray(sectionValue.ops) || sectionValue.ops.length === 0) {
        problems.push("empty operations in " + String(sectionValue.file ?? ""));
        continue;
      }

      const ops: StateUpdateOp[] = [];
      for (const opValue of sectionValue.ops) {
        if (!isRecord(opValue) || typeof opValue.kind !== "string") {
          problems.push("structured operation is invalid in " + String(sectionValue.file ?? ""));
          continue;
        }
        if (opValue.kind === "append") {
          if (!hasExactlyKeys(opValue, ["kind", "text"])) {
            problems.push("APPEND keys are invalid in " + String(sectionValue.file ?? ""));
            continue;
          }
          if (typeof opValue.text !== "string" || opValue.text.trim() === "") {
            problems.push("empty APPEND in " + String(sectionValue.file ?? ""));
            continue;
          }
          ops.push({ kind: "append", text: opValue.text });
          continue;
        }
        if (opValue.kind === "replace") {
          if (!hasExactlyKeys(opValue, ["kind", "from", "to"])) {
            problems.push("REPLACE keys are invalid in " + String(sectionValue.file ?? ""));
            continue;
          }
          if (typeof opValue.from !== "string" || opValue.from.trim() === "") {
            problems.push("REPLACE from is empty in " + String(sectionValue.file ?? ""));
            continue;
          }
          if (typeof opValue.to !== "string") {
            problems.push("REPLACE to is invalid in " + String(sectionValue.file ?? ""));
            continue;
          }
          ops.push({ kind: "replace", from: opValue.from, to: opValue.to });
          continue;
        }
        problems.push("unrecognized operation in " + String(sectionValue.file ?? ""));
      }

      if (typeof sectionValue.file === "string" && isAllowedStateFile(sectionValue.file)) {
        sections.push({ file: sectionValue.file, ops });
      }
    }
  }

  const rolls: RollDeclaration[] = [];
  const seenRollIndexes = new Set<number>();
  const seenRollIds = new Set<string>();
  if (Array.isArray(value.rolls)) {
    for (const rollValue of value.rolls) {
      if (
        !isRecord(rollValue) ||
        (!hasExactlyKeys(rollValue, ["index", "rollId", "candidates"]) &&
          !hasExactlyKeys(rollValue, ["index", "rollId", "candidates", "declaredSelectedId"]))
      ) {
        problems.push("structured roll keys are invalid");
        continue;
      }
      if (typeof rollValue.index !== "number" || !Number.isInteger(rollValue.index) || rollValue.index < 1) {
        problems.push("roll index must be a positive integer");
      } else if (seenRollIndexes.has(rollValue.index)) {
        problems.push("duplicate roll index: " + rollValue.index);
      } else {
        seenRollIndexes.add(rollValue.index);
      }
      if (typeof rollValue.rollId !== "string" || rollValue.rollId.trim() === "") {
        problems.push("rollId must be non-empty");
      } else if (seenRollIds.has(rollValue.rollId)) {
        problems.push("duplicate rollId: " + rollValue.rollId);
      } else {
        seenRollIds.add(rollValue.rollId);
      }
      if (!Array.isArray(rollValue.candidates) || rollValue.candidates.length === 0) {
        problems.push("roll candidates must be a non-empty array");
        continue;
      }

      const candidates: Array<{ id: string; weight: number }> = [];
      const seenCandidateIds = new Set<string>();
      let totalWeight = 0;
      for (const candidateValue of rollValue.candidates) {
        if (!isRecord(candidateValue) || !hasExactlyKeys(candidateValue, ["id", "weight"])) {
          problems.push("roll candidate keys are invalid");
          continue;
        }
        if (typeof candidateValue.id !== "string" || candidateValue.id.trim() === "") {
          problems.push("candidate id must be non-empty");
          continue;
        }
        if (seenCandidateIds.has(candidateValue.id)) {
          problems.push("duplicate candidate id: " + candidateValue.id);
          continue;
        }
        seenCandidateIds.add(candidateValue.id);
        if (
          typeof candidateValue.weight !== "number" ||
          !Number.isFinite(candidateValue.weight) ||
          candidateValue.weight <= 0
        ) {
          problems.push("candidate weight must be finite and positive: " + candidateValue.id);
          continue;
        }
        totalWeight += candidateValue.weight;
        candidates.push({ id: candidateValue.id, weight: candidateValue.weight });
      }
      if (!Number.isFinite(totalWeight) || totalWeight <= 0) {
        problems.push("candidate weights must sum to a finite positive number");
      }
      if (
        Object.prototype.hasOwnProperty.call(rollValue, "declaredSelectedId") &&
        (typeof rollValue.declaredSelectedId !== "string" || rollValue.declaredSelectedId.trim() === "")
      ) {
        problems.push("declaredSelectedId must be non-empty when provided");
      }
      if (
        typeof rollValue.index === "number" &&
        Number.isInteger(rollValue.index) &&
        rollValue.index >= 1 &&
        typeof rollValue.rollId === "string" &&
        rollValue.rollId.trim() !== "" &&
        Array.isArray(rollValue.candidates) &&
        candidates.length === rollValue.candidates.length &&
        Number.isFinite(totalWeight) &&
        totalWeight > 0
      ) {
        rolls.push({
          index: rollValue.index,
          rollId: rollValue.rollId,
          candidates,
          ...(Object.prototype.hasOwnProperty.call(rollValue, "declaredSelectedId")
            ? { declaredSelectedId: rollValue.declaredSelectedId as string }
            : {}),
        });
      }
    }
  }

  // Structured input is atomic: even valid siblings are discarded when one
  // section, operation, roll, or top-level field is invalid.
  if (problems.length > 0) return { sections: [], rolls: [], problems };
  return { sections, rolls, problems: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

const NO_CHANGES_HEADER_RE = /^===\s*NO CHANGES\s*===$/;

function closeSection(section: StateUpdateSection | null, problems: string[]): void {
  if (section && section.ops.length === 0) problems.push(`empty operations in ${section.file}`);
}

function closeRandom(inRandom: boolean, hasDeclaration: boolean, problems: string[]): void {
  if (inRandom && !hasDeclaration) problems.push("empty RANDOM section");
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
  /** 验证失败的原因；存在错误时 applied 始终为 0 且不写任何文件 */
  errors: string[];
}

/**
 * 把解析出的 sections 应用到 workspaceDir 下的真实状态文件。
 *
 * 先验证全部 section/operation、读取全部目标并在内存中准备结果，确认没有
 * 任何错误后才开始写盘。因此 REPLACE 未命中、重复命中、缺失目标、路径或
 * 符号链接问题都不会留下“前几个文件已经写入”的部分成功。
 *
 * 只有预期的 ENOENT（且该 section 含 APPEND）允许按空文件创建；其他真实
 * I/O 异常必须抛给 orchestrator，由其快照回滚，不能在这里吞掉。
 */
export async function applyStateUpdates(
  workspaceDir: string,
  sections: StateUpdateSection[],
): Promise<ApplyStateUpdateResult> {
  const errors: string[] = [];
  const validationErrors = validateSections(sections);
  if (validationErrors.length > 0) return { applied: 0, errors: validationErrors };

  const plans: PlannedStateUpdate[] = [];

  for (const section of sections) {
    const target = path.resolve(workspaceDir, section.file);
    const symlink = await findSymlinkInPath(workspaceDir, target);
    if (symlink) {
      errors.push(`symlink path not allowed: ${section.file}`);
      continue;
    }

    let content: string;
    try {
      content = await fs.readFile(target, "utf8");
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) throw error;
      if (!section.ops.some((op) => op.kind === "append")) {
        errors.push(`read failed: ${section.file}`);
        continue;
      }
      // APPEND-only 新文件（尤其是 actors/new.md）从空内容开始；父目录
      // 由最终写阶段创建，避免在发现其他 section 错误前产生副作用。
      content = "";
    }

    let next = content;
    let sectionHasError = false;
    for (const op of section.ops) {
      if (op.kind === "append") {
        next = appendText(next, op.text);
        continue;
      }

      const first = next.indexOf(op.from);
      if (first < 0) {
        errors.push(`REPLACE miss in ${section.file}: ${op.from.slice(0, 40)}`);
        sectionHasError = true;
        continue;
      }
      // 从 first + 1 开始查找，连重叠命中也视为重复，避免把“唯一命中”
      // 错当成普通 indexOf 的第一个命中。
      if (next.indexOf(op.from, first + 1) >= 0) {
        errors.push(`REPLACE multiple matches in ${section.file}: ${op.from.slice(0, 40)}`);
        sectionHasError = true;
        continue;
      }
      next = `${next.slice(0, first)}${op.to}${next.slice(first + op.from.length)}`;
    }

    plans.push({
      section,
      target,
      content,
      next,
      hasError: sectionHasError,
    });
  }

  if (errors.length > 0 || plans.some((plan) => plan.hasError)) {
    return { applied: 0, errors };
  }

  // 再做一次全量符号链接检查，确保在任何文件写入前重新确认所有目标和
  // 父目录仍是普通路径。若这里发现异常，仍保持零写入。
  for (const plan of plans) {
    const symlink = await findSymlinkInPath(workspaceDir, plan.target);
    if (symlink) errors.push(`symlink path not allowed: ${plan.section.file}`);
  }
  if (errors.length > 0) return { applied: 0, errors };

  // 所有验证与内存计算均已通过；从这里开始的 mkdir/write 异常必须抛出，
  // 由 orchestrator 的快照回滚负责恢复已写入的前序文件。
  for (const plan of plans) {
    if (plan.next === plan.content) continue;
    await fs.mkdir(path.dirname(plan.target), { recursive: true });
    await fs.writeFile(plan.target, plan.next, "utf8");
  }

  const applied = plans.reduce((sum, plan) => sum + plan.section.ops.length, 0);
  return { applied, errors: [] };
}

interface PlannedStateUpdate {
  section: StateUpdateSection;
  target: string;
  content: string;
  next: string;
  hasError: boolean;
}

function validateSections(sections: StateUpdateSection[]): string[] {
  const errors: string[] = [];
  if (!Array.isArray(sections)) return ["state-update sections are not an array"];

  const seenFiles = new Set<string>();
  for (const section of sections) {
    if (!section || typeof section.file !== "string" || !isAllowedStateFile(section.file)) {
      errors.push(`file path not allowed: ${String(section?.file ?? "")}`);
      continue;
    }
    if (seenFiles.has(section.file)) errors.push(`duplicate file section: ${section.file}`);
    seenFiles.add(section.file);

    if (!Array.isArray(section.ops) || section.ops.length === 0) {
      errors.push(`empty operations in ${section.file}`);
      continue;
    }
    for (const op of section.ops) {
      if (!op || (op.kind !== "append" && op.kind !== "replace")) {
        errors.push(`unrecognized operation in ${section.file}`);
        continue;
      }
      if (op.kind === "append") {
        if (typeof op.text !== "string" || op.text.trim() === "") {
          errors.push(`empty APPEND in ${section.file}`);
        }
        continue;
      }
      if (typeof op.from !== "string" || op.from.trim() === "") {
        errors.push(`REPLACE from is empty in ${section.file}`);
      }
      // to 可以是空字符串，表示删除；只验证其类型以保持运行时输入安全。
      if (typeof op.to !== "string") errors.push(`REPLACE to is invalid in ${section.file}`);
    }
  }
  return errors;
}

function appendText(current: string, text: string): string {
  if (current === "") return text;
  if (current.endsWith("\n")) return `${current}${text}\n`;
  return `${current}\n${text}\n`;
}

function isNodeError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}

/**
 * 返回 workspaceDir 到 target 路径上遇到的第一个符号链接；不存在的尾部
 * 路径允许留给 APPEND 的 mkdir/write 阶段创建。除 ENOENT 外的 lstat 错误
 * 是真实 I/O 异常，必须直接抛出。
 */
async function findSymlinkInPath(workspaceDir: string, target: string): Promise<string | null> {
  const root = path.resolve(workspaceDir);
  const absoluteTarget = path.resolve(target);
  const relative = path.relative(root, absoluteTarget);
  if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
    // 该情况理论上已由 isAllowedStateFile 拦截；保守起见不允许越界。
    return absoluteTarget;
  }

  let cursor = root;
  const components = relative === "" ? [] : relative.split(path.sep);
  const paths = [cursor, ...components.map((component) => (cursor = path.join(cursor, component)))];
  for (const candidate of paths) {
    let stat;
    try {
      stat = await fs.lstat(candidate);
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return null;
      throw error;
    }
    if (stat.isSymbolicLink()) return candidate;
  }
  return null;
}
