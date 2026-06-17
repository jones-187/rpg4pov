import { describe, it, expect } from "vitest";
import { redactSecrets, truncateForLog, sanitizeForLog } from "@/lib/diagnostics";

describe("diagnostics", () => {
  it("redactSecrets 把 ANTHROPIC_API_KEY 值替换为 [REDACTED]", () => {
    const input = "error: ANTHROPIC_API_KEY=sk-ant-xxxxxx call failed";
    const result = redactSecrets(input);
    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain("sk-ant-xxxxxx");
  });

  it("redactSecrets 处理多种 key 出现形式（=、:、空格）", () => {
    expect(redactSecrets("ANTHROPIC_API_KEY:sk-ant-123")).toContain("[REDACTED]");
    expect(redactSecrets("ANTHROPIC_API_KEY sk-ant-123")).toContain("[REDACTED]");
  });

  it("truncateForLog 超过限长截断并标注 truncated", () => {
    const long = "x".repeat(20_000);
    const result = truncateForLog(long, 16_384);
    expect(result.length).toBeLessThan(long.length);
    expect(result).toContain("truncated");
  });

  it("truncateForLog 未超限长原样返回", () => {
    const short = "short message";
    expect(truncateForLog(short, 16_384)).toBe(short);
  });

  it("sanitizeForLog 组合脱敏 + 限长", () => {
    const input = "ANTHROPIC_API_KEY=sk-ant-xxx " + "y".repeat(20_000);
    const result = sanitizeForLog(input, 16_384);
    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain("sk-ant-xxx");
    expect(result).toContain("truncated");
  });
});
