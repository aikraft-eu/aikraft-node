/**
 * Instrumentation for Anthropic and OpenAI clients.
 *
 * `wrap()` patches methods on the given client *instance* only (other clients are untouched). Each call is
 * timed and reduced to numbers: token counts, output length, stop reason and status. Response text is
 * measured and then discarded; nothing about the request itself is kept or sent. Instrumentation errors are
 * swallowed; errors from the model call itself are passed through unchanged.
 *
 * The SDKs' stream helpers (`messages.stream()`, `chat.completions.stream()`, `responses.stream()`) and
 * `parse()` helpers all call the instance's `create()`, so patching `create()` covers them too.
 */

import * as core from "./core.js";
import { logger } from "./log.js";
import { charCount, cleanModel, normalizeStopReason, statusFromError } from "./protocol.js";

const MARK = Symbol.for("aikraft.wrapped");

/** Instrument an `@anthropic-ai/sdk` or `openai` client and return it. */
export function wrap<T>(client: T): T {
  const c = client as any;
  if (isFunction(c?.messages?.create)) {
    patch(c.messages, "create", AnthropicObserver);
  } else if (isFunction(c?.chat?.completions?.create)) {
    patch(c.chat.completions, "create", OpenAIChatObserver);
    patch(c.responses, "create", OpenAIResponsesObserver);
  } else {
    const name = c?.constructor?.name ?? typeof client;
    throw new TypeError(`aikraft.wrap() supports @anthropic-ai/sdk and openai clients, got ${name}`);
  }
  return client;
}

// ---------------------------------------------------------------------------
// Measurement: one Observer per call, fed either a final response or stream events
// ---------------------------------------------------------------------------

abstract class Observer {
  private readonly started = performance.now();
  private readonly tag = core.currentTag(); // the tag in effect when the call was made
  private done = false;
  model: unknown;
  inputTokens: number | null = null;
  outputTokens: number | null = null;
  outputChars: number | null = null;
  stopReason: string | null = null;

  constructor(params: any) {
    this.model = params?.model;
  }

  abstract response(obj: any): void;
  abstract event(obj: any): void;

  addChars(text: unknown): void {
    if (typeof text === "string") this.outputChars = (this.outputChars ?? 0) + charCount(text);
  }

  finish(err?: unknown, failed = err !== undefined): void {
    if (this.done) return;
    this.done = true;
    core.record({
      ts: Date.now() / 1000,
      model: cleanModel(this.model),
      tag: this.tag,
      latency_ms: performance.now() - this.started,
      input_tokens: this.inputTokens,
      output_tokens: this.outputTokens,
      output_chars: this.outputChars,
      stop_reason: failed ? null : (this.stopReason ?? "other"),
      status: failed ? statusFromError(err) : "ok",
    });
  }

  safely(fn: (obj: any) => void, obj: unknown): void {
    try {
      fn.call(this, obj);
    } catch (err) {
      logger.debug("aikraft: could not read a response field", err);
    }
  }
}

type ObserverClass = new (params: any) => Observer;

function int(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function sumInts(...values: unknown[]): number | null {
  const ints = values.map(int).filter((v): v is number => v !== null);
  return ints.length ? ints.reduce((a, b) => a + b, 0) : null;
}

class AnthropicObserver extends Observer {
  private usage(usage: any): void {
    if (usage == null) return;
    // Prompt size includes cached tokens.
    const tokens = sumInts(usage.input_tokens, usage.cache_creation_input_tokens, usage.cache_read_input_tokens);
    if (tokens) this.inputTokens = tokens;
    const out = int(usage.output_tokens);
    if (out !== null) this.outputTokens = out;
  }

  response(msg: any): void {
    this.model = msg?.model || this.model;
    this.usage(msg?.usage);
    this.stopReason = normalizeStopReason(msg?.stop_reason);
    for (const block of msg?.content ?? []) {
      if (block?.type === "text") this.addChars(block.text);
    }
    this.outputChars ??= 0;
  }

  event(ev: any): void {
    switch (ev?.type) {
      case "message_start":
        this.model = ev.message?.model || this.model;
        this.usage(ev.message?.usage);
        break;
      case "content_block_start":
        // A fallback block names the model that produces the rest of the message.
        if (ev.content_block?.type === "fallback") this.model = ev.content_block.to?.model || this.model;
        break;
      case "content_block_delta":
        if (ev.delta?.type === "text_delta") this.addChars(ev.delta.text);
        break;
      case "message_delta":
        this.stopReason = normalizeStopReason(ev.delta?.stop_reason);
        this.usage(ev.usage);
        break;
    }
  }
}

class OpenAIChatObserver extends Observer {
  private usage(usage: any): void {
    if (usage == null) return;
    this.inputTokens = int(usage.prompt_tokens);
    this.outputTokens = int(usage.completion_tokens);
  }

  response(completion: any): void {
    this.model = completion?.model || this.model;
    this.usage(completion?.usage);
    const choices: any[] = completion?.choices ?? [];
    if (choices.length) this.stopReason = normalizeStopReason(choices[0]?.finish_reason);
    for (const choice of choices) this.addChars(choice?.message?.content);
    this.outputChars ??= 0;
  }

  event(chunk: any): void {
    this.model = chunk?.model || this.model;
    this.usage(chunk?.usage); // only on the last chunk, with stream_options: { include_usage: true }
    for (const choice of chunk?.choices ?? []) {
      this.addChars(choice?.delta?.content);
      if (choice?.finish_reason) this.stopReason = normalizeStopReason(choice.finish_reason);
    }
  }
}

class OpenAIResponsesObserver extends Observer {
  response(resp: any): void {
    this.model = resp?.model || this.model;
    if (resp?.usage != null) {
      this.inputTokens = int(resp.usage.input_tokens);
      this.outputTokens = int(resp.usage.output_tokens);
    }
    const output: any[] = resp?.output ?? [];
    if (resp?.status === "incomplete") this.stopReason = normalizeStopReason(resp.incomplete_details?.reason);
    else if (output.some((item) => item?.type === "function_call")) this.stopReason = "tool_use";
    else if (resp?.status === "completed") this.stopReason = "end_turn";
    else this.stopReason = "other";
    // `output_text` is added by the SDK to non-streamed responses only; the final stream event has just `output`.
    this.outputChars = null;
    if (typeof resp?.output_text === "string") {
      this.addChars(resp.output_text);
    } else {
      for (const item of output) {
        if (item?.type !== "message") continue;
        for (const part of item.content ?? []) if (part?.type === "output_text") this.addChars(part.text);
      }
    }
    this.outputChars ??= 0;
  }

  event(ev: any): void {
    switch (ev?.type) {
      case "response.completed":
      case "response.incomplete":
      case "response.failed":
        this.response(ev.response);
        break;
      case "response.output_text.delta":
        this.addChars(ev.delta);
        break;
    }
  }
}

// ---------------------------------------------------------------------------
// Patching
// ---------------------------------------------------------------------------

function isFunction(value: unknown): value is (...args: any[]) => any {
  return typeof value === "function";
}

function patch(resource: any, method: string, Obs: ObserverClass): void {
  const original = resource?.[method];
  if (!isFunction(original) || (original as any)[MARK]) return;

  const wrapper = function (this: unknown, ...args: any[]): unknown {
    const params = args[0];
    const observer = new Obs(params);
    let result: unknown;
    try {
      result = original.apply(this, args);
    } catch (err) {
      observer.finish(err);
      throw err;
    }
    return observeResult(result, observer, params?.stream === true);
  };
  Object.defineProperty(wrapper, MARK, { value: true });
  Object.defineProperty(wrapper, "name", { value: original.name });
  resource[method] = wrapper;
}

/**
 * The SDKs return an `APIPromise`: a Promise subclass whose body is only parsed once someone awaits it, with
 * extra methods (`withResponse()`, `asResponse()`). It's observed through `_thenUnwrap(transform)`, the hook
 * the SDKs' own resources use to post-process responses, which returns an equivalent `APIPromise`. API errors
 * reject `responsePromise` before any parsing, so they're observed on a side branch of it.
 */
function observeResult(result: unknown, observer: Observer, isStream: boolean): unknown {
  if (isAPIPromise(result)) {
    // The caller still gets the rejection, from the promise returned below.
    result.responsePromise?.then(undefined, (err: unknown) => observer.finish(err));
    return result._thenUnwrap((data) => observeData(data, observer, isStream));
  }
  if (isFunction((result as any)?.then)) {
    // Not an APIPromise (an older or future SDK): fall back to a plain promise.
    return Promise.resolve(result).then(
      (data) => observeData(data, observer, isStream),
      (err) => {
        observer.finish(err);
        throw err;
      },
    );
  }
  return observeData(result, observer, isStream);
}

interface APIPromiseLike {
  responsePromise?: Promise<unknown>;
  _thenUnwrap(transform: (data: unknown) => unknown): unknown;
}

function isAPIPromise(value: unknown): value is APIPromiseLike {
  const v = value as any;
  return (
    value instanceof Promise && isFunction(v._thenUnwrap) && (v.responsePromise ?? Promise.resolve()) instanceof Promise
  );
}

function observeData(data: unknown, observer: Observer, isStream: boolean): unknown {
  if (isStream && isAsyncIterable(data)) {
    observeStream(data, observer);
  } else {
    if (!isStream) observer.safely(observer.response, data);
    observer.finish();
  }
  return data;
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return value != null && isFunction((value as any)[Symbol.asyncIterator]);
}

/**
 * Observes the events of the SDK's `Stream` object in place (so `tee()`, `controller` and `toReadableStream()`
 * keep working) and records once the read ends: fully read, broken out of, or failed.
 */
function observeStream(stream: AsyncIterable<unknown>, observer: Observer): void {
  const iterate = stream[Symbol.asyncIterator];
  let observed = false;
  (stream as any)[Symbol.asyncIterator] = function (this: unknown): AsyncIterator<unknown> {
    const source = iterate.call(this);
    if (observed) return source; // the SDK throws "Cannot iterate over a consumed stream" here
    observed = true;
    const iterator: AsyncIterableIterator<unknown> = {
      async next() {
        let result: IteratorResult<unknown>;
        try {
          result = await source.next();
        } catch (err) {
          observer.finish(err);
          throw err;
        }
        if (result.done) observer.finish();
        else observer.safely(observer.event, result.value);
        return result;
      },
      async return(value?: unknown) {
        observer.finish(); // the application stopped reading: counted with what it read so far
        return (await source.return?.(value)) ?? { done: true, value };
      },
      async throw(err?: unknown) {
        observer.finish(err);
        if (source.throw) return source.throw(err);
        throw err;
      },
      [Symbol.asyncIterator]: () => iterator,
    };
    return iterator;
  };
}
