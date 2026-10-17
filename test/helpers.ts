import { afterEach, beforeEach } from "vitest";
import type { CallRecord, Payload, WireWindow } from "../src/aggregate.js";
import * as aikraft from "../src/index.js";
import { assertValidPayload } from "./contract.js";

/** Captures what the SDK would send to the Aikraft API. */
export class Sink {
  readonly requests: { url: string; headers: Headers; body: string }[] = [];
  status = 200;

  readonly fetch = async (url: string, init: RequestInit): Promise<Response> => {
    this.requests.push({ url, headers: new Headers(init.headers), body: String(init.body) });
    return Response.json({ accepted: 1, duplicate: false }, { status: this.status });
  };

  get payloads(): Payload[] {
    const out = this.requests.map((r) => JSON.parse(r.body) as Payload);
    for (const p of out) assertValidPayload(p);
    return out;
  }

  async windows(): Promise<WireWindow[]> {
    await aikraft.flush();
    return this.payloads.flatMap((p) => p.windows);
  }
}

/** Initialises the SDK against a fresh Sink before each test and shuts it down after. */
export function useSink(): { current: Sink } {
  const ref = { current: new Sink() };
  beforeEach(() => {
    ref.current = new Sink();
    const ok = aikraft.init({
      workspace: "ws-1",
      system: "sys-1",
      apiKey: "ak_test_x",
      endpoint: "https://api.example",
      flushIntervalMs: 3_600_000,
      fetch: ref.current.fetch,
    });
    if (!ok) throw new Error("init failed");
  });
  afterEach(() => aikraft.shutdown());
  return ref;
}

export const T0 = 1_760_000_040; // a whole minute

export function rec(overrides: Partial<CallRecord> = {}): CallRecord {
  return {
    ts: T0,
    model: "m",
    tag: null,
    latency_ms: 800,
    input_tokens: 100,
    output_tokens: 20,
    output_chars: 90,
    stop_reason: "end_turn",
    status: "ok",
    ...overrides,
  };
}
