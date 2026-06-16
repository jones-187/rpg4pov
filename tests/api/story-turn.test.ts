import { describe, it, expect } from "vitest";
import { POST } from "@/app/api/story-turn/route";

function jsonReq(body: unknown): Request {
  return new Request("http://localhost/api/story-turn", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/story-turn (placeholder)", () => {
  it("returns 200 with a non-empty playerResponse", async () => {
    const res = await POST(jsonReq({ input: "我走向酒馆门口" }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(typeof json.playerResponse).toBe("string");
    expect(json.playerResponse.length).toBeGreaterThan(0);
  });

  it("echoes the input inside the placeholder narration", async () => {
    const res = await POST(jsonReq({ input: "推开木门" }));
    const json = await res.json();
    expect(json.playerResponse).toContain("推开木门");
  });

  it("returns 400 when input is missing or empty", async () => {
    const res = await POST(jsonReq({ input: "   " }));
    expect(res.status).toBe(400);
  });

  it("returns 400 when body is not valid JSON", async () => {
    const req = new Request("http://localhost/api/story-turn", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not-json",
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });
});
