import { describe, expect, it } from "vitest";
import registerJsonResponse from "../../pi-extensions/json-response";

describe("Pi JSON response request constraint", () => {
  it("sets JSON mode without changing messages, model, thinking or token budget", () => {
    let handler: ((event: { payload: unknown }) => unknown) | undefined;
    registerJsonResponse({ on(event, callback) {
      expect(event).toBe("before_provider_request");
      handler = callback;
    } });
    const payload = { model: "qwen-fp8", messages: [{ role: "user", content: "故事" }],
      max_completion_tokens: 16384, chat_template_kwargs: { enable_thinking: false } };
    expect(handler?.({ payload })).toEqual({ ...payload, response_format: { type: "json_object" } });
    expect(payload).not.toHaveProperty("response_format");
  });
});
