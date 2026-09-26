import { describe, expect, it } from "vitest";
import {
  buildReviewPrompt,
  createReviewerModelsJson,
  parseSemanticReview,
} from "../../scripts/semantic-review-ab-eval.cjs";

describe("semantic-review-ab-eval", () => {
  it("accepts only an exact pass or reject envelope", () => {
    expect(parseSemanticReview('{"verdict":"pass","issues":[]}')).toEqual({ pass: true });
    expect(parseSemanticReview('{"verdict":"reject","issues":["无来源截止时间"]}'))
      .toEqual({ pass: false, issues: ["无来源截止时间"] });
    expect(() => parseSemanticReview('{"verdict":"pass","issues":["x"]}')).toThrow();
    expect(() => parseSemanticReview('{"verdict":"reject","issues":[]}')).toThrow();
    expect(() => parseSemanticReview('{"verdict":"pass","issues":[],"extra":1}')).toThrow();
  });

  it("keeps authoritative context and candidate in separate tagged sections", () => {
    const prompt = buildReviewPrompt({
      authoritativeContext: "玩家尚未决定",
      candidateResponse: '{"output":"玩家已经同意"}',
    });
    expect(prompt).toContain("<authoritative_context>\n玩家尚未决定\n</authoritative_context>");
    expect(prompt).toContain('<candidate_response>\n{"output":"玩家已经同意"}\n</candidate_response>');
  });

  it("builds an isolated reviewer provider without exposing another model", () => {
    const parsed = JSON.parse(createReviewerModelsJson({
      baseUrl: "https://gateway.example/v1/",
      apiKey: "secret",
      reviewerModel: "kimi-k3",
    }));
    expect(parsed.providers["newapi-review"].baseUrl).toBe("https://gateway.example/v1");
    expect(parsed.providers["newapi-review"].models).toEqual([
      expect.objectContaining({ id: "kimi-k3", reasoning: true }),
    ]);
    expect(JSON.stringify(parsed)).not.toContain("deepseek");
  });
});
