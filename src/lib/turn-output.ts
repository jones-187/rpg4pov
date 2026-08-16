import { TURN_OUTPUT_PLACEHOLDER } from "./workspace";

/**
 * 主角视窗输出校验（Issue 9，arch-prd US 45「basic output validation」/ Decision 34）。
 * 只做"明显不合规"的粗判：缺失/占位、失控超长、缺标题契约、确凿的 JSON 转储、
 * 随机日志行或 interaction.json 原文逐字外泄（extraLeakFingerprints，Issue 12 扩展）。
 * 语义级泄漏审查（可见性/知识违规）是 P1，不在此层。
 *
 * 返回问题描述（内部 reason，进 TurnOutcome.error 与错误日志）或 null（通过）。
 */

/** output.md 首行标题契约。prompt 要求原样写入；前端渲染时剥掉。 */
export const TURN_OUTPUT_HEADING = "# 主角视窗";

/**
 * 失控长度上限。正常回合叙事远低于此，只拦截 runaway 输出（如 agent 把
 * 大量结构化内容糊进 output），不是内容质量门槛。
 */
export const MAX_TURN_OUTPUT_CHARS = 50_000;

export function validateTurnOutput(
  content: string | null,
  randomRollLines: string[] = [],
  extraLeakFingerprints: string[] = [],
): string | null {
  // 存在性 + 占位残留（Issue 4 语义，reason 供 orchestrator 测试与日志沿用）
  if (content === null || content.trim() === "" || content === TURN_OUTPUT_PLACEHOLDER) {
    return "output missing or empty";
  }

  if (content.length > MAX_TURN_OUTPUT_CHARS) {
    return `output format invalid: exceeds ${MAX_TURN_OUTPUT_CHARS} chars`;
  }

  // 首行标题契约：第一个非空行（trim 后）必须恰为主角视窗标题
  const lines = content.split("\n");
  const headingIdx = lines.findIndex((line) => line.trim() !== "");
  if (headingIdx === -1 || lines[headingIdx].trim() !== TURN_OUTPUT_HEADING) {
    return `output format invalid: first line must be ${TURN_OUTPUT_HEADING}`;
  }

  // 明显非叙事：正文整体是合法 JSON（agent 把 CLI 结构化输出当叙事写入）
  const body = lines.slice(headingIdx + 1).join("\n").trim();
  const bodyStart = body.charAt(0);
  if ((bodyStart === "{" || bodyStart === "[") && parsesAsJson(body)) {
    return "output format invalid: content is JSON, not narrative";
  }

  // 随机日志指纹：logs/random-rolls.jsonl 的行被逐字抄进 output（内部日志外泄）
  const rollLine = randomRollLines
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .find((line) => content.includes(line));
  if (rollLine !== undefined) {
    return "output format invalid: random log content leaked";
  }

  // Issue 12 扩展：interaction.json 原文逐字外泄（交互元数据是内部状态）。
  // 与随机日志分开报因——诊断日志需区分是哪类内部状态泄漏。
  const interactionLine = extraLeakFingerprints
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .find((line) => content.includes(line));
  if (interactionLine !== undefined) {
    return "output format invalid: interaction state leaked";
  }

  return null;
}

function parsesAsJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}
