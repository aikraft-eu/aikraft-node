import { describe, expect, it } from "vitest";
import { Aggregator, type Payload } from "../src/aggregate.js";
import { assertValidPayload } from "./contract.js";
import { rec, T0 } from "./helpers.js";

describe("Aggregator", () => {
  it("merges the same minute, model and tag", () => {
    const agg = new Aggregator();
    agg.record(rec({ ts: T0 + 1 }));
    agg.record(rec({ ts: T0 + 59, latency_ms: 3000, stop_reason: "max_tokens" }));
    const [w, ...rest] = agg.drain();
    expect(rest).toEqual([]);
    expect(w?.calls).toBe(2);
    expect(w?.start).toBe("2025-10-09T08:54:00+00:00");
    expect(w?.end).toBe("2025-10-09T08:55:00+00:00");
    const lat = w?.histograms.latency_ms;
    expect(lat?.counts.reduce((a, b) => a + b)).toBe(2);
    expect(lat?.sum).toBe(3800);
    expect(lat?.counts[9]).toBe(1); // 800 in [500, 1000)
    expect(lat?.counts[11]).toBe(1); // 3000 in [2000, 5000)
    expect(w?.categories).toEqual({ stop_reason: { end_turn: 1, max_tokens: 1 }, status: { ok: 2 } });
  });

  it("keeps different minutes, models and tags separate", () => {
    const agg = new Aggregator();
    agg.record(rec());
    agg.record(rec({ ts: T0 + 60 }));
    agg.record(rec({ model: "other" }));
    agg.record(rec({ tag: "bot" }));
    expect(agg.drain()).toHaveLength(4);
  });

  it("skips missing values instead of zeroing them", () => {
    const agg = new Aggregator();
    agg.record(rec({ input_tokens: null, output_tokens: null, output_chars: null }));
    agg.record(rec({ stop_reason: null, status: "rate_limited" }));
    const [w] = agg.drain();
    expect(w?.calls).toBe(2);
    expect(w?.histograms.input_tokens?.counts.reduce((a, b) => a + b)).toBe(1);
    expect(w?.categories).toEqual({ stop_reason: { end_turn: 1 }, status: { ok: 1, rate_limited: 1 } });
  });

  it("empties the buffer on drain", () => {
    const agg = new Aggregator();
    agg.record(rec());
    expect(agg.pending()).toBe(1);
    agg.drain();
    expect(agg.pending()).toBe(0);
    expect(agg.drain()).toEqual([]);
  });

  it("caps batches at 50 windows, each with its own batch_id", () => {
    const agg = new Aggregator();
    for (let i = 0; i < 120; i++) agg.record(rec({ ts: T0 + 60 * i }));
    const batches = agg.drainBatches("1.2.3");
    expect(batches.map((b) => b.windows.length)).toEqual([50, 50, 20]);
    expect(new Set(batches.map((b) => b.batch_id)).size).toBe(3);
    for (const b of batches) {
      assertValidPayload(b);
      expect(b.sdk).toEqual({ name: "aikraft-node", version: "1.2.3" });
    }
    expect(batches[0]?.windows[1]?.start).toBe("2025-10-09T08:55:00+00:00"); // sorted by start
  });

  it("counts calls beyond the window cap as dropped", () => {
    const agg = new Aggregator(2);
    for (let i = 0; i < 5; i++) agg.record(rec({ model: `m${i}` }));
    expect(agg.pending()).toBe(2);
    expect(agg.dropped).toBe(3);
  });

  it("produces a valid feedback-only window", () => {
    const agg = new Aggregator();
    agg.recordFeedback(T0, "m", null, 1);
    agg.recordFeedback(T0, "m", null, 0);
    const [batch] = agg.drainBatches("0");
    assertValidPayload(batch as Payload);
    expect(batch?.windows[0]?.calls).toBe(0);
    expect(batch?.windows[0]?.feedback).toEqual({ count: 2, sum: 1 });
  });
});
