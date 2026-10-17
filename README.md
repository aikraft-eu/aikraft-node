# aikraft

Privacy-first monitoring for LLM applications. Wrap your Anthropic or OpenAI client and Aikraft tracks
latency, token usage, refusals, truncations and errors over time, alerts you when they drift, and
keeps your EU AI Act post-market monitoring record up to date.

**No prompts, responses or personal data ever leave your infrastructure.** Only per-minute aggregates do.

```bash
npm install aikraft
```

```ts
import * as aikraft from "aikraft";
import Anthropic from "@anthropic-ai/sdk"; // or: import OpenAI from "openai";

aikraft.init({ workspace: "<workspace-id>", system: "<system-id>" }); // API key from AIKRAFT_API_KEY
const client = aikraft.wrap(new Anthropic());

await client.messages.create({ model: "claude-sonnet-5-5", max_tokens: 1024, messages: [...] }); // unchanged
```

Your workspace and system IDs, and a ready-to-paste snippet, are in Aikraft under
**Monitoring → Set up telemetry**. Create an API key with read/write scope in **Settings → API keys**.

## What leaves your infrastructure

For each minute, per model and optional tag, the SDK sends **counts only**:

| Sent | Example |
|---|---|
| Number of calls | `128` |
| Latency, input tokens, output tokens, output length: counts per fixed bucket, plus a sum | `"latency_ms": {"counts": [0, …, 120, 8, 0], "sum": 91234.5}` |
| Stop reasons (fixed vocabulary) | `{"end_turn": 120, "max_tokens": 5, "refusal": 3}` |
| Call status (fixed vocabulary: `ok`, `rate_limited`, `timeout`, `connection_error`, `auth_error`, `bad_request`, `server_error`, `error`) | `{"ok": 126, "rate_limited": 1, "connection_error": 1}` |
| Optional feedback scores: count and sum | `{"count": 4, "sum": 3.0}` |

**Never sent:** prompts, system prompts, responses, tool inputs or outputs, user or request IDs, or
anything else from a single request. Response text is only measured (its length) and immediately
discarded. Unknown stop reasons are reported as `other`, never as raw strings.

A full payload looks like this:

```json
{
  "schema": "aikraft.llm.v1",
  "batch_id": "3f0c…",
  "sdk": {"name": "aikraft-node", "version": "0.1.1"},
  "windows": [{
    "start": "2026-10-08T14:00:00+00:00", "end": "2026-10-08T14:01:00+00:00",
    "model": "claude-sonnet-5-5", "tag": "support-bot", "calls": 128,
    "histograms": {"latency_ms": {"counts": [...], "sum": 91234.5}, "output_tokens": {"counts": [...], "sum": 18003}},
    "categories": {"stop_reason": {"end_turn": 120, "max_tokens": 5, "refusal": 3}, "status": {"ok": 126, "rate_limited": 2}}
  }]
}
```

## Supported clients

`aikraft.wrap()` works with clients from:

- **`@anthropic-ai/sdk`**: `messages.create()` (including `stream: true`) and the `messages.stream()` helper
- **`openai`**: `chat.completions.create()`, `responses.create()` (including `stream: true`) and their
  `.stream()` and `.parse()` helpers

It patches the client **instance** you pass, so other clients are untouched, and returns the same client
with its types unchanged. Return values and errors are exactly what the underlying SDK gives you, including
`.withResponse()` and `.asResponse()`. Failed calls are counted by status and the original error is
passed through.

A stream is recorded when you finish reading it, stop reading it (`break`), or it fails. For OpenAI chat
streaming, token counts are only available if you request them with
`stream_options: { include_usage: true }`. Without it, latency, length and stop reasons are still tracked.

## Tags

Group calls by feature or endpoint:

```ts
const reply = await aikraft.tag("support-bot", () => client.messages.create({ ... }));
```

`tag()` returns whatever the function returns. Tags follow the async context (`AsyncLocalStorage`), so
concurrent requests never see each other's tags, and a call keeps the tag it was made under even if you
read its stream later. Tags must match `[A-Za-z0-9_.-]{1,64}`.

## Feedback

```ts
aikraft.feedback(1, { model: "claude-sonnet-5-5", tag: "support-bot" }); // e.g. 1 thumbs up, 0 down
```

Only the count and sum per minute are sent, never which response they belong to.

## Configuration

| Option | Environment variable | Default |
|---|---|---|
| `apiKey` | `AIKRAFT_API_KEY` | (required) |
| `endpoint` | `AIKRAFT_ENDPOINT` | `https://api.aikraft.eu` |
| `enabled: false` | `AIKRAFT_DISABLED=1` | enabled |
| `flushIntervalMs` | | `60000` |
| `fetch` | | global `fetch` |
| `logger` | | `console` |
| `debug: true` | `AIKRAFT_DEBUG=1` | off |
| `dryRun: true` | `AIKRAFT_DRY_RUN=1` | off |

Without an API key, or when disabled, `init()` returns `false`, logs a warning and everything becomes a
no-op. Your app keeps working.

### Seeing exactly what is sent

`debug` logs every payload before it is sent, and the server's reply, through `logger.debug` (the console
by default). `dryRun` does the same without sending anything and without needing an API key, which is
handy to check the data locally before connecting:

```console
$ AIKRAFT_DRY_RUN=1 node app.js
aikraft: dry run, not sending batch 1713… (1 windows) to https://api.aikraft.eu/…
{
  "schema": "aikraft.llm.v1",
  …
        "status": {"connection_error": 1}
}
```

The API key is never logged. In the Aikraft app, the Telemetry tab also lists what was received.

## Behaviour you can rely on

- **Never breaks your app.** Monitoring errors are logged, not thrown. If Aikraft is unreachable, data is
  retried and, if it can't be delivered, dropped.
- **No double counting.** Every payload carries a `batch_id`; retries reuse it and the server
  ignores repeats.
- **Bounded memory.** At most 1000 open windows; beyond that, calls are counted as dropped and logged.
- **Doesn't keep your process alive.** The flush timer is unref'd, and buffered data is flushed when the
  event loop empties.
- **Shutdown.** `process.exit()` and signals skip that final flush, so in your own `SIGTERM` handler call
  `await aikraft.shutdown()` first.
- **Serverless.** Timers freeze between invocations, so `await aikraft.flush()` at the end of each handler
  (AWS Lambda, Vercel functions, Cloud Functions…).

## Requirements

Node.js 22+. No dependencies. `@anthropic-ai/sdk` and `openai` aren't dependencies; the SDK works with
whichever version you have installed. Ships ESM and CommonJS builds with TypeScript types.

## License

Apache-2.0
