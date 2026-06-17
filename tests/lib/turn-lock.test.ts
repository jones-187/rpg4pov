import { describe, it, expect, beforeEach } from "vitest";
import { TurnLock, TurnBusyError } from "@/lib/turn-lock";

describe("TurnLock", () => {
  let lock: TurnLock;
  beforeEach(() => {
    lock = new TurnLock();
  });

  it("first acquire succeeds and returns a release function", () => {
    const release = lock.acquire("story-1");
    expect(typeof release).toBe("function");
  });

  it("second acquire for same storyId throws TurnBusyError", () => {
    lock.acquire("story-1");
    expect(() => lock.acquire("story-1")).toThrow(TurnBusyError);
  });

  it("different storyId can be acquired independently", () => {
    lock.acquire("story-1");
    expect(() => lock.acquire("story-2")).not.toThrow();
  });

  it("release allows re-acquire for same storyId", () => {
    const release = lock.acquire("story-1");
    release();
    expect(() => lock.acquire("story-1")).not.toThrow();
  });

  it("release is idempotent (calling twice does not throw)", () => {
    const release = lock.acquire("story-1");
    release();
    expect(() => release()).not.toThrow();
  });

  it("TurnBusyError carries the storyId", () => {
    lock.acquire("story-1");
    try {
      lock.acquire("story-1");
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(TurnBusyError);
      expect((e as TurnBusyError).storyId).toBe("story-1");
    }
  });

  it("isReleased reports state correctly", () => {
    expect(lock.isReleased("story-1")).toBe(true);
    lock.acquire("story-1");
    expect(lock.isReleased("story-1")).toBe(false);
  });
});
