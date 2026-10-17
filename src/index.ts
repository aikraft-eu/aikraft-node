/**
 * Aikraft: privacy-first monitoring for LLM apps.
 *
 * ```ts
 * import * as aikraft from "aikraft";
 * import Anthropic from "@anthropic-ai/sdk";
 *
 * aikraft.init({ workspace: "<workspace-id>", system: "<system-id>" }); // reads AIKRAFT_API_KEY
 * const client = aikraft.wrap(new Anthropic());
 * ```
 *
 * Only aggregates leave your infrastructure: per-minute counts of latency, token and output-length buckets
 * and of stop reasons and call statuses, per model and optional tag. Prompts, responses and any per-request
 * data are never sent.
 */

export { feedback, flush, type InitOptions, init, shutdown, tag } from "./core.js";
export type { Logger } from "./log.js";
export { VERSION } from "./version.js";
export { wrap } from "./wrap.js";
