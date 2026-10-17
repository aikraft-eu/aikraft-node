import { afterEach, describe, expect, it, vi } from "vitest";
import { Aggregator, type Payload } from "../src/aggregate.js";
import * as aikraft from "../src/index.js";
import { setDebug, setLogger } from "../src/log.js";
import { type Fetch, SendResult, Transport } from "../src/transport.js";
import { Worker } from "../src/worker.js";
import { rec, useSink } from "./helpers.js";

const PAYLOAD = { schema: "aikraft.llm.v1", batch_id: "b-1", sdk: { name: "t", version: "0" }, windows: [] } as Payload;

const quiet = { debug: () => {}, warn: vi.fn(), error: vi.fn() };
setLogger(quiet);

function transport(handler: Fetch, sleeps?: number[]): Transport {
  return new Transport({
    endpoint: "https://api.example/",
    workspace: "ws",
    system: "sys",
    apiKey: "ak_test_secret",
    userAgent: "aikraft-node/test",
    fetch: handler,
    sleep: async (s) => void sleeps?.push(s),
  });
}

const respond = (status: number, headers: Record<string, string> = {}) => Response.json({}, { status, headers });

describe("Transport", () => {
  it("posts to the ingest URL with auth and user agent", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const t = transport(async (url, init) => {
      seen.push({ url, init });
      return respond(200);
    });
    expect(await t.send(PAYLOAD)).toBe(SendResult.OK);
    expect(seen[0]?.url).toBe("https://api.example/v1/workspaces/ws/systems/sys/monitoring/aggregates:ingest");
    const headers = new Headers(seen[0]?.init.headers);
    expect(headers.get("Authorization")).toBe("Bearer ak_test_secret");
    expect(headers.get("User-Agent")).toBe("aikraft-node/test");
    expect(headers.get("Content-Type")).toBe("application/json");
  });

  it("retries transient errors with the same payload", async () => {
    const bodies: Payload[] = [];
    const responses = [respond(503), respond(429, { "Retry-After": "7" }), respond(200)];
    const sleeps: number[] = [];
    const t = transport(async (_url, init) => {
      bodies.push(JSON.parse(String(init.body)));
      return responses.shift() as Response;
    }, sleeps);
    expect(await t.send(PAYLOAD)).toBe(SendResult.OK);
    expect(bodies.map((b) => b.batch_id)).toEqual(["b-1", "b-1", "b-1"]);
    expect(sleeps).toEqual([0.5, 7]); // backoff, then Retry-After wins over backoff
  });

  it("retries network errors, then gives up", async () => {
    const sleeps: number[] = [];
    const t = transport(async () => {
      throw new TypeError("fetch failed");
    }, sleeps);
    expect(await t.send(PAYLOAD)).toBe(SendResult.RETRY);
    expect(sleeps).toEqual([0.5, 1]);
  });

  it.each([
    [401, SendResult.FATAL],
    [403, SendResult.FATAL],
    [422, SendResult.DROP],
  ])("does not retry HTTP %d", async (code, result) => {
    let calls = 0;
    const t = transport(async () => {
      calls++;
      return respond(code);
    });
    expect(await t.send(PAYLOAD)).toBe(result);
    expect(calls).toBe(1);
  });
});

function worker(handler: Fetch): { worker: Worker; agg: Aggregator } {
  const agg = new Aggregator();
  return { worker: new Worker(agg, transport(handler), 3_600_000, "t"), agg };
}

describe("Worker", () => {
  it("keeps failed payloads and resends them with the same batch_id", async () => {
    const sent: string[] = [];
    let up = false;
    const { worker: w, agg } = worker(async (_url, init) => {
      sent.push(JSON.parse(String(init.body)).batch_id);
      return respond(up ? 200 : 503);
    });
    agg.record(rec());
    await w.flush();
    const firstId = sent[0];
    expect(new Set(sent)).toEqual(new Set([firstId])); // 3 attempts of the same batch
    up = true;
    agg.record(rec({ model: "new" }));
    await w.flush();
    expect(sent[3]).toBe(firstId); // the kept batch goes first
    expect(new Set(sent).size).toBe(2);
  });

  it("stops sending after a fatal response", async () => {
    let calls = 0;
    const { worker: w, agg } = worker(async () => {
      calls++;
      return respond(401);
    });
    agg.record(rec());
    await w.flush();
    expect(w.disabled).toBe(true);
    agg.record(rec());
    await w.flush();
    expect(calls).toBe(1);
  });

  it("runs concurrent flushes one at a time", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const { worker: w, agg } = worker(async () => {
      maxInFlight = Math.max(maxInFlight, ++inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return respond(200);
    });
    agg.record(rec());
    const first = w.flush();
    agg.record(rec({ model: "b" }));
    await Promise.all([first, w.flush()]);
    expect(maxInFlight).toBe(1);
  });

  it("never rejects", async () => {
    const { worker: w, agg } = worker(async () => respond(200));
    vi.spyOn(agg, "drainBatches").mockImplementation(() => {
      throw new Error("bug");
    });
    await expect(w.flush()).resolves.toBeUndefined();
    expect(quiet.error).toHaveBeenCalled();
  });

  it("does not keep the process alive", () => {
    const { worker: w } = worker(async () => respond(200));
    const spy = vi.spyOn(globalThis, "setInterval");
    w.ensureStarted();
    const timer = spy.mock.results[0]?.value as NodeJS.Timeout;
    expect(timer.hasRef()).toBe(false);
    spy.mockRestore();
    return w.shutdown();
  });
});

describe("init", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    return aikraft.shutdown();
  });

  it("is a quiet no-op without an API key", async () => {
    vi.stubEnv("AIKRAFT_API_KEY", "");
    expect(aikraft.init({ workspace: "ws", system: "sys", logger: quiet })).toBe(false);
    await aikraft.flush();
  });

  it("can be disabled by env", () => {
    vi.stubEnv("AIKRAFT_DISABLED", "1");
    expect(aikraft.init({ workspace: "ws", system: "sys", apiKey: "ak_test_x" })).toBe(false);
  });

  it("needs workspace and system ids", () => {
    expect(() => aikraft.init({ workspace: "", system: "sys", apiKey: "ak_test_x" })).toThrow(/workspace and system/);
  });
});

describe("feedback", () => {
  const sink = useSink();

  it("is sent as count and sum", async () => {
    aikraft.feedback(1, { model: "m", tag: "bot" });
    aikraft.feedback(0, { model: "m", tag: "bot" });
    const [w, ...rest] = await sink.current.windows();
    expect(rest).toEqual([]);
    expect(w?.feedback).toEqual({ count: 2, sum: 1 });
    expect(w?.tag).toBe("bot");
  });

  it("uses the current tag", async () => {
    aikraft.tag("support", () => aikraft.feedback(1, { model: "m" }));
    const [w] = await sink.current.windows();
    expect(w?.tag).toBe("support");
  });
});

describe("debug and dry run", () => {
  const lines: string[] = [];
  const capture = { debug: (m: string) => void lines.push(m), warn: vi.fn(), error: vi.fn() };

  afterEach(async () => {
    lines.length = 0;
    await aikraft.shutdown();
    vi.unstubAllEnvs();
    setDebug(false);
    setLogger(quiet);
  });

  it("logs the payload and the reply, never the key", async () => {
    setLogger(capture);
    setDebug(true);
    const t = transport(async () => Response.json({ accepted: 0 }, { status: 200 }));
    expect(await t.send(PAYLOAD)).toBe(SendResult.OK);
    const out = lines.join("\n");
    expect(out).toContain("sending batch b-1 (0 windows)");
    expect(out).toContain('"schema": "aikraft.llm.v1"');
    expect(out).toContain('HTTP 200 {"accepted":0}');
    expect(out).not.toContain("ak_test_secret");
  });

  it("dry run logs without sending", async () => {
    setLogger(capture);
    const fetch = vi.fn<Fetch>();
    const t = new Transport({
      endpoint: "https://api.example",
      workspace: "ws",
      system: "sys",
      apiKey: "dry-run",
      userAgent: "t",
      fetch,
      dryRun: true,
    });
    expect(await t.send(PAYLOAD)).toBe(SendResult.OK);
    expect(fetch).not.toHaveBeenCalled();
    expect(lines.join("\n")).toContain("dry run, not sending batch b-1");
  });

  it("init dry run needs no key and sends nothing", async () => {
    vi.stubEnv("AIKRAFT_API_KEY", "");
    vi.stubEnv("AIKRAFT_DRY_RUN", "1");
    const fetch = vi.fn<Fetch>();
    expect(aikraft.init({ workspace: "ws", system: "sys", fetch, logger: capture })).toBe(true);
    aikraft.feedback(1, { model: "m" });
    await aikraft.flush();
    expect(fetch).not.toHaveBeenCalled();
    const out = lines.join("\n");
    expect(out).toContain('"feedback": {');
    expect(out).toContain('"count": 1');
  });

  it("debug option logs what is sent", async () => {
    const fetch = vi.fn<Fetch>(async () => Response.json({ accepted: 1 }, { status: 200 }));
    expect(
      aikraft.init({ workspace: "ws", system: "sys", apiKey: "ak_test_x", fetch, logger: capture, debug: true }),
    ).toBe(true);
    aikraft.feedback(0, { model: "m" });
    await aikraft.flush();
    expect(fetch).toHaveBeenCalledOnce();
    const out = lines.join("\n");
    expect(out).toContain("sending batch");
    expect(out).toContain("HTTP 200");
    expect(out).toMatch(/"counts": \[|"feedback": \{/);
  });
});
