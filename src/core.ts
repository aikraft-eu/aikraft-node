/** Global SDK state: configuration, the aggregator and the background worker. */

import { AsyncLocalStorage } from "node:async_hooks";
import { Aggregator, type CallRecord } from "./aggregate.js";
import { consoleLogger, env, envFlag, type Logger, logger, setDebug, setLogger } from "./log.js";
import { cleanModel, validateTag } from "./protocol.js";
import { type Fetch, Transport } from "./transport.js";
import { VERSION } from "./version.js";
import { Worker } from "./worker.js";

export const DEFAULT_ENDPOINT = "https://api.aikraft.eu";
export const DEFAULT_FLUSH_INTERVAL_MS = 60_000;

export interface InitOptions {
  /** Workspace id, from Aikraft under Monitoring → Set up telemetry. */
  workspace: string;
  /** AI system id, from the same place. */
  system: string;
  /** Defaults to `$AIKRAFT_API_KEY`. */
  apiKey?: string | undefined;
  /** Defaults to `$AIKRAFT_ENDPOINT`, then the Aikraft API. */
  endpoint?: string | undefined;
  /** How often buffered aggregates are sent. Default 60 000 ms. */
  flushIntervalMs?: number | undefined;
  /** `false` (or `AIKRAFT_DISABLED=1`) turns everything into a no-op, e.g. in tests. */
  enabled?: boolean | undefined;
  /** Custom fetch implementation, e.g. to go through a proxy. Defaults to the global `fetch`. */
  fetch?: Fetch | undefined;
  /** Where the SDK's own diagnostics go. Defaults to the console (debug only with `debug` / `AIKRAFT_DEBUG=1`). */
  logger?: Logger | undefined;
  /** Log every payload and the server's reply (`logger.debug`). Defaults to `$AIKRAFT_DEBUG`. */
  debug?: boolean | undefined;
  /** Log payloads without sending them; no API key needed. Defaults to `$AIKRAFT_DRY_RUN`. */
  dryRun?: boolean | undefined;
}

const currentTagStorage = new AsyncLocalStorage<string | null>();

interface State {
  aggregator: Aggregator;
  worker: Worker;
}

let state: State | null = null;
let exitHookRegistered = false;

/**
 * Configure the SDK. Returns `true` if monitoring is active.
 *
 * Calling `init` again replaces the previous configuration (flushing what it had buffered).
 */
export function init(options: InitOptions): boolean {
  setLogger(options.logger ?? consoleLogger);
  const enabled = options.enabled ?? !envFlag("AIKRAFT_DISABLED");
  const dryRun = options.dryRun ?? envFlag("AIKRAFT_DRY_RUN");
  setDebug(Boolean(options.debug ?? envFlag("AIKRAFT_DEBUG")) || dryRun);
  const key = options.apiKey || env("AIKRAFT_API_KEY") || (dryRun ? "dry-run" : undefined);
  const previous = state;
  state = null;
  if (previous !== null) void previous.worker.shutdown();
  if (!enabled) return false;
  if (!key) {
    logger.warn("aikraft: no API key (pass apiKey or set AIKRAFT_API_KEY); monitoring is disabled.");
    return false;
  }
  if (!options.workspace || !options.system) throw new Error("aikraft.init() needs both workspace and system ids.");

  const aggregator = new Aggregator();
  const transport = new Transport({
    endpoint: options.endpoint || env("AIKRAFT_ENDPOINT") || DEFAULT_ENDPOINT,
    workspace: options.workspace,
    system: options.system,
    apiKey: key,
    userAgent: `aikraft-node/${VERSION}`,
    fetch: options.fetch,
    dryRun,
  });
  const worker = new Worker(aggregator, transport, options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS, VERSION);
  state = { aggregator, worker };
  if (!exitHookRegistered && typeof process !== "undefined" && typeof process.on === "function") {
    // Fires when the event loop empties (the flush timer is unref'd, so it doesn't count). Not on
    // process.exit() or signals: call `await aikraft.shutdown()` in your own SIGTERM handler.
    process.on("beforeExit", () => void shutdown());
    exitHookRegistered = true;
  }
  return true;
}

/** Hand a call to the aggregator. A no-op when the SDK isn't initialised; never throws. */
export function record(rec: CallRecord): void {
  const s = state;
  if (s === null || s.worker.disabled) return;
  try {
    s.aggregator.record(rec);
    s.worker.ensureStarted();
  } catch (err) {
    logger.error("aikraft: failed to record a call", err);
  }
}

/**
 * Record a user-feedback score (e.g. 1 for thumbs up, 0 for down) for a model and tag.
 *
 * Only the count and sum per minute are sent, never which request it was for.
 */
export function feedback(score: number, options: { model: string; tag?: string | null | undefined }): void {
  const s = state;
  if (s === null || s.worker.disabled) return;
  const tagName = validateTag(options.tag);
  try {
    s.aggregator.recordFeedback(Date.now() / 1000, cleanModel(options.model), tagName ?? currentTag(), Number(score));
    s.worker.ensureStarted();
  } catch (err) {
    logger.error("aikraft: failed to record feedback", err);
  }
}

/**
 * Label calls made inside `fn`, e.g. `aikraft.tag("support-bot", () => client.messages.create(...))`.
 *
 * Returns what `fn` returns. Async-context-local: concurrent requests never see each other's tags.
 */
export function tag<T>(name: string, fn: () => T): T {
  return currentTagStorage.run(validateTag(name), fn);
}

export function currentTag(): string | null {
  return currentTagStorage.getStore() ?? null;
}

/** Send buffered aggregates now. Await it at the end of a serverless handler. */
export async function flush(): Promise<void> {
  await state?.worker.flush();
}

/** Flush and stop the background timer. Runs automatically when the event loop empties. */
export async function shutdown(): Promise<void> {
  const s = state;
  state = null;
  await s?.worker.shutdown();
}
