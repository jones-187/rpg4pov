/**
 * 诊断日志工具（Issue 6）。
 * Claude stdout/stderr 在失败时写入 logs/turn-errors.log 前必须脱敏 + 限长。
 * 成功回合不写 stdout/stderr 到 workspace。
 */

const DEFAULT_LOG_LIMIT = 16_384; // 16KB

/** 把敏感凭证值替换为 [REDACTED]，处理 =/:/空格 分隔形式 */
export function redactSecrets(text: string): string {
  // 匹配敏感 key 后跟分隔符（=、:、空白其一或多个）和值（值到下一个空白或行尾）
  // 使用捕获组 $1 保留原始 key 大小写（小写/混合形式不被强制大写化）
  // 注：空白分隔会误吞后续 token（如 "KEY is set" → "KEY=[REDACTED]"），
  // 但脱敏场景下过度脱敏优于漏脱敏，故接受该副作用。
  return text
    .replace(/(ANTHROPIC_API_KEY)[\s:=]+\S+/gi, "$1=[REDACTED]")
    .replace(/(ANTHROPIC_AUTH_TOKEN)[\s:=]+\S+/gi, "$1=[REDACTED]");
}

/** 超过限长截断并标注 truncated */
export function truncateForLog(text: string, limit: number = DEFAULT_LOG_LIMIT): string {
  if (text.length <= limit) return text;
  return text.slice(0, limit) + "\n...[truncated]";
}

/** 组合脱敏 + 限长（失败诊断写入日志前调用） */
export function sanitizeForLog(text: string, limit: number = DEFAULT_LOG_LIMIT): string {
  return truncateForLog(redactSecrets(text), limit);
}
