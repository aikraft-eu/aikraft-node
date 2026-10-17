/** Background flushing of aggregates. Never throws into the host application. */

import type { Aggregator, Payload } from "./aggregate.js";
import { logger } from "./log.js";
import { SendResult, type Transport } from "./transport.js";

export const MAX_PENDING_PAYLOADS = 20;

/**
 * Flushes the aggregator every `intervalMs` from an unref'd timer, so it never keeps the process alive.
 *
 * The timer starts lazily on first use. Flushes run one at a time. Payloads that fail transiently are kept,
 * bounded, and retried with the same `batch_id` on the next flush.
 */
export class Worker {
  private pending: Payload[] = [];
  private timer: ReturnType<typeof setInterval> | undefined;
  private stopped = false;
  private queue: Promise<void> = Promise.resolve();
  private _disabled = false;

  constructor(
    private readonly aggregator: Aggregator,
    private readonly transport: Transport,
    private readonly intervalMs: number,
    private readonly sdkVersion: string,
  ) {}

  get disabled(): boolean {
    return this._disabled;
  }

  ensureStarted(): void {
    if (this.timer !== undefined || this.stopped || this._disabled) return;
    this.timer = setInterval(() => void this.flush(), this.intervalMs);
    this.timer.unref?.();
  }

  /** Send everything buffered now. Waits for a flush already in progress first. */
  flush(maxAttempts?: number): Promise<void> {
    const run = this.queue.then(() => this.flushNow(maxAttempts));
    this.queue = run.catch((err) => logger.error("aikraft: flush failed", err)); // never reject into the host app
    return this.queue;
  }

  private async flushNow(maxAttempts: number | undefined): Promise<void> {
    this.pending.push(...this.aggregator.drainBatches(this.sdkVersion));
    if (this.pending.length > MAX_PENDING_PAYLOADS) this.pending.splice(0, this.pending.length - MAX_PENDING_PAYLOADS);
    if (this.aggregator.dropped) {
      logger.warn(`aikraft: dropped ${this.aggregator.dropped} calls (too many distinct model/tag windows)`);
      this.aggregator.dropped = 0;
    }
    if (this._disabled) {
      this.pending = [];
      return;
    }
    while (this.pending.length) {
      const result = await this.transport.send(this.pending[0] as Payload, maxAttempts);
      if (result === SendResult.RETRY) return; // keep it (and everything after it) for the next flush
      this.pending.shift();
      if (result === SendResult.FATAL) {
        this._disabled = true;
        this.pending = [];
        return;
      }
    }
  }

  async shutdown(): Promise<void> {
    this.stopped = true;
    clearInterval(this.timer);
    this.timer = undefined;
    // One quick final attempt: don't hold up process exit retrying.
    await this.flush(1);
  }
}
