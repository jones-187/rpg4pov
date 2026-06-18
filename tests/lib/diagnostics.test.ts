import { describe, it, expect } from "vitest";
import { redactSecrets, truncateForLog, sanitizeForLog } from "@/lib/diagnostics";

describe("diagnostics", () => {
  it("redactSecrets 把 ANTHROPIC_API_KEY 值替换为 [REDACTED]（精确断言）", () => {
    const input = "error: ANTHROPIC_API_KEY=sk-ant-xxxxxx call failed";
    expect(redactSecrets(input)).toBe("error: ANTHROPIC_API_KEY=[REDACTED] call failed");
  });

  it("redactSecrets 处理多种 key 出现形式（=、:、空格，精确断言）", () => {
    expect(redactSecrets("ANTHROPIC_API_KEY:sk-ant-123")).toBe("ANTHROPIC_API_KEY=[REDACTED]");
    expect(redactSecrets("ANTHROPIC_API_KEY sk-ant-123")).toBe("ANTHROPIC_API_KEY=[REDACTED]");
  });

  it("redactSecrets 同一字符串多个 key 都被脱敏（验证 g 标志）", () => {
    const input = "ANTHROPIC_API_KEY=sk-ant-1 then ANTHROPIC_API_KEY=sk-ant-2";
    const result = redactSecrets(input);
    expect(result).toBe("ANTHROPIC_API_KEY=[REDACTED] then ANTHROPIC_API_KEY=[REDACTED]");
    expect(result).not.toContain("sk-ant-1");
    expect(result).not.toContain("sk-ant-2");
  });

  it("redactSecrets 脱敏 ANTHROPIC_AUTH_TOKEN（第三方 API 兼容）", () => {
    const input = "error: ANTHROPIC_AUTH_TOKEN=sk-9l5lpWha40xJ7kYWzrxFOIaNYtotHvaxLXduDTvaGSLsbvgk call failed";
    expect(redactSecrets(input)).toBe("error: ANTHROPIC_AUTH_TOKEN=[REDACTED] call failed");
  });

  it("redactSecrets 脱敏 ANTHROPIC_BASE_URL（第三方代理 URL 可能含认证信息）", () => {
    const input = "ANTHROPIC_BASE_URL=https://proxy.example.com/my-secret-key/v1";
    expect(redactSecrets(input)).toBe("ANTHROPIC_BASE_URL=[REDACTED]");
  });

  it("redactSecrets 同时脱敏 ANTHROPIC_API_KEY、ANTHROPIC_AUTH_TOKEN 和 ANTHROPIC_BASE_URL", () => {
    const input = "ANTHROPIC_API_KEY=sk-ant-1 and ANTHROPIC_AUTH_TOKEN=sk-custom-2 and ANTHROPIC_BASE_URL=https://proxy/v1";
    const result = redactSecrets(input);
    expect(result).toBe("ANTHROPIC_API_KEY=[REDACTED] and ANTHROPIC_AUTH_TOKEN=[REDACTED] and ANTHROPIC_BASE_URL=[REDACTED]");
    expect(result).not.toContain("sk-ant-1");
    expect(result).not.toContain("sk-custom-2");
    expect(result).not.toContain("proxy");
  });

  it("redactSecrets 大小写不敏感且保留原始 key 大小写（验证 i 标志 + 捕获组）", () => {
    expect(redactSecrets("anthropic_api_key=sk-ant-1")).toBe("anthropic_api_key=[REDACTED]");
    expect(redactSecrets("Anthropic_Api_Key=sk-ant-2")).toBe("Anthropic_Api_Key=[REDACTED]");
  });

  it("redactSecrets 不含 key 的字符串原样返回", () => {
    const input = "just a normal log line without secrets";
    expect(redactSecrets(input)).toBe(input);
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

  it("truncateForLog text.length === limit 边界原样返回（验证 <= 边界）", () => {
    const exact = "y".repeat(16_384);
    expect(truncateForLog(exact, 16_384)).toBe(exact);
  });

  it("sanitizeForLog 组合脱敏 + 限长", () => {
    const input = "ANTHROPIC_API_KEY=sk-ant-xxx " + "y".repeat(20_000);
    const result = sanitizeForLog(input, 16_384);
    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain("sk-ant-xxx");
    expect(result).toContain("truncated");
  });
});
