import { log } from "../log.js";

export type ZulipClient = {
  baseUrl: string;
  authHeader: string;
  request: <T>(path: string, init?: RequestInit) => Promise<T>;
};

export type ZulipApiResponse = {
  result: "success" | "error";
  msg: string;
  code?: string;
  [key: string]: unknown;
};

export type ZulipMessage = {
  id: string;
  sender_id?: string | null;
  sender_email?: string | null;
  sender_full_name?: string | null;
  content?: string | null;
  contentHtml?: string | null;
  timestamp?: number | null;
  type?: "stream" | "private" | string | null;
  stream_id?: string | null;
  display_recipient?: string | Array<{ id: number; email: string; full_name: string }> | null;
  subject?: string | null;
  recipient_id?: string | null;
};

function normalizeBaseUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, "");
}

function buildApiUrl(baseUrl: string, apiPath: string): string {
  const suffix = apiPath.startsWith("/") ? apiPath : `/${apiPath}`;
  return `${baseUrl}/api/v1${suffix}`;
}

function resolveRetryAfterMs(res: Response): number | undefined {
  const retryAfter = res.headers.get("retry-after");
  if (!retryAfter) return undefined;
  const seconds = Number(retryAfter);
  if (!Number.isNaN(seconds)) return Math.max(0, seconds) * 1000;
  const dateMs = Date.parse(retryAfter);
  if (!Number.isNaN(dateMs)) return Math.max(0, dateMs - Date.now());
  return undefined;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readErrorBody(res: Response): Promise<string> {
  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const data = (await res.json()) as ZulipApiResponse | undefined;
    if (data?.msg) return data.msg;
    return JSON.stringify(data);
  }
  return await res.text();
}

function assertSuccess(payload: ZulipApiResponse, context: string): void {
  if (payload.result === "success") return;
  throw new Error(`${context}: ${payload.msg || "unknown error"}`);
}

export function createZulipClient(params: {
  baseUrl: string;
  email: string;
  apiKey: string;
}): ZulipClient {
  const baseUrl = normalizeBaseUrl(params.baseUrl);
  if (!baseUrl) throw new Error("Zulip baseUrl is required");
  const email = params.email?.trim();
  const apiKey = params.apiKey?.trim();
  if (!email || !apiKey) throw new Error("Zulip email + apiKey are required");

  const authHeader = Buffer.from(`${email}:${apiKey}`).toString("base64");

  const request = async <T>(apiPath: string, init?: RequestInit): Promise<T> => {
    const url = buildApiUrl(baseUrl, apiPath);
    const headers = new Headers(init?.headers);
    headers.set("Authorization", `Basic ${authHeader}`);
    if (init?.body && !headers.has("Content-Type") && typeof init.body === "string") {
      headers.set("Content-Type", "application/x-www-form-urlencoded");
    }
    const res = await fetch(url, { ...init, headers });
    if (!res.ok) {
      const detail = await readErrorBody(res);
      const error = new Error(
        `Zulip API ${res.status} ${res.statusText}: ${detail || "unknown error"}`,
      ) as Error & { status?: number };
      error.status = res.status;
      throw error;
    }
    return (await res.json()) as T;
  };

  return { baseUrl, authHeader, request };
}

async function requestWithRetry<T>(
  client: ZulipClient,
  apiPath: string,
  init?: RequestInit,
  options?: {
    maxRetries?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
  },
): Promise<T> {
  const maxRetries = options?.maxRetries ?? 3;
  const baseDelayMs = options?.baseDelayMs ?? 1000;
  const maxDelayMs = options?.maxDelayMs ?? 120000;
  const retryStatuses = new Set([429, 502, 503, 504]);

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const url = buildApiUrl(client.baseUrl, apiPath);
    const headers = new Headers(init?.headers);
    headers.set("Authorization", `Basic ${client.authHeader}`);
    if (init?.body && !headers.has("Content-Type") && typeof init.body === "string") {
      headers.set("Content-Type", "application/x-www-form-urlencoded");
    }
    const res = await fetch(url, { ...init, headers });
    if (res.ok) return (await res.json()) as T;

    const status = res.status;
    const retryAfterMs = resolveRetryAfterMs(res);
    const detail = await readErrorBody(res);
    const error = new Error(
      `Zulip API ${status} ${res.statusText}: ${detail || "unknown error"}`,
    ) as Error & { status?: number };
    error.status = status;

    if (!retryStatuses.has(status) || attempt >= maxRetries) {
      throw error;
    }

    const backoff = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
    const jitter = Math.random() * 0.2 * backoff;
    const waitMs =
      retryAfterMs && retryAfterMs > 0 ? Math.min(maxDelayMs, retryAfterMs) : backoff + jitter;
    log(`zulip: retrying after ${Math.round(waitMs)}ms (attempt ${attempt + 1}, status ${status})`);
    await delay(waitMs);
  }

  throw new Error("Zulip API request failed after retries");
}

export async function sendStreamMessage(
  client: ZulipClient,
  params: { stream: string; topic: string; content: string },
): Promise<string> {
  const body = new URLSearchParams({
    type: "stream",
    to: params.stream,
    topic: params.topic,
    content: params.content,
  });
  const payload = await requestWithRetry<ZulipApiResponse & { id?: number }>(
    client,
    "/messages",
    { method: "POST", body: body.toString() },
  );
  assertSuccess(payload, "Zulip stream send failed");
  return String(payload.id ?? "");
}

export async function sendPrivateMessage(
  client: ZulipClient,
  params: { to: string | string[]; content: string },
): Promise<string> {
  const recipients = Array.isArray(params.to) ? params.to : [params.to];
  const body = new URLSearchParams({
    type: "private",
    to: JSON.stringify(recipients),
    content: params.content,
  });
  const payload = await requestWithRetry<ZulipApiResponse & { id?: number }>(
    client,
    "/messages",
    { method: "POST", body: body.toString() },
  );
  assertSuccess(payload, "Zulip private send failed");
  return String(payload.id ?? "");
}

export async function uploadFile(
  client: ZulipClient,
  filePath: string,
): Promise<{ url: string }> {
  const filename = filePath.split("/").pop() || "upload.bin";
  const form = new FormData();
  form.append("file", Bun.file(filePath), filename);
  const payload = await requestWithRetry<ZulipApiResponse & { uri?: string }>(
    client,
    "/user_uploads",
    { method: "POST", body: form },
  );
  assertSuccess(payload, "Zulip file upload failed");
  if (!payload.uri) throw new Error("Zulip file upload missing uri");
  const url = payload.uri.startsWith("/") ? `${client.baseUrl}${payload.uri}` : payload.uri;
  return { url };
}

export async function addReaction(
  client: ZulipClient,
  params: { messageId: string; emojiName: string; emojiCode?: string; reactionType?: string },
): Promise<void> {
  const body = new URLSearchParams({ emoji_name: params.emojiName });
  if (params.emojiCode) body.set("emoji_code", params.emojiCode);
  if (params.reactionType) body.set("reaction_type", params.reactionType);
  const payload = await requestWithRetry<ZulipApiResponse>(
    client,
    `/messages/${params.messageId}/reactions`,
    { method: "POST", body: body.toString() },
  );
  assertSuccess(payload, "Zulip add reaction failed");
}

export async function editMessage(
  client: ZulipClient,
  params: { messageId: string; content: string },
): Promise<void> {
  const body = new URLSearchParams({ content: params.content });
  const payload = await client.request<ZulipApiResponse>(`/messages/${params.messageId}`, {
    method: "PATCH",
    body: body.toString(),
  });
  assertSuccess(payload, "Zulip edit message failed");
}

export async function fetchMessages(
  client: ZulipClient,
  params: { stream?: string; topic?: string; limit?: number; messageId?: string },
): Promise<ZulipMessage[]> {
  const limit = Math.min(Math.max(1, params.limit ?? 50), 1000);

  // Fetch by specific message ID
  if (params.messageId) {
    const qs = new URLSearchParams({
      anchor: params.messageId,
      num_before: "0",
      num_after: "0",
      narrow: JSON.stringify([]),
    });
    const payload = await client.request<ZulipApiResponse & { messages?: ZulipMessage[] }>(
      `/messages?${qs.toString()}`,
    );
    assertSuccess(payload, "Zulip /messages failed");
    return payload.messages ?? [];
  }

  const narrow = params.stream
    ? [{ operator: "channel", operand: params.stream } as Record<string, unknown>]
    : [];
  if (params.topic) narrow.push({ operator: "topic", operand: params.topic });
  const qs = new URLSearchParams({
    anchor: "newest",
    num_before: String(limit),
    num_after: "0",
    narrow: JSON.stringify(narrow),
    apply_markdown: "false",
  });
  const payload = await client.request<ZulipApiResponse & { messages?: ZulipMessage[] }>(
    `/messages?${qs.toString()}`,
  );
  assertSuccess(payload, "Zulip /messages failed");
  return payload.messages ?? [];
}

export async function fetchSingleMessage(
  client: ZulipClient,
  messageId: string,
): Promise<ZulipMessage | null> {
  try {
    const payload = await client.request<
      ZulipApiResponse & { message?: ZulipMessage }
    >(`/messages/${messageId}`);
    assertSuccess(payload, "Zulip /messages/{id} failed");
    return payload.message ?? null;
  } catch {
    return null;
  }
}

export async function fetchMe(
  client: ZulipClient,
): Promise<{ id: string; user_id: string; email: string | null; full_name: string | null }> {
  const payload = await client.request<
    ZulipApiResponse & { user_id?: number; email?: string; full_name?: string }
  >("/users/me");
  assertSuccess(payload, "Zulip /users/me failed");
  const id = String(payload.user_id ?? "");
  return {
    id,
    user_id: id,
    email: payload.email ?? null,
    full_name: payload.full_name ?? null,
  };
}

export async function registerQueue(
  client: ZulipClient,
  eventTypes: string[],
): Promise<{ queue_id: string; last_event_id: number }> {
  const body = new URLSearchParams();
  body.set("event_types", JSON.stringify(eventTypes));
  body.set("event_queue_longpoll_timeout_seconds", "90");
  const payload = await client.request<
    ZulipApiResponse & { queue_id?: string; last_event_id?: number }
  >("/register", { method: "POST", body: body.toString() });
  assertSuccess(payload, "Zulip /register failed");
  if (!payload.queue_id) throw new Error("Zulip /register missing queue_id");
  return { queue_id: payload.queue_id, last_event_id: payload.last_event_id ?? -1 };
}

export async function getEvents(
  client: ZulipClient,
  params: { queueId: string; lastEventId: number; signal?: AbortSignal },
): Promise<Array<{ id: number; type: string; message?: ZulipMessage }>> {
  const qs = new URLSearchParams({
    queue_id: params.queueId,
    last_event_id: String(params.lastEventId),
    dont_block: "false",
  });
  const payload = await client.request<
    ZulipApiResponse & { events?: Array<{ id: number; type: string; message?: ZulipMessage }> }
  >(`/events?${qs.toString()}`, { signal: params.signal });
  return payload.events ?? [];
}

export async function deleteQueue(client: ZulipClient, queueId: string): Promise<void> {
  if (!queueId) return;
  try {
    const payload = await client.request<ZulipApiResponse>(`/events?queue_id=${queueId}`, {
      method: "DELETE",
    });
    assertSuccess(payload, "Zulip delete event queue failed");
  } catch {
    // ignore cleanup errors
  }
}
