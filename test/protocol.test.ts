import { describe, expect, it } from "vitest";
import {
  bucketIndex,
  charCount,
  cleanModel,
  EDGES,
  emptyCounts,
  type Metric,
  normalizeStopReason,
  statusFromError,
  validateTag,
} from "../src/protocol.js";

describe("protocol", () => {
  it("pins the edges to the backend contract", () => {
    // Changing these silently breaks every stored baseline; a protocol change needs a new schema version.
    expect(EDGES.latency_ms).toEqual([1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 60000]);
    const pow2 = (n: number) => Array.from({ length: n }, (_, i) => 2 ** i);
    expect(EDGES.input_tokens).toEqual(pow2(19));
    expect(EDGES.output_tokens).toEqual(pow2(19));
    expect(EDGES.output_chars).toEqual(pow2(21));
  });

  it.each([
    [0, 0],
    [0.5, 0],
    [1, 1],
    [1.5, 1],
    [2, 2],
    [999.9, 9],
    [1000, 10],
    [60000, 15],
    [1e9, 15],
  ])("buckets %d with bisect_right -> %d", (value, index) => {
    expect(bucketIndex("latency_ms", value)).toBe(index);
  });

  it("sizes empty counts as edges + 1", () => {
    for (const [metric, edges] of Object.entries(EDGES))
      expect(emptyCounts(metric as Metric)).toHaveLength(edges.length + 1);
  });

  it.each([
    ["end_turn", "end_turn"],
    ["refusal", "refusal"],
    ["pause_turn", "other"],
    ["model_context_window_exceeded", "max_tokens"],
    ["stop", "end_turn"],
    ["length", "max_tokens"],
    ["tool_calls", "tool_use"],
    ["content_filter", "content_filter"],
    ["max_output_tokens", "max_tokens"],
    ["something new", "other"],
    ["toString", "other"],
    [null, "other"],
    [3, "other"],
  ])("normalizes stop reason %s -> %s", (raw, expected) => {
    expect(normalizeStopReason(raw)).toBe(expected);
  });

  const named = (name: string, props: Record<string, unknown> = {}) => {
    const cls = { [name]: class extends Error {} }[name] as new () => Error;
    return Object.assign(new cls(), props);
  };

  it.each([
    [named("RateLimitError"), "rate_limited"],
    [named("APIConnectionTimeoutError"), "timeout"],
    [named("APIConnectionError"), "connection_error"],
    [Object.assign(new Error("connect"), { code: "ECONNREFUSED" }), "connection_error"],
    [
      new TypeError("fetch failed", { cause: Object.assign(new Error("dns"), { code: "ENOTFOUND" }) }),
      "connection_error",
    ],
    [Object.assign(new Error("slow"), { code: "ETIMEDOUT" }), "timeout"],
    [named("AuthenticationError"), "auth_error"],
    [named("OverloadedError"), "server_error"],
    [named("BadRequestError"), "bad_request"],
    [named("SomethingElse", { status: 503 }), "server_error"],
    [named("SomethingElse", { status: 429 }), "rate_limited"],
    [new TypeError("x"), "error"],
    ["a string", "error"],
  ])("maps error %o -> %s", (err, status) => {
    expect(statusFromError(err)).toBe(status);
  });

  it("keeps SDK timeouts as timeouts although they subclass the connection error", () => {
    class APIConnectionError extends Error {}
    class APIConnectionTimeoutError extends APIConnectionError {}
    expect(statusFromError(new APIConnectionTimeoutError())).toBe("timeout");
    expect(statusFromError(new APIConnectionError())).toBe("connection_error");
  });

  it("follows subclasses", () => {
    class RateLimitError extends Error {}
    class MyRateLimit extends RateLimitError {}
    expect(statusFromError(new MyRateLimit())).toBe("rate_limited");
  });

  it("cleans models and validates tags", () => {
    expect(cleanModel("")).toBe("unknown");
    expect(cleanModel(undefined)).toBe("unknown");
    expect(cleanModel("m".repeat(500))).toHaveLength(128);
    expect(validateTag("support-bot.v2")).toBe("support-bot.v2");
    expect(validateTag(undefined)).toBeNull();
    expect(() => validateTag("has space")).toThrow(/Invalid aikraft tag/);
  });

  it("counts characters in code points like Python's len()", () => {
    expect(charCount("héllo")).toBe(5);
    expect(charCount("👋🏽 hi")).toBe(5);
    expect(charCount("\ud83d") + charCount("\udc4b")).toBe(1); // a pair split across stream deltas
  });
});
