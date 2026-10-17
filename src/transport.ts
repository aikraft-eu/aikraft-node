/** HTTP delivery of aggregate payloads to the Aikraft API. */

import type { Payload } from "./aggregate.js";
import { debugEnabled, logger } from "./log.js";

export const SendResult = {
  OK: "ok", // stored (or already stored: duplicate batch_id)
  RETRY: "retry", // transient failure; keep the payload and try again later
  DROP: "drop", // the server rejected this payload; retrying won't help
  FATAL: "fatal", // bad credentials or permissions; stop sending
} as const;
export type SendResult = (typeof SendResult)[keyof typeof SendResult];

export const MAX_RETRY_AFTER_SECONDS = 30;

export type Fetch = (input: string, init: RequestInit) => Promise<Response>;

export interface TransportOptions {
  endpoint: string;
  workspace: string;
  system: string;
  apiKey: string;
  userAgent: string;
  timeoutMs?: number;
  maxAttempts?: number;
  backoffBaseSeconds?: number;
  fetch?: Fetch | undefined;
  sleep?: (seconds: number) => Promise<void>;
  /** Log payloads and replies but never send (no API key needed). */
  dryRun?: boolean | undefined;
}

export class Transport {
  readonly url: string;
  private readonly headers: Record<string, string>;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly backoffBase: number;
  private readonly fetch: Fetch;
  private readonly sleep: (seconds: number) => Promise<void>;
  private loggedDrop = false;
  private readonly dryRun: boolean;

  constructor(opts: TransportOptions) {
    const base = opts.endpoint.replace(/\/+$/, "");
    this.url = `${base}/v1/workspaces/${opts.workspace}/systems/${opts.system}/monitoring/aggregates:ingest`;
    this.headers = {
      Authorization: `Bearer ${opts.apiKey}`,
      "User-Agent": opts.userAgent,
      "Content-Type": "application/json",
    };
    this.timeoutMs = opts.timeoutMs ?? 5000;
    this.maxAttempts = opts.maxAttempts ?? 3;
    this.backoffBase = opts.backoffBaseSeconds ?? 0.5;
    this.fetch = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.sleep = opts.sleep ?? ((s) => new Promise((resolve) => setTimeout(resolve, s * 1000).unref?.()));
    this.dryRun = opts.dryRun ?? false;
  }

  /** POST one payload, retrying transient failures with the *same* payload (and so the same batch_id). */
  async send(payload: Payload, maxAttempts?: number): Promise<SendResult> {
    if (this.dryRun || debugEnabled()) {
      // The payload holds only counts; the API key is in a header and never logged.
      logger.debug(
        `aikraft: ${this.dryRun ? "dry run, not sending" : "sending"} batch ${payload.batch_id} ` +
          `(${payload.windows.length} windows) to ${this.url}\n${pretty(payload)}`,
      );
    }
    if (this.dryRun) return SendResult.OK;
    const attempts = maxAttempts ?? this.maxAttempts;
    const body = JSON.stringify(payload);
    for (let attempt = 0; attempt < attempts; attempt++) {
      let delay = this.backoffBase * 2 ** attempt;
      let response: Response | undefined;
      try {
        response = await this.fetch(this.url, {
          method: "POST",
          headers: this.headers,
          body,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (err) {
        logger.debug(`aikraft: send failed (${String(err)}), attempt ${attempt + 1}/${attempts}`);
      }
      if (response !== undefined) {
        const code = response.status;
        const text = await response.text().catch(() => "");
        if (debugEnabled()) logger.debug(`aikraft: HTTP ${code} ${text.slice(0, 500)}`);
        if (code >= 200 && code < 300) return SendResult.OK;
        if (code === 401 || code === 403) {
          logger.warn(`aikraft: the API key was rejected (HTTP ${code}); monitoring data will not be sent.`);
          return SendResult.FATAL;
        }
        if (code === 429 || code >= 500) {
          delay = Math.max(delay, retryAfter(response) ?? 0);
        } else {
          if (!this.loggedDrop) {
            // A 4xx other than auth means the SDK sent something the server doesn't accept.
            logger.warn(`aikraft: payload rejected (HTTP ${code}): ${text.slice(0, 500)}`);
            this.loggedDrop = true;
          }
          return SendResult.DROP;
        }
      }
      if (attempt + 1 < attempts) await this.sleep(delay);
    }
    return SendResult.RETRY;
  }
}

/** Indented JSON with number arrays (histogram counts) kept on one line. */
function pretty(payload: Payload): string {
  return JSON.stringify(payload, null, 2).replace(
    /\[\s+([-\d.,\s]+?)\s+\]/g,
    (_m, inner: string) => `[${inner.split(/\s+/).join(" ")}]`,
  );
}

function retryAfter(response: Response): number | null {
  const raw = response.headers.get("Retry-After");
  if (raw === null || raw.trim() === "") return null;
  const seconds = Number(raw);
  return Number.isNaN(seconds) ? null : Math.min(seconds, MAX_RETRY_AFTER_SECONDS);
}
