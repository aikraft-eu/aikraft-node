/** wrap() against the real @anthropic-ai/sdk and openai clients, with their HTTP layer mocked. */

import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { describe, expect, it } from "vitest";
import type { WireWindow } from "../src/aggregate.js";
import * as aikraft from "../src/index.js";
import { type Sink, useSink } from "./helpers.js";

// ---------------------------------------------------------------------------
// Mock model APIs
// ---------------------------------------------------------------------------

function sse(events: [string | null, unknown][]): string {
  const out: string[] = [];
  for (const [name, data] of events) {
    if (name) out.push(`event: ${name}`);
    out.push(`data: ${typeof data === "string" ? data : JSON.stringify(data)}`, "");
  }
  return `${out.join("\n")}\n`;
}

type Fetch = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;

function responder(opts: { json?: unknown; stream?: string; status?: number }): Fetch & { bodies: string[] } {
  const bodies: string[] = [];
  const fetch = async (_url: string | URL | Request, init?: RequestInit) => {
    bodies.push(String(init?.body ?? ""));
    if (opts.status !== undefined) {
      return Response.json({ error: { type: "rate_limit_error", message: "slow down" } }, { status: opts.status });
    }
    if (opts.stream !== undefined) {
      return new Response(opts.stream, { headers: { "content-type": "text/event-stream" } });
    }
    return Response.json(opts.json);
  };
  return Object.assign(fetch, { bodies });
}

const anthropic = (fetch: Fetch) => new Anthropic({ apiKey: "x", maxRetries: 0, fetch });
const openai = (fetch: Fetch) => new OpenAI({ apiKey: "x", maxRetries: 0, fetch });

const ANTHROPIC_MESSAGE = {
  id: "msg_1",
  type: "message",
  role: "assistant",
  model: "claude-sonnet-5-5",
  content: [
    { type: "text", text: "Hello there" },
    { type: "tool_use", id: "t", name: "f", input: {} },
  ],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 12, output_tokens: 5, cache_read_input_tokens: 100 },
};

const ANTHROPIC_STREAM = sse([
  [
    "message_start",
    {
      type: "message_start",
      message: { ...ANTHROPIC_MESSAGE, content: [], stop_reason: null, usage: { input_tokens: 12, output_tokens: 1 } },
    },
  ],
  ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
  ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } }],
  ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: " there" } }],
  ["content_block_stop", { type: "content_block_stop", index: 0 }],
  [
    "message_delta",
    { type: "message_delta", delta: { stop_reason: "max_tokens", stop_sequence: null }, usage: { output_tokens: 7 } },
  ],
  ["message_stop", { type: "message_stop" }],
]);

const CHAT_COMPLETION = {
  id: "c1",
  object: "chat.completion",
  created: 1,
  model: "gpt-5",
  choices: [{ index: 0, message: { role: "assistant", content: "Hi!" }, finish_reason: "length" }],
  usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
};

const chunk = (fields: Record<string, unknown>) => ({
  id: "c1",
  object: "chat.completion.chunk",
  created: 1,
  model: "gpt-5",
  ...fields,
});

const CHAT_STREAM = sse([
  [null, chunk({ choices: [{ index: 0, delta: { role: "assistant", content: "Hi" }, finish_reason: null }] })],
  [null, chunk({ choices: [{ index: 0, delta: { content: " you" }, finish_reason: null }] })],
  [null, chunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })],
  [null, chunk({ choices: [], usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 } })],
  [null, "[DONE]"],
]);

const RESPONSE = {
  id: "r1",
  object: "response",
  created_at: 1,
  model: "gpt-5",
  status: "completed",
  output: [
    {
      type: "message",
      id: "m1",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "Hello world", annotations: [] }],
    },
  ],
  usage: {
    input_tokens: 9,
    output_tokens: 4,
    total_tokens: 13,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens_details: { reasoning_tokens: 0 },
  },
  parallel_tool_calls: true,
  tool_choice: "auto",
  tools: [],
};

const RESPONSE_STREAM = sse([
  [
    "response.output_text.delta",
    {
      type: "response.output_text.delta",
      delta: "Hello world",
      item_id: "m1",
      output_index: 0,
      content_index: 0,
      sequence_number: 1,
    },
  ],
  ["response.completed", { type: "response.completed", response: RESPONSE, sequence_number: 2 }],
]);

async function onlyWindow(sink: Sink): Promise<WireWindow> {
  const windows = await sink.windows();
  expect(windows).toHaveLength(1);
  return windows[0] as WireWindow;
}

function histTotal(w: WireWindow, metric: string): [number, number] {
  const h = w.histograms[metric];
  return h ? [h.counts.reduce((a, b) => a + b, 0), h.sum] : [0, 0];
}

const MESSAGE_PARAMS = { model: "claude-sonnet-5-5", max_tokens: 10, messages: [] };
const CHAT_PARAMS = { model: "gpt-5", messages: [] };

// ---------------------------------------------------------------------------
// Anthropic
// ---------------------------------------------------------------------------

describe("Anthropic", () => {
  const sink = useSink();

  it("records messages.create()", async () => {
    const client = aikraft.wrap(anthropic(responder({ json: ANTHROPIC_MESSAGE })));
    const msg = await aikraft.tag("support", () => client.messages.create(MESSAGE_PARAMS));
    expect(msg.content[0]).toEqual({ type: "text", text: "Hello there" }); // the caller gets the real response
    const w = await onlyWindow(sink.current);
    expect([w.model, w.tag, w.calls]).toEqual(["claude-sonnet-5-5", "support", 1]);
    expect(histTotal(w, "input_tokens")).toEqual([1, 112]); // includes cached tokens
    expect(histTotal(w, "output_tokens")).toEqual([1, 5]);
    expect(histTotal(w, "output_chars")).toEqual([1, 11]); // text blocks only
    expect(w.categories).toEqual({ stop_reason: { end_turn: 1 }, status: { ok: 1 } });
  });

  it("records a create() stream", async () => {
    const client = aikraft.wrap(anthropic(responder({ stream: ANTHROPIC_STREAM })));
    const types: string[] = [];
    for await (const event of await client.messages.create({ ...MESSAGE_PARAMS, stream: true })) types.push(event.type);
    expect(types).toHaveLength(7);
    const w = await onlyWindow(sink.current);
    expect(histTotal(w, "input_tokens")).toEqual([1, 12]);
    expect(histTotal(w, "output_tokens")).toEqual([1, 7]);
    expect(histTotal(w, "output_chars")).toEqual([1, 11]);
    expect(w.categories.stop_reason).toEqual({ max_tokens: 1 });
  });

  it("records the messages.stream() helper once", async () => {
    const client = aikraft.wrap(anthropic(responder({ stream: ANTHROPIC_STREAM })));
    let text = "";
    const stream = client.messages.stream(MESSAGE_PARAMS).on("text", (t) => {
      text += t;
    });
    const final = await stream.finalMessage();
    expect(text).toBe("Hello there");
    expect(final.usage.output_tokens).toBe(7);
    const w = await onlyWindow(sink.current);
    expect(w.calls).toBe(1);
    expect(histTotal(w, "output_tokens")).toEqual([1, 7]);
    expect(histTotal(w, "output_chars")).toEqual([1, 11]);
    expect(w.categories.stop_reason).toEqual({ max_tokens: 1 });
  });

  it("records errors and passes them through", async () => {
    const client = aikraft.wrap(anthropic(responder({ status: 429 })));
    await expect(client.messages.create(MESSAGE_PARAMS)).rejects.toBeInstanceOf(Anthropic.RateLimitError);
    const w = await onlyWindow(sink.current);
    expect(w.categories).toEqual({ status: { rate_limited: 1 } });
    expect(histTotal(w, "latency_ms")[0]).toBe(1);
    expect(w.histograms.output_tokens).toBeUndefined();
  });

  it("records a stream the caller stops reading early", async () => {
    const client = aikraft.wrap(anthropic(responder({ stream: ANTHROPIC_STREAM })));
    for await (const event of await client.messages.create({ ...MESSAGE_PARAMS, stream: true })) {
      if (event.type === "content_block_delta") break;
    }
    const w = await onlyWindow(sink.current);
    expect(w.calls).toBe(1);
    expect(w.categories).toEqual({ stop_reason: { other: 1 }, status: { ok: 1 } });
    expect(histTotal(w, "output_chars")).toEqual([1, 5]);
  });

  it("keeps the APIPromise helpers working", async () => {
    const client = aikraft.wrap(anthropic(responder({ json: ANTHROPIC_MESSAGE })));
    const { data, response } = await client.messages.create(MESSAGE_PARAMS).withResponse();
    expect(data.id).toBe("msg_1");
    expect(response.status).toBe(200);
    const raw = await client.messages.create(MESSAGE_PARAMS).asResponse(); // body not parsed: nothing recorded
    expect(((await raw.json()) as { id: string }).id).toBe("msg_1");
    expect((await onlyWindow(sink.current)).calls).toBe(1);
  });

  it("keeps tee() working on streams", async () => {
    const client = aikraft.wrap(anthropic(responder({ stream: ANTHROPIC_STREAM })));
    const [left, right] = (await client.messages.create({ ...MESSAGE_PARAMS, stream: true })).tee();
    let n = 0;
    for await (const _ of left) n++;
    for await (const _ of right) n++;
    expect(n).toBe(14);
    expect((await onlyWindow(sink.current)).calls).toBe(1);
  });

  it("is idempotent and per instance", async () => {
    const wrapped = anthropic(responder({ json: ANTHROPIC_MESSAGE }));
    aikraft.wrap(aikraft.wrap(wrapped));
    const plain = anthropic(responder({ json: ANTHROPIC_MESSAGE }));
    await wrapped.messages.create(MESSAGE_PARAMS);
    await plain.messages.create(MESSAGE_PARAMS);
    expect((await onlyWindow(sink.current)).calls).toBe(1);
  });

  it("uses the tag in effect when the call was made", async () => {
    const client = aikraft.wrap(anthropic(responder({ stream: ANTHROPIC_STREAM })));
    const stream = await aikraft.tag("early", () => client.messages.create({ ...MESSAGE_PARAMS, stream: true }));
    await aikraft.tag("late", async () => {
      for await (const _ of stream);
    });
    expect((await onlyWindow(sink.current)).tag).toBe("early");
  });

  it("keeps concurrent tags apart", async () => {
    const client = aikraft.wrap(anthropic(responder({ json: ANTHROPIC_MESSAGE })));
    await Promise.all(["a", "b", "a"].map((t) => aikraft.tag(t, () => client.messages.create(MESSAGE_PARAMS))));
    const windows = await sink.current.windows();
    expect(Object.fromEntries(windows.map((w) => [w.tag, w.calls]))).toEqual({ a: 2, b: 1 });
  });

  it("sends nothing from the conversation", async () => {
    const client = aikraft.wrap(anthropic(responder({ json: ANTHROPIC_MESSAGE })));
    await client.messages.create({ ...MESSAGE_PARAMS, messages: [{ role: "user", content: "SECRET-PROMPT" }] });
    await aikraft.flush();
    const raw = sink.current.requests.map((r) => r.body).join("");
    expect(raw).not.toContain("SECRET-PROMPT");
    expect(raw).not.toContain("Hello there");
    expect(raw).not.toContain("msg_1");
  });
});

// ---------------------------------------------------------------------------
// OpenAI
// ---------------------------------------------------------------------------

describe("OpenAI", () => {
  const sink = useSink();

  it("records chat.completions.create()", async () => {
    const client = aikraft.wrap(openai(responder({ json: CHAT_COMPLETION })));
    const out = await client.chat.completions.create(CHAT_PARAMS);
    expect(out.choices[0]?.message.content).toBe("Hi!");
    const w = await onlyWindow(sink.current);
    expect(w.model).toBe("gpt-5");
    expect(histTotal(w, "input_tokens")).toEqual([1, 7]);
    expect(histTotal(w, "output_chars")).toEqual([1, 3]);
    expect(w.categories.stop_reason).toEqual({ max_tokens: 1 });
  });

  it("records chat streams and the stream() helper", async () => {
    const client = aikraft.wrap(openai(responder({ stream: CHAT_STREAM })));
    const chunks = [];
    const stream = await client.chat.completions.create({
      ...CHAT_PARAMS,
      stream: true,
      stream_options: { include_usage: true },
    });
    for await (const c of stream) chunks.push(c);
    expect(chunks).toHaveLength(4);
    const final = await client.chat.completions.stream(CHAT_PARAMS).finalChatCompletion(); // goes through create()
    expect(final.choices[0]?.message.content).toBe("Hi you");
    const w = await onlyWindow(sink.current);
    expect(w.calls).toBe(2);
    expect(histTotal(w, "output_chars")).toEqual([2, 12]);
    expect(histTotal(w, "output_tokens")).toEqual([2, 4]);
    expect(w.categories.stop_reason).toEqual({ end_turn: 2 });
  });

  it("records chat.completions.parse()", async () => {
    const stopped = { ...CHAT_COMPLETION, choices: [{ ...CHAT_COMPLETION.choices[0], finish_reason: "stop" }] };
    const client = aikraft.wrap(openai(responder({ json: stopped })));
    const parsed = await client.chat.completions.parse(CHAT_PARAMS);
    expect(parsed.choices[0]?.message.content).toBe("Hi!");
    expect((await onlyWindow(sink.current)).calls).toBe(1);
  });

  it("records responses.create(), streamed and not", async () => {
    const client = aikraft.wrap(openai(responder({ json: RESPONSE })));
    expect((await client.responses.create({ model: "gpt-5", input: "hi" })).output_text).toBe("Hello world");
    const sclient = aikraft.wrap(openai(responder({ stream: RESPONSE_STREAM })));
    for await (const _ of await sclient.responses.create({ model: "gpt-5", input: "hi", stream: true }));
    const w = await onlyWindow(sink.current);
    expect(w.calls).toBe(2);
    expect(histTotal(w, "input_tokens")).toEqual([2, 18]);
    expect(histTotal(w, "output_chars")).toEqual([2, 22]);
    expect(w.categories.stop_reason).toEqual({ end_turn: 2 });
  });

  it("records the responses.stream() helper", async () => {
    const created = sse([
      [
        "response.created",
        {
          type: "response.created",
          response: { ...RESPONSE, status: "in_progress", output: [], usage: null },
          sequence_number: 0,
        },
      ],
      [
        "response.output_item.added",
        {
          type: "response.output_item.added",
          output_index: 0,
          item: { type: "message", id: "m1", role: "assistant", status: "in_progress", content: [] },
          sequence_number: 1,
        },
      ],
      [
        "response.content_part.added",
        {
          type: "response.content_part.added",
          item_id: "m1",
          output_index: 0,
          content_index: 0,
          part: { type: "output_text", text: "", annotations: [] },
          sequence_number: 2,
        },
      ],
    ]);
    const client = aikraft.wrap(openai(responder({ stream: created + RESPONSE_STREAM })));
    const final = await client.responses.stream({ model: "gpt-5", input: "hi" }).finalResponse();
    expect(final.output_text).toBe("Hello world");
    const w = await onlyWindow(sink.current);
    expect(w.calls).toBe(1);
    expect(histTotal(w, "output_chars")).toEqual([1, 11]);
  });

  it("maps incomplete responses and tool calls", async () => {
    const incomplete = { ...RESPONSE, status: "incomplete", incomplete_details: { reason: "max_output_tokens" } };
    const tool = {
      ...RESPONSE,
      output: [{ type: "function_call", id: "f", call_id: "c", name: "n", arguments: "{}" }],
    };
    for (const body of [incomplete, tool]) {
      await aikraft.wrap(openai(responder({ json: body }))).responses.create({ model: "gpt-5", input: "hi" });
    }
    expect((await onlyWindow(sink.current)).categories.stop_reason).toEqual({ max_tokens: 1, tool_use: 1 });
  });
});

describe("wrap", () => {
  it("rejects other objects", () => {
    expect(() => aikraft.wrap({})).toThrow(TypeError);
  });

  it("leaves the client working without init()", async () => {
    await aikraft.shutdown();
    const client = aikraft.wrap(anthropic(responder({ json: ANTHROPIC_MESSAGE })));
    expect((await client.messages.create(MESSAGE_PARAMS)).id).toBe("msg_1");
  });
});
