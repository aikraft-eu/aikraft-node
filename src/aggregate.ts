/** In-memory aggregation of LLM calls into per-minute windows (no request data is kept). */

import {
  bucketIndex,
  EDGES,
  emptyCounts,
  MAX_WINDOWS_PER_REQUEST,
  type Metric,
  SCHEMA,
  WINDOW_SECONDS,
} from "./protocol.js";

const HISTOGRAM_FIELDS = ["latency_ms", "input_tokens", "output_tokens", "output_chars"] as const satisfies Metric[];

/** One completed (or failed) model call, reduced to the numbers we aggregate. */
export interface CallRecord {
  ts: number; // epoch seconds when the call finished
  model: string;
  tag: string | null;
  latency_ms: number;
  input_tokens: number | null;
  output_tokens: number | null;
  output_chars: number | null;
  stop_reason: string | null; // protocol vocabulary; null for failed calls
  status: string; // protocol vocabulary
}

export interface WireWindow {
  start: string;
  end: string;
  model: string;
  tag: string | null;
  calls: number;
  histograms: Record<string, { counts: number[]; sum: number }>;
  categories: Record<string, Record<string, number>>;
  feedback?: { count: number; sum: number };
}

export interface Payload {
  schema: string;
  batch_id: string;
  sdk: { name: string; version: string };
  windows: WireWindow[];
}

class Window {
  calls = 0;
  readonly counts = new Map<Metric, number[]>();
  readonly sums = new Map<Metric, number>();
  readonly categories: Record<"stop_reason" | "status", Map<string, number>> = {
    stop_reason: new Map(),
    status: new Map(),
  };
  feedbackCount = 0;
  feedbackSum = 0;

  constructor(
    readonly start: number,
    readonly model: string,
    readonly tag: string | null,
  ) {}

  addValue(metric: Metric, value: number): void {
    let counts = this.counts.get(metric);
    if (counts === undefined) {
      counts = emptyCounts(metric);
      this.counts.set(metric, counts);
    }
    const i = bucketIndex(metric, value);
    counts[i] = (counts[i] ?? 0) + 1;
    this.sums.set(metric, (this.sums.get(metric) ?? 0) + value);
  }
}

/**
 * Buffer of per-(minute, model, tag) windows.
 *
 * The number of open windows is capped; calls beyond the cap are counted in `dropped` instead of growing memory.
 */
export class Aggregator {
  private windows = new Map<string, Window>();
  dropped = 0;

  constructor(private readonly maxWindows = 1000) {}

  private window(ts: number, model: string, tag: string | null): Window | null {
    const start = Math.floor(ts / WINDOW_SECONDS) * WINDOW_SECONDS;
    // Tags never contain NUL and are never empty, so this key is unambiguous.
    const key = `${start}\0${model}\0${tag ?? ""}`;
    let window = this.windows.get(key);
    if (window === undefined) {
      if (this.windows.size >= this.maxWindows) {
        this.dropped += 1;
        return null;
      }
      window = new Window(start, model, tag);
      this.windows.set(key, window);
    }
    return window;
  }

  record(rec: CallRecord): void {
    const window = this.window(rec.ts, rec.model, rec.tag);
    if (window === null) return;
    window.calls += 1;
    for (const metric of HISTOGRAM_FIELDS) {
      const value = rec[metric];
      if (value !== null && Number.isFinite(value)) window.addValue(metric, Math.max(value, 0));
    }
    if (rec.stop_reason !== null) increment(window.categories.stop_reason, rec.stop_reason);
    increment(window.categories.status, rec.status);
  }

  recordFeedback(ts: number, model: string, tag: string | null, score: number): void {
    const window = this.window(ts, model, tag);
    if (window !== null) {
      window.feedbackCount += 1;
      window.feedbackSum += score;
    }
  }

  pending(): number {
    return this.windows.size;
  }

  /** Remove and return all buffered windows in wire format. */
  drain(): WireWindow[] {
    const windows = [...this.windows.values()];
    this.windows = new Map();
    windows.sort((a, b) => a.start - b.start || compare(a.model, b.model) || compare(a.tag ?? "", b.tag ?? ""));
    return windows.map((w) => {
      const histograms: WireWindow["histograms"] = {};
      for (const [metric, counts] of w.counts) {
        if (metric in EDGES) histograms[metric] = { counts, sum: round3(w.sums.get(metric) ?? 0) };
      }
      const categories: WireWindow["categories"] = {};
      for (const [name, counter] of Object.entries(w.categories)) {
        if (counter.size) categories[name] = Object.fromEntries(counter);
      }
      const item: WireWindow = {
        start: iso(w.start),
        end: iso(w.start + WINDOW_SECONDS),
        model: w.model,
        tag: w.tag,
        calls: w.calls,
        histograms,
        categories,
      };
      if (w.feedbackCount) item.feedback = { count: w.feedbackCount, sum: w.feedbackSum };
      return item;
    });
  }

  /**
   * Drain into request payloads of at most 50 windows, each with its own `batch_id`.
   *
   * The `batch_id` makes a payload idempotent: retrying the same payload never double-counts.
   */
  drainBatches(sdkVersion: string): Payload[] {
    const windows = this.drain();
    const out: Payload[] = [];
    for (let i = 0; i < windows.length; i += MAX_WINDOWS_PER_REQUEST) {
      out.push({
        schema: SCHEMA,
        batch_id: crypto.randomUUID(),
        sdk: { name: "aikraft-node", version: sdkVersion },
        windows: windows.slice(i, i + MAX_WINDOWS_PER_REQUEST),
      });
    }
    return out;
  }
}

function increment(counter: Map<string, number>, key: string): void {
  counter.set(key, (counter.get(key) ?? 0) + 1);
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** Same format as the Python SDK: `2026-10-08T14:00:00+00:00`. */
function iso(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString().replace(/\.\d{3}Z$/, "+00:00");
}
