/**
 * Mirror of the backend's validation for schema aikraft.llm.v1 (aikraft-backend llm_protocol.py).
 *
 * Every payload the SDK produces in tests goes through this, so a contract drift fails here first.
 */

import { expect } from "vitest";
import type { Payload } from "../src/aggregate.js";
import { EDGES, STATUSES, STOP_REASONS } from "../src/protocol.js";

const TOP_KEYS = ["batch_id", "schema", "sdk", "windows"];
const WINDOW_KEYS = new Set(["start", "end", "model", "tag", "calls", "histograms", "categories", "feedback"]);
const TAG = /^[A-Za-z0-9_.-]{1,64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ISO_WITH_TZ = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

export function assertValidPayload(payload: Payload): void {
  expect(Object.keys(payload).sort()).toEqual(TOP_KEYS);
  expect(payload.schema).toBe("aikraft.llm.v1");
  expect(payload.batch_id).toMatch(UUID);
  expect(Object.keys(payload.sdk).sort()).toEqual(["name", "version"]);
  expect(payload.sdk.name.length).toBeLessThanOrEqual(64);
  expect(payload.sdk.version.length).toBeLessThanOrEqual(32);
  expect(payload.windows.length).toBeGreaterThanOrEqual(1);
  expect(payload.windows.length).toBeLessThanOrEqual(50);
  for (const w of payload.windows) {
    for (const key of Object.keys(w)) expect(WINDOW_KEYS.has(key), `unexpected window key ${key}`).toBe(true);
    expect(w.start).toMatch(ISO_WITH_TZ);
    expect(w.end).toMatch(ISO_WITH_TZ);
    const start = Date.parse(w.start);
    const end = Date.parse(w.end);
    expect(start < end && end <= start + 3_600_000).toBe(true);
    expect(typeof w.model === "string" && w.model.length >= 1 && w.model.length <= 128).toBe(true);
    expect(w.tag === null || TAG.test(w.tag)).toBe(true);
    expect(Number.isInteger(w.calls) && w.calls >= 0).toBe(true);
    for (const [name, h] of Object.entries(w.histograms)) {
      expect(Object.keys(EDGES)).toContain(name);
      expect(Object.keys(h).sort()).toEqual(["counts", "sum"]);
      expect(h.counts.length).toBe(EDGES[name as keyof typeof EDGES].length + 1);
      expect(h.counts.every((c) => Number.isInteger(c) && c >= 0)).toBe(true);
      expect(h.counts.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(w.calls);
      expect(h.sum).toBeGreaterThanOrEqual(0);
    }
    for (const [name, counts] of Object.entries(w.categories)) {
      const vocab = { stop_reason: STOP_REASONS, status: STATUSES }[name];
      expect(vocab, `unknown category ${name}`).toBeDefined();
      for (const value of Object.keys(counts)) expect(vocab?.has(value), `${name} value ${value}`).toBe(true);
      expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(w.calls);
    }
    if (w.feedback !== undefined) {
      expect(Object.keys(w.feedback).sort()).toEqual(["count", "sum"]);
      expect(w.feedback.count).toBeGreaterThanOrEqual(0);
    }
  }
}
