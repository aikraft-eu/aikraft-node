/**
 * Wire contract shared with the Aikraft backend (schema `aikraft.llm.v1`).
 *
 * Only aggregates are ever sent: counts of values falling into the fixed buckets below, and counts over
 * fixed vocabularies. Changing any constant here changes the protocol; bump the schema version instead.
 *
 * Bucketing rule: `index = bisect_right(edges, value)`, so `counts[0]` holds values below the first edge
 * and `counts[counts.length - 1]` values at or above the last edge; `counts.length === edges.length + 1`.
 */

export const SCHEMA = "aikraft.llm.v1";

const pow2 = (n: number): readonly number[] => Array.from({ length: n }, (_, i) => 2 ** i);

export const EDGES = {
  latency_ms: [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 60000],
  input_tokens: pow2(19), // 1 … 262144
  output_tokens: pow2(19),
  output_chars: pow2(21), // 1 … 1048576
} as const satisfies Record<string, readonly number[]>;

export type Metric = keyof typeof EDGES;

export const STOP_REASONS = new Set([
  "end_turn",
  "max_tokens",
  "stop_sequence",
  "tool_use",
  "refusal",
  "content_filter",
  "other",
]);
export const STATUSES = new Set([
  "ok",
  "rate_limited",
  "timeout",
  "connection_error",
  "auth_error",
  "bad_request",
  "server_error",
  "error",
]);

export const MAX_WINDOWS_PER_REQUEST = 50;
export const MODEL_MAX_LEN = 128;
export const TAG_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;
export const WINDOW_SECONDS = 60;

export function bucketIndex(metric: Metric, value: number): number {
  const edges = EDGES[metric];
  let lo = 0;
  let hi = edges.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (value < (edges[mid] as number)) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

export function emptyCounts(metric: Metric): number[] {
  return new Array<number>(EDGES[metric].length + 1).fill(0);
}

// Provider stop/finish reasons -> protocol vocabulary. Anything unmapped becomes "other": raw provider
// strings are never sent.
const STOP_REASON_MAP: Record<string, string> = {
  // Anthropic
  end_turn: "end_turn",
  max_tokens: "max_tokens",
  model_context_window_exceeded: "max_tokens",
  stop_sequence: "stop_sequence",
  tool_use: "tool_use",
  refusal: "refusal",
  // OpenAI chat completions
  stop: "end_turn",
  length: "max_tokens",
  tool_calls: "tool_use",
  function_call: "tool_use",
  content_filter: "content_filter",
  // OpenAI responses (incomplete_details.reason)
  max_output_tokens: "max_tokens",
};

export function normalizeStopReason(raw: unknown): string {
  return typeof raw === "string" && Object.hasOwn(STOP_REASON_MAP, raw) ? (STOP_REASON_MAP[raw] as string) : "other";
}

// Error class names shared by the @anthropic-ai/sdk and openai packages (matched by name so neither is imported).
const STATUS_BY_ERROR: Record<string, string> = {
  RateLimitError: "rate_limited",
  APIConnectionTimeoutError: "timeout",
  // Server unreachable. Checked after the class itself, so APIConnectionTimeoutError (a subclass) stays "timeout".
  APIConnectionError: "connection_error",
  AuthenticationError: "auth_error",
  PermissionDeniedError: "auth_error",
  BadRequestError: "bad_request",
  UnprocessableEntityError: "bad_request",
  NotFoundError: "bad_request",
  ConflictError: "bad_request",
  RequestTooLargeError: "bad_request",
  InternalServerError: "server_error",
  OverloadedError: "server_error",
  ServiceUnavailableError: "server_error",
};

// Node / undici error codes, on the error itself or on its `cause` (fetch throws `TypeError: fetch failed`).
const CONNECTION_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ECONNABORTED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
  "UND_ERR_SOCKET",
]);
const TIMEOUT_CODES = new Set(["ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT"]);

function networkStatus(err: object): string | null {
  for (let e: unknown = err, depth = 0; typeof e === "object" && e !== null && depth < 3; depth++) {
    const code: unknown = (e as { code?: unknown }).code;
    if (typeof code === "string") {
      if (CONNECTION_CODES.has(code)) return "connection_error";
      if (TIMEOUT_CODES.has(code)) return "timeout";
    }
    e = (e as { cause?: unknown }).cause;
  }
  return null;
}

export function statusFromError(err: unknown): string {
  if (typeof err !== "object" || err === null) return "error";
  for (let proto = Object.getPrototypeOf(err); proto !== null; proto = Object.getPrototypeOf(proto)) {
    const name: unknown = proto.constructor?.name;
    if (typeof name === "string" && Object.hasOwn(STATUS_BY_ERROR, name)) return STATUS_BY_ERROR[name] as string;
  }
  const network = networkStatus(err);
  if (network !== null) return network;
  const code: unknown = (err as { status?: unknown }).status;
  if (typeof code === "number" && Number.isInteger(code)) {
    if (code === 429) return "rate_limited";
    if (code === 401 || code === 403) return "auth_error";
    if (code >= 400 && code < 500) return "bad_request";
    if (code >= 500) return "server_error";
  }
  return "error";
}

export function cleanModel(model: unknown): string {
  const text = typeof model === "string" && model ? model : "unknown";
  return text.slice(0, MODEL_MAX_LEN);
}

export function validateTag(tag: string | null | undefined): string | null {
  if (tag === null || tag === undefined) return null;
  if (typeof tag !== "string" || !TAG_PATTERN.test(tag)) {
    throw new Error(`Invalid aikraft tag ${JSON.stringify(tag)}: use 1-64 characters from [A-Za-z0-9_.-].`);
  }
  return tag;
}

/** Length in code points, so `output_chars` means the same as in the Python SDK. */
export function charCount(text: string): number {
  let n = text.length;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= 0xdc00 && c <= 0xdfff) n--; // low surrogate: second half of a code point already counted
  }
  return n;
}
