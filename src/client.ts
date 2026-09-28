// Minimal Carebit Developer Platform API client used by the MCP tools.
// Docs: https://carebit.dev (guides in Markdown at https://carebit.dev/guides/<name>?format=md)
// Spec: https://carebit.dev/openapi.json (OpenAPI 3.1, "Carebit Developer Platform API" v1)
import { randomUUID } from "node:crypto";
import { redactContacts } from "./format.js";

export class CarebitError extends Error {
  constructor(message: string, public readonly status?: number, public readonly code?: string) {
    super(message);
    this.name = "CarebitError";
  }
}

// A 429 means the request was not processed (the edge rejected it), so it is safe to repeat for any
// method. A 409 `idempotency_conflict` is documented as "retry after the value in the Retry-After
// header" with the same Idempotency-Key. A 502/503/504 from a gateway does not prove the upstream did
// not process the request; Carebit documents that 5xx retries with the same Idempotency-Key are safe,
// but this prototype only retries them for GET and for POST /oauth/token (fetching a token is
// idempotent), so a write is never repeated on the strength of documentation alone (see README).
const RETRY_ANY_METHOD = new Set([429]);
const RETRY_GET_ONLY = new Set([502, 503, 504]);
const TOKEN_PATH = "/oauth/token";
const MAX_ATTEMPTS = 3;
// Longest single wait honoured from Retry-After. The MCP SDK's default request timeout is 60 s
// (DEFAULT_REQUEST_TIMEOUT_MSEC), so the whole retry budget (at most two waits) must stay well
// under that; a longer Retry-After makes the call give up at once with the wait time in the message.
// Carebit's rate-limits guide says every 429 carries `Retry-After: 60`, so a real rate limit is
// reported straight away rather than retried.
export const MAX_RETRY_AFTER_S = 10;
// Pagination guide: limit defaults to 25, the maximum is 100 and a larger value gets a 422.
export const PAGE_SIZE = 100;
// Refresh the cached token this long before its documented expiry (expires_in, 3600 in the example),
// or after half its lifetime when it lives less than two minutes, so a short-lived token is still
// reused rather than fetched before every call (/oauth/token allows 10 requests per minute).
const TOKEN_REFRESH_MARGIN_S = 60;
// Shorter values are not scrubbed from passed-on text: they would hit ordinary words.
const MIN_SCRUB_LENGTH = 8;

export type QueryValue = string | number | boolean | string[] | undefined;

// Spec OAuthTokenResponse: access_token, token_type "Bearer", expires_in, created_at, refresh_token, scope.
interface TokenResponse {
  access_token?: string;
  token_type?: string;
  expires_in?: number | string;
  created_at?: number;
  refresh_token?: string;
  scope?: string;
}

// Spec Error: { error: { type, code, message, param?, errors?: [{ code, message, param }] } }.
interface ErrorBody {
  error?: { type?: string; code?: string; message?: string; param?: string | null; errors?: Array<{ code?: string; message?: string; param?: string | null }> | null };
}

export interface ListEnvelope<T> {
  object?: "list";
  url?: string;
  data?: T[];
  has_more?: boolean;
  next_cursor?: string | null;
}

export interface RequestOptions {
  query?: Record<string, QueryValue>;
  body?: unknown;
  /** The OAuth scope the endpoint documents, named in a 403 message. */
  scope?: string;
  /** Sent as the Idempotency-Key header; required by the API on every POST create and PATCH update. */
  idempotencyKey?: string;
}

export class CarebitClient {
  private readonly baseUrl: string;
  // Rate-limits guide: 120 requests per minute per access token (rolling 60 s window), 30 writes per
  // minute per token. One request every 500 ms keeps a single server at the per-token ceiling; the
  // per-project and per-Organization limits are shared with other integrations and cannot be
  // reasoned about here. 429s are reported with the documented Retry-After.
  private nextSlot = 0;
  private readonly minIntervalMs = 500;
  private token?: { value: string; expiresAt: number };
  private tokenRequest?: Promise<string>;

  constructor(private readonly clientId: string, private readonly clientSecret: string, baseUrl = "https://api.carebit.co", private readonly scope?: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  get base(): string {
    return this.baseUrl;
  }

  /**
   * Belt and braces for text that is passed on to the user (Carebit's error messages, body excerpts):
   * the configured client secret and the cached access token are replaced with "[redacted]" should
   * Carebit ever echo them. Contact-detail redaction is applied by the callers.
   */
  private scrub(text: string | undefined): string | undefined {
    if (text === undefined) return undefined;
    let out = text;
    for (const secret of [this.clientSecret, this.token?.value]) {
      if (secret && secret.length >= MIN_SCRUB_LENGTH) out = out.split(secret).join("[redacted]");
    }
    return out;
  }

  private async throttle(): Promise<void> {
    const now = Date.now();
    const wait = Math.max(0, this.nextSlot - now);
    this.nextSlot = Math.max(now, this.nextSlot) + this.minIntervalMs;
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }

  /**
   * Authentication guide, "Client-credentials grant": POST /oauth/token, application/x-www-form-urlencoded,
   * grant_type=client_credentials with client_id and client_secret as body fields, and an optional
   * space-separated scope (omitted, the token gets the project's full scope set). The answer's
   * access_token is cached and refreshed a minute before expires_in runs out, and fetched afresh once
   * when an API call answers 401. The refresh_token is not used: refresh tokens rotate on every use
   * and would have to be stored, while a client-credentials grant can simply be repeated (the token
   * endpoint allows 10 requests per minute per client_id). The token is never written to a log or an
   * error message: only a JSON error message from the token endpoint is passed on, never a raw body.
   */
  private async getToken(force = false): Promise<string> {
    if (!force && this.token && Date.now() < this.token.expiresAt) return this.token.value;
    if (!this.tokenRequest) {
      this.tokenRequest = this.requestToken().finally(() => {
        this.tokenRequest = undefined;
      });
    }
    return this.tokenRequest;
  }

  private async requestToken(): Promise<string> {
    const form = new URLSearchParams({ grant_type: "client_credentials", client_id: this.clientId, client_secret: this.clientSecret });
    if (this.scope) form.set("scope", this.scope);
    const { status, headers, json, text } = await this.send("POST", TOKEN_PATH, {
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: form.toString(),
    });
    const record: TokenResponse | undefined = json && typeof json === "object" && !Array.isArray(json) ? json : undefined;
    if (status === 200 && record && typeof record.access_token === "string" && record.access_token) {
      const expiresIn = Number(record.expires_in);
      const ttl = Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 3600;
      const margin = Math.min(TOKEN_REFRESH_MARGIN_S, ttl / 2);
      this.token = { value: record.access_token, expiresAt: Date.now() + (ttl - margin) * 1000 };
      return record.access_token;
    }
    const err = errorOf(json);
    // The secret and the previous token are scrubbed before the cache is cleared, so a message that
    // echoed the token this client was using is caught too.
    const requestId = headers.get("carebit-developer-platform-api-request-id");
    const detail = `${redactContacts(this.scrub(describeError(json)), false) ?? ""}${requestId ? ` (request id ${requestId})` : ""}`.trim();
    this.token = undefined;
    const where = "Settings > Developer platform > Projects in Carebit, under the project's API credentials";
    if (status === 400 && err?.code === "invalid_scope") {
      throw new CarebitError(`Carebit refused the requested scope (400 invalid_scope). CAREBIT_SCOPE must only name scopes that are on the developer project; unset it to receive the project's full scope set.${detail ? " " + detail : ""}`, status, err.code);
    }
    if (status === 400 || status === 401) {
      throw new CarebitError(`Carebit rejected the client credentials at ${this.baseUrl}${TOKEN_PATH} (${status}). Check CAREBIT_CLIENT_ID and CAREBIT_CLIENT_SECRET: they come from ${where}. A rotated secret replaces the old one.${detail ? " " + detail : ""}`, status, err?.code);
    }
    if (status === 403) {
      throw new CarebitError(`Carebit refused to issue a token (403): the developer project is disabled or archived, or the Organization does not have the developer platform entitlement. Check the project in ${where}.${detail ? " " + detail : ""}`, status, err?.code);
    }
    if (status === 200) {
      // Say what shape came back without echoing any value: the body may hold the token under a key
      // this client does not read.
      // The excerpt is redacted and scrubbed before it is cut, so a contact detail or a secret that
      // straddles the cut cannot leak in part.
      const shape = json && typeof json === "object" ? `JSON with keys ${Object.keys(json).join(", ") || "(none)"}` : `a non-JSON body starting with ${JSON.stringify((redactContacts(this.scrub(text), false) ?? "").slice(0, 60))}`;
      throw new CarebitError(`Carebit answered ${this.baseUrl}${TOKEN_PATH} with 200 but no access_token (${shape}). Check CAREBIT_BASE_URL.${detail ? " " + detail : ""}`, status);
    }
    if (status === 429) throw new CarebitError(`Carebit rate-limited the token endpoint (429): /oauth/token allows 10 requests per minute per client_id and per IP. Wait a minute and try again.${detail ? " " + detail : ""}`, status, err?.code);
    if (RETRY_GET_ONLY.has(status)) throw new CarebitError(`Carebit returned ${status} for POST ${this.baseUrl}${TOKEN_PATH} ${MAX_ATTEMPTS} times in a row. The service may be unavailable; check CAREBIT_BASE_URL and try again in a few minutes.${detail ? " " + detail : ""}`, status);
    throw new CarebitError(`Carebit returned ${status} for POST ${this.baseUrl}${TOKEN_PATH}. Check CAREBIT_BASE_URL and try again.${detail ? " " + detail : ""}`, status, err?.code);
  }

  /** One HTTP exchange with throttling and the 429 / 409 / gateway retry policy; no auth handling. */
  private async send(method: string, path: string, init: { headers: Record<string, string>; body?: string; query?: Record<string, QueryValue> }): Promise<{ status: number; headers: Headers; text: string; json: any }> {
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(init.query ?? {})) {
      if (v === undefined || v === "") continue;
      // Array parameters are documented with a [] suffix (clinician_ids[], ids[]) and repeated.
      if (Array.isArray(v)) for (const item of v) url.searchParams.append(k, item);
      else url.searchParams.set(k, String(v));
    }
    const shown = `${method} ${path}`;
    const gatewayRetry = method === "GET" || (method === "POST" && path === TOKEN_PATH);
    // Idempotency guide: a 409 idempotency_conflict (the same key still in flight) is retried after
    // Retry-After, defaulting to 1 second, with the same key. Only writes carry a key.
    const conflictRetry = init.headers["Idempotency-Key"] !== undefined;
    for (let attempt = 0; ; attempt++) {
      await this.throttle();
      let res: Response;
      try {
        res = await fetch(url, { method, headers: init.headers, body: init.body });
      } catch (err) {
        throw new CarebitError(`Could not reach Carebit at ${this.baseUrl}: ${(err as Error).message}. Check CAREBIT_BASE_URL and the network.`);
      }
      let retryable = RETRY_ANY_METHOD.has(res.status) || (gatewayRetry && RETRY_GET_ONLY.has(res.status));
      let text: string | undefined;
      let json: any;
      if (res.status === 409 && conflictRetry) {
        text = await res.text();
        json = text ? safeJson(text) : undefined;
        retryable = errorOf(json)?.code === "idempotency_conflict";
      }
      if (retryable && attempt < MAX_ATTEMPTS - 1) {
        const retryAfter = parseRetryAfter(res.headers.get("retry-after"));
        if (retryAfter !== undefined && retryAfter > MAX_RETRY_AFTER_S) {
          const requestId = res.headers.get("carebit-developer-platform-api-request-id");
          throw new CarebitError(`Carebit asked to wait ${Math.ceil(retryAfter)} seconds before retrying ${shown} (HTTP ${res.status}). Try again after that.${requestId ? ` (request id ${requestId})` : ""}`, res.status);
        }
        // A missing or unparsable header falls back to 2 s then 4 s (1 s for the documented 409
        // default); a Retry-After of 0 (or a date already passed) means retry now, subject to the throttle.
        const delay = retryAfter !== undefined ? retryAfter * 1000 : res.status === 409 ? 1000 : 2000 * (attempt + 1);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      if (text === undefined) {
        text = res.status === 204 ? "" : await res.text();
        json = text ? safeJson(text) : undefined;
      }
      return { status: res.status, headers: res.headers, text, json };
    }
  }

  /** Like request(), but also returns the response headers and status. */
  async requestWithHeaders<T = any>(method: string, path: string, opts: RequestOptions = {}): Promise<{ data: T; headers: Headers; status: number }> {
    for (let auth = 0; ; auth++) {
      const token = await this.getToken(auth > 0);
      const { status, headers, text, json } = await this.send(method, path, {
        query: opts.query,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
          ...(opts.idempotencyKey !== undefined ? { "Idempotency-Key": opts.idempotencyKey } : {}),
        },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      });
      // A cached token may have been revoked or expired early: fetch a fresh one and retry once.
      if (status === 401 && auth === 0) continue;

      if (status === 204) return { data: undefined as T, headers, status };
      if (status >= 200 && status < 300) {
        // Every documented 2xx body is a JSON object. A 200 with HTML (a proxy, a captive portal, a
        // login page) must not be mistaken for an empty list or an empty record. The excerpt goes
        // through the contact redaction like every other passed-on text, before it is cut, so a
        // contact detail that straddles the cut cannot leak in part.
        if (!json || typeof json !== "object") {
          throw new CarebitError(
            `Carebit returned ${status} for ${method} ${path} but the body was not JSON (starts with: ${JSON.stringify((redactContacts(this.scrub(text), false) ?? "").slice(0, 60))}). Check CAREBIT_BASE_URL and whether a proxy or login page is in the way.`,
            status,
          );
        }
        return { data: json as T, headers, status };
      }

      // Validation-errors guide: every error is { error: { type, code, message, param?, errors? } }.
      // The message is free text, so anything that looks like a contact detail is redacted before it
      // is passed on. The request id header is included for support tickets.
      const err = errorOf(json);
      const detail = redactContacts(this.scrub(describeError(json) ?? (json === undefined ? text : "")), false)?.slice(0, 300);
      const requestId = headers.get("carebit-developer-platform-api-request-id");
      const suffix = `${detail ? " " + detail : ""}${requestId ? ` (request id ${requestId})` : ""}`;
      if (status === 401) {
        throw new CarebitError(`Carebit rejected the access token (401) for ${method} ${path}, even after fetching a fresh one. Check that the API credential and its developer project are still active in Carebit (Settings > Developer platform) and that CAREBIT_CLIENT_ID / CAREBIT_CLIENT_SECRET belong to the right Organization.${suffix}`, 401, err?.code);
      }
      if (status === 403) {
        const scope = opts.scope ? ` This endpoint requires the \`${opts.scope}\` scope: add it to the developer project in Carebit (Settings > Developer platform > Projects) and, if CAREBIT_SCOPE is set, include it there.` : "";
        throw new CarebitError(`Carebit refused ${method} ${path} (403).${scope} A 403 also means the project is disabled.${suffix}`, 403, err?.code);
      }
      if (status === 404) throw new CarebitError(`Not found: ${path}. Check the ID; the resource does not exist or is outside this Organization.${suffix}`, 404, err?.code);
      if (status === 409) throw new CarebitError(`Carebit reported a conflict for ${method} ${path} (409${err?.code ? ` ${err.code}` : ""}).${suffix}`, 409, err?.code);
      if (status === 422) throw new CarebitError(`Carebit rejected ${method} ${path} (422 validation error).${suffix}`, 422, err?.code);
      if (status === 429) throw new CarebitError(`Carebit rate limit reached (429): 120 requests and 30 writes per minute per access token, more per project and Organization. Wait a minute and try again.${suffix}`, 429, err?.code);
      if (status === 400) throw new CarebitError(`Carebit rejected ${method} ${path} (400).${suffix}`, 400, err?.code);
      if (method !== "GET" && RETRY_GET_ONLY.has(status)) {
        throw new CarebitError(
          `Carebit returned ${status} for ${method} ${path}. The request was not retried because it may already have been processed: check with the matching list or get tool before repeating it.${suffix}`,
          status,
        );
      }
      if (RETRY_GET_ONLY.has(status)) {
        // A GET that failed MAX_ATTEMPTS times in a row. The gateway body is usually HTML, so only a
        // JSON message is passed on.
        const jsonDetail = redactContacts(this.scrub(describeError(json)), false);
        throw new CarebitError(`Carebit returned ${status} for ${method} ${path} ${MAX_ATTEMPTS} times in a row. The service may be unavailable; try again in a few minutes.${jsonDetail ? " " + jsonDetail : ""}${requestId ? ` (request id ${requestId})` : ""}`, status);
      }
      throw new CarebitError(`Carebit returned ${status} for ${method} ${path}.${suffix}`, status, err?.code);
    }
  }

  async request<T = any>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
    return (await this.requestWithHeaders<T>(method, path, opts)).data;
  }

  get<T = any>(path: string, query?: Record<string, QueryValue>, scope?: string) {
    return this.request<T>("GET", path, { query, scope });
  }

  /** A POST create with a fresh Idempotency-Key (one UUID per logical operation, kept across retries). */
  post<T = any>(path: string, body: unknown, scope?: string) {
    return this.requestWithHeaders<T>("POST", path, { body, scope, idempotencyKey: randomUUID() });
  }

  /**
   * Fetch a cursor-paginated collection (pagination guide: a list envelope with data, has_more and
   * next_cursor; send next_cursor as `cursor` with the original filters; limit up to 100). Stops at
   * `maxItems`, at `maxPages`, or when has_more is false. Continuation is by `next_cursor`. The guide
   * says has_more and next_cursor always agree; a page that claims more results without a usable
   * cursor is reported as incomplete, with a note, rather than as the whole collection.
   */
  async list<T = any>(
    path: string,
    { maxItems = PAGE_SIZE, maxPages = 10, cursor, query = {} as Record<string, QueryValue>, scope }: { maxItems?: number; maxPages?: number; cursor?: string; query?: Record<string, QueryValue>; scope?: string } = {},
  ): Promise<{ items: T[]; complete: boolean; next_cursor?: string; note?: string }> {
    const items: T[] = [];
    let next = cursor;
    for (let page = 0; page < maxPages; page++) {
      const limit = Math.max(1, Math.min(PAGE_SIZE, maxItems - items.length));
      const res = await this.get<ListEnvelope<T>>(path, { ...query, limit, cursor: next }, scope);
      const data = Array.isArray(res?.data) ? res.data : [];
      items.push(...data);
      const hasMore = res?.has_more === true && typeof res.next_cursor === "string" && res.next_cursor !== "";
      next = hasMore ? (res.next_cursor as string) : undefined;
      if (res?.has_more === true && !hasMore) return { items, complete: false, note: `The API reported more results (has_more) for ${path} but returned no next_cursor to continue from; the list is incomplete. Try again, or narrow the filters.` };
      if (!hasMore) return { items, complete: true };
      if (items.length >= maxItems) return { items: items.slice(0, maxItems), complete: false, next_cursor: next };
    }
    return { items, complete: false, next_cursor: next };
  }
}

/**
 * Retry-After in seconds, from either form allowed by RFC 9110 (delay-seconds or an HTTP-date).
 * A fractional number is accepted as seconds too. Anything else that is not an HTTP-date (which always
 * names a month, so contains letters) gives undefined, so the caller's fallback applies; without that
 * check Date.parse("1.5") would be read as a date in 2001 and the retry would happen at once.
 */
export function parseRetryAfter(header: string | null, now = Date.now()): number | undefined {
  if (!header) return undefined;
  const h = header.trim();
  if (/^\d+(\.\d+)?$/.test(h)) return Number(h);
  if (!/[A-Za-z]/.test(h)) return undefined;
  const at = Date.parse(h);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, (at - now) / 1000);
}

function safeJson(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function errorOf(json: any): ErrorBody["error"] | undefined {
  const e = json && typeof json === "object" ? (json as ErrorBody).error : undefined;
  return e && typeof e === "object" ? e : undefined;
}

// Validation-errors guide: the first validation error is promoted to error.code/message/param and
// every entry in error.errors repeats the shape, so all of them are listed.
function describeError(json: any): string | undefined {
  const e = errorOf(json);
  if (!e) return undefined;
  const parts: string[] = [];
  if (typeof e.message === "string" && e.message.trim()) parts.push(`${e.message.trim()}${e.code ? ` (${e.code}${e.param ? `, param ${e.param}` : ""})` : ""}`);
  if (Array.isArray(e.errors) && e.errors.length > 1) {
    const all = e.errors.map((x) => `${x.param ?? "?"}: ${x.message ?? x.code ?? ""}`.trim()).filter(Boolean).join(" | ");
    if (all) parts.push(`Validation errors: ${all}`);
  }
  return parts.length ? parts.join(" ") : undefined;
}
