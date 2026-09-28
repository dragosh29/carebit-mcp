// Local stand-in for https://api.carebit.co: the OAuth 2.0 client-credentials token endpoint
// (POST /oauth/token) and the /v1 endpoints this server uses, serving the fixtures with the documented
// list envelope and cursor pagination, the documented filters, the Idempotency-Key contract and the
// documented error envelope.
import http from "node:http";
import { randomUUID } from "node:crypto";
import * as fx from "./fixtures.mjs";

// Obviously fake, low-entropy values. Never the example credentials printed in Carebit's spec or
// guides: secret scanners flag those in a public repository.
export const CLIENT_ID = "carebit-test-client-not-real";
export const CLIENT_SECRET = "carebit-test-secret-not-real";
// The scopes the mock's "developer project" holds: everything this server's tools need.
export const PROJECT_SCOPES = ["availability_slots.read", "bookings.cancel", "bookings.create", "bookings.read", "clinician_agenda.read", "clinicians.read", "human_tasks.create", "human_tasks.read", "invoices.read", "locations.read", "organization.read", "patients.read", "payments.read", "services.read"];

// Validation-errors guide: every error is { error: { type, code, message, param?, errors? } }. The
// codes used for 401/403/404 are this mock's own (the spec documents the shape and the documented
// codes for idempotency, scope and rate-limit errors, not a full code list).
const err = (type, code, message, extra = {}) => ({ error: { type, code, message, ...extra } });
const notFound = (what = "resource") => err("invalid_request_error", "resource_missing", `No such ${what}. It does not exist or is outside this Organization.`);
const validation = (errors) => err("invalid_request_error", errors[0].code, errors[0].message, { param: errors[0].param, errors });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY_MS = 86_400_000;

export function startMock() {
  const requests = [];
  const tokens = new Map(); // token -> { scopes, expiresAt, id }
  const everIssued = new Set(); // every token value ever minted, kept across revokeTokens()
  let issued = 0;
  // expires_in of issued tokens; 3600 as in the documented example. Lowered by a check to prove the
  // client refreshes a token before it expires.
  let tokenTtl = 3600;
  // Every list page is capped at this many items whatever `limit` asks (the requested limit is still
  // recorded), so the suite exercises several pages and the cursor contract with small fixtures.
  let pageCap = 4;
  // Injected failures: { method, path, status, times, headers, body, text }. Each matching request
  // consumes one "time" and gets that status instead of the normal answer (`body` as JSON, `text` as
  // text/html, neither as a generic HTML gateway page). They apply to POST /oauth/token as well. The
  // suite starts with a single 429 on GET /v1/services so the retry path is exercised by the schema
  // check and the MCP run alike. Rate-limits guide: 429 bodies are
  // { error: { type: "rate_limit_error", code: "too_many_requests", message } } with Retry-After.
  const failure429 = () => ({ method: "GET", path: "/v1/services", status: 429, times: 1, headers: { "Retry-After": "1" }, body: err("rate_limit_error", "too_many_requests", "Too many requests. Please slow down.") });
  let failures = [failure429()];
  // Idempotency guide: same key + same body replays the stored response with Idempotency-Replayed:
  // true; same key + different body is 422 idempotency_key_reused. `pendingConflicts` makes the next
  // n writes with a new key answer 409 idempotency_conflict (a concurrent request holding the lease).
  const idempotency = new Map(); // key -> { body, status, json }
  let pendingConflicts = 0;
  const created = []; // bookings and tasks created through POST
  const canceled = new Map(); // booking id -> canceled record

  const allBookings = () => [...fx.bookings, ...created.filter((r) => r.object === "booking")].map((b) => canceled.get(b.id) ?? b);
  const allTasks = () => [...created.filter((r) => r.object === "human_task").reverse(), ...fx.humanTasks];

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const path = url.pathname.replace(/\/+$/, "") || "/";
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const contentType = req.headers["content-type"] ?? "";
    let body;
    if (raw) body = /^application\/x-www-form-urlencoded/.test(contentType) ? Object.fromEntries(new URLSearchParams(raw)) : /^application\/json/.test(contentType) ? JSON.parse(raw) : raw;
    // Repeated query keys (clinician_ids[], ids[]) are kept as arrays.
    const query = {};
    for (const [k, v] of url.searchParams) query[k] = k in query ? [].concat(query[k], v) : v;
    const q = (name) => url.searchParams.get(name);
    const requestId = randomUUID();
    requests.push({ method: req.method, path, query, auth: req.headers.authorization, idempotencyKey: req.headers["idempotency-key"], contentType, body, t: Date.now(), requestId });

    const send = (status, json, headers = {}) => {
      res.writeHead(status, { ...(json === undefined ? {} : { "Content-Type": "application/json" }), "Carebit-Developer-Platform-API-Request-Id": requestId, ...headers });
      return res.end(json === undefined ? "" : JSON.stringify(json)); // truthy, so `requireScope(...) ?? send(...)` and `if (requireScope(...)) return` work
    };

    const failure = failures.find((f) => f.times > 0 && f.method === req.method && f.path === path);
    if (failure) {
      failure.times--;
      if (failure.body === undefined) {
        // Gateway-style error (or any other non-JSON page): text/html, like a real 502 page.
        res.writeHead(failure.status, { "Content-Type": "text/html", ...(failure.headers ?? {}) });
        return res.end(failure.text ?? `<html><body><h1>${failure.status}</h1></body></html>`);
      }
      return send(failure.status, failure.body, failure.headers ?? {});
    }

    // ---- OAuth: POST /oauth/token, x-www-form-urlencoded client credentials (authentication guide) ----
    if (path === "/oauth/token") {
      if (req.method !== "POST") return send(404, notFound("route"));
      if (!/^application\/x-www-form-urlencoded/.test(contentType)) return send(400, err("invalid_request_error", "invalid_request", "The body must be application/x-www-form-urlencoded."));
      if (body?.grant_type !== "client_credentials") return send(400, err("invalid_request_error", "unsupported_grant_type", "Only client_credentials is supported by this mock."));
      if (body?.client_id !== CLIENT_ID || body?.client_secret !== CLIENT_SECRET) return send(401, err("authentication_error", "invalid_client", "Client authentication failed."));
      const requested = body.scope ? String(body.scope).split(" ").filter(Boolean) : PROJECT_SCOPES;
      const unknown = requested.filter((s) => !PROJECT_SCOPES.includes(s));
      if (unknown.length) return send(400, err("invalid_request_error", "invalid_scope", `The requested scope is not on the project: ${unknown.join(", ")}.`));
      const token = `mock-token-${++issued}-${Math.random().toString(36).slice(2)}`;
      const now = Math.floor(Date.now() / 1000);
      tokens.set(token, { id: fx.uuid(1000 + issued), scopes: [...requested].sort(), expiresAt: (now + tokenTtl) * 1000 });
      everIssued.add(token);
      // Spec OAuthTokenResponse (and the authentication guide's example): a refresh token comes with every grant.
      return send(200, { access_token: token, token_type: "Bearer", expires_in: tokenTtl, created_at: now, refresh_token: `mock-refresh-${issued}-not-real`, scope: requested.join(" ") });
    }

    const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
    const tok = bearer ? tokens.get(bearer) : undefined;
    if (!tok) return send(401, err("authentication_error", "invalid_token", "The access token is missing, invalid, expired, or revoked."));
    const requireScope = (scope) => (tok.scopes.includes(scope) ? null : send(403, err("permission_error", "insufficient_scope", `The access token does not carry the \`${scope}\` scope.`)));

    // ---- Pagination guide: list envelope, limit 1-100 (default 25, larger is a 422), cursor = next_cursor ----
    const paged = (items) => {
      const requested = q("limit") === null ? 25 : Number(q("limit"));
      if (!Number.isInteger(requested) || requested < 1 || requested > 100) return send(422, validation([{ code: "invalid_parameter", message: "`limit` must be between 1 and 100.", param: "limit" }]));
      if (q("cursor") !== null && q("starting_after") !== null) return send(400, err("invalid_request_error", "invalid_parameter", "You cannot use `cursor` with `starting_after`.", { param: "cursor" }));
      let offset = 0;
      if (q("cursor") !== null) {
        try {
          offset = JSON.parse(Buffer.from(q("cursor"), "base64url").toString("utf8")).offset;
        } catch {
          return send(400, err("invalid_request_error", "invalid_parameter", "`cursor` is malformed.", { param: "cursor" }));
        }
      }
      const size = Math.min(requested, pageCap);
      const data = items.slice(offset, offset + size);
      const hasMore = offset + data.length < items.length;
      return send(200, { object: "list", url: `https://api.carebit.co${path}`, data, has_more: hasMore, next_cursor: hasMore ? Buffer.from(JSON.stringify({ offset: offset + data.length })).toString("base64url") : null });
    };
    // Agenda and slots answer the list envelope but document no pagination parameters: one page, everything.
    const unpaged = (items) => send(200, { object: "list", url: `https://api.carebit.co${path}`, data: items, has_more: false, next_cursor: null });
    const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v ?? "") && !Number.isNaN(Date.parse(v));
    const isDateTime = (v) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(v ?? "") && !Number.isNaN(Date.parse(v));
    const dayRange = (start, end, max) => {
      if (!isDate(start) || !isDate(end)) return "`start_date` and `end_date` are required, in YYYY-MM-DD format.";
      const days = Math.round((Date.parse(end) - Date.parse(start)) / DAY_MS) + 1;
      if (days < 1) return "`end_date` must not be before `start_date`.";
      if (days > max) return `The inclusive range cannot exceed ${max} days.`;
      return null;
    };

    // ---- Idempotency guide header contract, applied to every POST under /v1 ----
    const write = (handler) => {
      const key = req.headers["idempotency-key"];
      if (key === undefined || String(key).trim() === "") return send(400, err("invalid_request_error", "idempotency_key_required", "The `Idempotency-Key` header is required."));
      if (String(key).length > 255) return send(400, err("invalid_request_error", "idempotency_key_too_long", "The `Idempotency-Key` header must be at most 255 characters."));
      if (!/^application\/json/.test(contentType)) return send(400, err("invalid_request_error", "invalid_request", "The body must be application/json."));
      const stored = idempotency.get(key);
      if (stored) {
        if (stored.body !== raw) return send(422, err("invalid_request_error", "idempotency_key_reused", "This `Idempotency-Key` was already used for a different request."));
        return send(stored.status, stored.json, { "Idempotency-Replayed": "true" });
      }
      if (pendingConflicts > 0) {
        pendingConflicts--;
        return send(409, err("invalid_request_error", "idempotency_conflict", "Another request with this `Idempotency-Key` is in flight."), { "Retry-After": "1" });
      }
      const out = handler(body ?? {});
      if (out.status < 300) idempotency.set(key, { body: raw, status: out.status, json: out.json });
      return send(out.status, out.json);
    };

    const seg = path.split("/").filter(Boolean); // ["v1", ...]
    if (seg[0] !== "v1") return send(404, notFound("route"));
    const m = req.method;
    const [, resource, id, sub] = seg;

    if (resource === "token" && m === "GET" && seg.length === 2) return send(200, fx.tokenInfo(tok.id, new Date(tok.expiresAt).toISOString(), tok.scopes));
    if (resource === "organization" && m === "GET" && seg.length === 2) return requireScope("organization.read") ?? send(200, fx.organization);

    if (resource === "clinicians" && m === "GET") {
      if (requireScope("clinicians.read")) return;
      if (seg.length === 2) return paged(fx.clinicians);
      const c = fx.clinicians.find((x) => x.id === id);
      return c && seg.length === 3 ? send(200, c) : send(404, notFound("clinician"));
    }

    if (resource === "clinician_agenda" && m === "GET" && seg.length === 2) {
      if (requireScope("clinician_agenda.read")) return;
      const ids = [].concat(query["clinician_ids[]"] ?? []);
      if (ids.length !== 1) return send(400, err("invalid_request_error", "invalid_parameter", "Pass exactly one `clinician_ids[]`.", { param: "clinician_ids" }));
      const problem = dayRange(q("start_date"), q("end_date"), 45);
      if (problem) return send(400, err("invalid_request_error", "invalid_parameter", problem, { param: "start_date" }));
      if (!fx.clinicians.some((c) => c.id === ids[0])) return send(404, notFound("clinician"));
      const from = Date.parse(q("start_date"));
      const to = Date.parse(q("end_date")) + DAY_MS;
      const items = (fx.agenda[ids[0]] ?? []).filter((i) => Date.parse(i.start_time) >= from && Date.parse(i.start_time) < to).sort((a, b) => Date.parse(a.start_time) - Date.parse(b.start_time));
      return unpaged(items);
    }

    if ((resource === "availability_slots" || resource === "next_availability_slot") && m === "GET" && seg.length === 2) {
      if (requireScope("availability_slots.read")) return;
      const clinicianId = q("clinician_id");
      const variantId = q("service_variant_id");
      if (!UUID.test(clinicianId ?? "") || !UUID.test(variantId ?? "")) return send(400, err("invalid_request_error", "missing_parameter", "`clinician_id` and `service_variant_id` are required.", { param: "clinician_id" }));
      if (!fx.clinicians.some((c) => c.id === clinicianId) || !fx.services.some((s) => s.service_variants.some((v) => v.id === variantId))) return send(404, notFound("clinician or service variant"));
      const mine = fx.slots.filter((s) => s.clinician_id === clinicianId && s.service_variant_id === variantId);
      if (resource === "availability_slots") {
        const problem = dayRange(q("start_date"), q("end_date"), 45);
        if (problem) return send(400, err("invalid_request_error", "invalid_parameter", problem, { param: "start_date" }));
        const from = Date.parse(q("start_date"));
        const to = Date.parse(q("end_date")) + DAY_MS;
        return unpaged(mine.filter((s) => Date.parse(s.start_time) >= from && Date.parse(s.start_time) < to));
      }
      const fromDate = q("from_date");
      if (fromDate !== null && !isDate(fromDate)) return send(400, err("invalid_request_error", "invalid_parameter", "`from_date` must be YYYY-MM-DD.", { param: "from_date" }));
      const from = fromDate ? Date.parse(fromDate) : 0; // "defaults to today"; the fixtures are all in the future of the mock's epoch
      const next = mine.find((s) => Date.parse(s.start_time) >= from);
      return next ? send(200, next) : send(404, err("invalid_request_error", "resource_missing", "No slot was available within 8 months."));
    }

    if (resource === "bookings") {
      if (m === "GET" && seg.length === 2) {
        if (requireScope("bookings.read")) return;
        const status = q("status");
        const recall = ["awaiting_recall", "overdue_for_recall", "recall_expired", "recall_canceled"].includes(status);
        const from = q("start_time_from");
        const to = q("start_time_to");
        let items = allBookings();
        if (recall) {
          if (from !== null || to !== null) return send(400, err("invalid_request_error", "invalid_parameter", "Omit the date window for recall statuses.", { param: "start_time_from" }));
          items = items.filter((b) => b.status === status).sort((a, b) => (a.recall_due_date ?? "").localeCompare(b.recall_due_date ?? ""));
        } else {
          if (!isDateTime(from) || !isDateTime(to)) return send(400, err("invalid_request_error", "missing_parameter", "`start_time_from` and `start_time_to` are required for diary queries, in UTC ISO 8601 format.", { param: "start_time_from" }));
          const patientId = q("patient_id");
          if (patientId !== null && !fx.patientById[patientId]) return send(404, notFound("patient"));
          const maxDays = patientId ? 90 : 30;
          if (Date.parse(to) - Date.parse(from) > maxDays * DAY_MS) return send(400, err("invalid_request_error", "invalid_parameter", `The range cannot exceed ${maxDays} days.`, { param: "start_time_to" }));
          items = items.filter((b) => b.start_time !== null && Date.parse(b.start_time) >= Date.parse(from) && Date.parse(b.start_time) <= Date.parse(to)).sort((a, b) => Date.parse(a.start_time) - Date.parse(b.start_time));
          if (status) items = items.filter((b) => b.status === status);
        }
        if (q("clinician_id")) items = items.filter((b) => b.clinician?.id === q("clinician_id"));
        if (q("patient_id")) items = items.filter((b) => b.patient?.id === q("patient_id"));
        if (q("updated_since")) items = items.filter((b) => Date.parse(b.updated_at) >= Date.parse(q("updated_since")));
        return paged(items);
      }
      if (m === "POST" && seg.length === 2) {
        if (requireScope("bookings.create")) return;
        return write((b) => {
          const errors = [];
          for (const f of ["patient_id", "service_id", "service_variant_id", "start_time"]) if (b[f] === undefined) errors.push({ code: "missing_parameter", message: `\`${f}\` is required.`, param: f });
          if (b.status === "awaiting_recall") errors.push({ code: "invalid_parameter", message: "This mock only creates diary Bookings.", param: "status" });
          if (errors.length) return { status: 422, json: validation(errors) };
          const patient = fx.patientById[b.patient_id];
          const service = fx.services.find((s) => s.id === b.service_id);
          const variant = service?.service_variants.find((v) => v.id === b.service_variant_id);
          const clinician = b.clinician_id ? fx.clinicians.find((c) => c.id === b.clinician_id) : null;
          const location = b.location_id ? fx.locations.find((l) => l.id === b.location_id) : null;
          if (!patient || !service || !variant || (b.clinician_id && !clinician) || (b.location_id && !location)) return { status: 404, json: notFound("referenced resource") };
          const id = fx.uuid(900 + created.length);
          const end = b.end_time ?? new Date(Date.parse(b.start_time) + (service.duration_minutes ?? 30) * 60_000).toISOString().replace(".000Z", "Z");
          const record = {
            id,
            object: "booking",
            status: b.status ?? "unconfirmed",
            start_time: b.start_time,
            end_time: end,
            is_remote: b.is_remote === true,
            remote_method: b.remote_method ?? null,
            clinician: clinician ?? null,
            patient,
            service,
            service_variants: [variant],
            location: location ?? null,
            payor: null,
            notify_patient: b.notify_patient ?? true,
            recall_due_date: null,
            recall_programme_id: null,
            canceled_at: null,
            cancellation_reason: null,
            cancellation_source: null,
            cancellation_information: null,
            information_for_patient: b.information_for_patient ?? null,
            information_for_staff_members: b.information_for_staff_members ?? null,
            links: { clinician: clinician ? `https://api.carebit.co/v1/clinicians/${clinician.id}` : null, invoices: `https://api.carebit.co/v1/invoices?booking_id=${id}`, letters: `https://api.carebit.co/v1/letters?booking_id=${id}`, notes: `https://api.carebit.co/v1/notes?booking_id=${id}`, recall_programme: null, service: `https://api.carebit.co/v1/services/${service.id}`, test_results: `https://api.carebit.co/v1/test_results?booking_id=${id}` },
            created_at: "2026-09-28T12:00:00Z",
            updated_at: "2026-09-28T12:00:00Z",
          };
          created.push(record);
          return { status: 201, json: record };
        });
      }
      const booking = allBookings().find((b) => b.id === id);
      if (m === "GET" && seg.length === 3) return requireScope("bookings.read") ?? (booking ? send(200, booking) : send(404, notFound("booking")));
      if (m === "POST" && seg.length === 4 && sub === "cancellations") {
        if (requireScope("bookings.cancel")) return;
        if (!booking) return send(404, notFound("booking"));
        return write((b) => {
          if (booking.status === "canceled" || booking.status === "recall_canceled") return { status: 422, json: validation([{ code: "invalid_status", message: "The Booking cannot be canceled from its current status.", param: null }]) };
          const record = { ...booking, status: booking.status === "awaiting_recall" ? "recall_canceled" : "canceled", canceled_at: "2026-09-28T12:05:00Z", cancellation_reason: b.cancellation_reason ?? null, cancellation_source: "api", cancellation_information: b.cancellation_information ?? null, updated_at: "2026-09-28T12:05:00Z" };
          canceled.set(booking.id, record);
          return { status: 200, json: record };
        });
      }
      return send(404, notFound("route"));
    }

    if (resource === "patients" && m === "GET") {
      if (requireScope("patients.read")) return;
      if (seg.length === 2) {
        // Testing guide and spec: exact, case-insensitive filters; ids[] up to 25, unknown ids omitted.
        const eq = (a, b) => String(a ?? "").toLowerCase() === String(b ?? "").toLowerCase();
        let items = fx.patients;
        const ids = query["ids[]"] !== undefined ? [].concat(query["ids[]"]) : null;
        if (ids) {
          if (ids.length > 25) return send(400, err("invalid_request_error", "invalid_parameter", "`ids[]` accepts at most 25 identifiers.", { param: "ids" }));
          items = items.filter((p) => ids.includes(p.id));
        }
        if (q("first_name")) items = items.filter((p) => eq(p.first_name, q("first_name")));
        if (q("last_name")) items = items.filter((p) => eq(p.last_name, q("last_name")));
        if (q("date_of_birth")) {
          if (!isDate(q("date_of_birth"))) return send(400, err("invalid_request_error", "invalid_parameter", "`date_of_birth` must be YYYY-MM-DD.", { param: "date_of_birth" }));
          items = items.filter((p) => p.date_of_birth === q("date_of_birth"));
        }
        if (q("email")) items = items.filter((p) => eq(p.email, q("email")));
        if (q("phone_number")) {
          const norm = (v) => {
            const s = String(v ?? "").replace(/[\s-]/g, "");
            return s.startsWith("+") ? s : s.startsWith("00") ? "+" + s.slice(2) : s.startsWith("0") ? "+44" + s.slice(1) : s;
          };
          items = items.filter((p) => norm(p.phone_number) === norm(q("phone_number")));
        }
        return paged(items);
      }
      const p = fx.patientById[id];
      return p && seg.length === 3 ? send(200, p) : send(404, notFound("patient"));
    }

    if (resource === "invoices" && m === "GET") {
      if (requireScope("invoices.read")) return;
      if (seg.length === 2) {
        let items = fx.invoices;
        if (q("booking_id")) {
          if (!allBookings().some((b) => b.id === q("booking_id"))) return send(404, notFound("booking"));
          items = items.filter((i) => i.booking_ids.includes(q("booking_id")));
        }
        if (q("patient_id")) {
          if (!fx.patientById[q("patient_id")]) return send(404, notFound("patient"));
          items = items.filter((i) => i.patient_id === q("patient_id"));
        }
        return paged(items);
      }
      const inv = fx.invoices.find((i) => i.id === id);
      return inv && seg.length === 3 ? send(200, inv) : send(404, notFound("invoice"));
    }

    if (resource === "payments" && m === "GET" && seg.length === 2) {
      if (requireScope("payments.read")) return;
      let items = fx.payments;
      if (q("patient_id")) {
        if (!fx.patientById[q("patient_id")]) return send(404, notFound("patient"));
        items = items.filter((p) => p.patient_id === q("patient_id"));
      }
      for (const [name, cmp] of [["paid_at_from", (a, b) => a >= b], ["paid_at_to", (a, b) => a <= b]]) {
        if (q(name) === null) continue;
        if (!isDateTime(q(name))) return send(400, err("invalid_request_error", "invalid_parameter", `\`${name}\` must be a UTC ISO 8601 timestamp.`, { param: name }));
        // "Payments with a null paid_at are omitted when this filter is set."
        items = items.filter((p) => p.paid_at !== null && cmp(Date.parse(p.paid_at), Date.parse(q(name))));
      }
      return paged(items);
    }

    if (resource === "human_tasks") {
      if (m === "GET" && seg.length === 2) {
        if (requireScope("human_tasks.read")) return;
        let items = allTasks();
        if (q("patient_id")) items = items.filter((t) => t.patient_id === q("patient_id"));
        if (q("staff_member_id")) items = items.filter((t) => t.assignees.some((a) => a.assignee_id === q("staff_member_id")));
        if (q("document_id")) items = items.filter((t) => t.document_id === q("document_id"));
        if (q("is_completed") !== null) {
          if (!["true", "false"].includes(q("is_completed"))) return send(400, err("invalid_request_error", "invalid_parameter", "`is_completed` must be true or false.", { param: "is_completed" }));
          items = items.filter((t) => (t.completed_at !== null) === (q("is_completed") === "true"));
        }
        return paged(items);
      }
      if (m === "POST" && seg.length === 2) {
        if (requireScope("human_tasks.create")) return;
        return write((b) => {
          const errors = [];
          if (typeof b.content !== "string" || !b.content) errors.push({ code: "missing_parameter", message: "`content` is required.", param: "content" });
          if (!isDate(b.due_date)) errors.push({ code: "missing_parameter", message: "`due_date` is required.", param: "due_date" });
          if (errors.length) return { status: 422, json: validation(errors) };
          if (b.patient_id && !fx.patientById[b.patient_id]) return { status: 404, json: notFound("patient") };
          for (const a of b.assignees ?? []) if (a.assignee_type !== "staff_member" || ![fx.STAFF_JO, fx.STAFF_KIM].includes(a.assignee_id)) return { status: 404, json: notFound("staff member") };
          const id = fx.uuid(950 + created.length);
          const record = {
            id,
            object: "human_task",
            content: b.content,
            due_date: b.due_date,
            is_urgent: b.is_urgent === true,
            is_remindable: b.is_remindable ?? true,
            completed_at: null,
            completed_by_staff_member_id: null,
            assignees: (b.assignees ?? []).map((a) => ({ assignee_type: a.assignee_type, assignee_id: a.assignee_id })),
            patient_id: b.patient_id ?? null,
            document_id: b.document_id ?? null,
            creation_source: "api",
            links: { completed_by_staff_member: null, document: b.document_id ? `https://api.carebit.co/v1/letters/${b.document_id}` : null, patient: b.patient_id ? `https://api.carebit.co/v1/patients/${b.patient_id}` : null },
            created_at: "2026-09-28T12:00:00Z",
            updated_at: "2026-09-28T12:00:00Z",
          };
          created.push(record);
          return { status: 201, json: record };
        });
      }
      if (m === "GET" && seg.length === 3) {
        if (requireScope("human_tasks.read")) return;
        const t = allTasks().find((x) => x.id === id);
        return t ? send(200, t) : send(404, notFound("human task"));
      }
      return send(404, notFound("route"));
    }

    if (resource === "services" && m === "GET") {
      if (requireScope("services.read")) return;
      if (seg.length === 2) {
        let items = fx.services;
        if (q("is_bookable_online") !== null) items = items.filter((s) => String(s.is_bookable_online) === q("is_bookable_online"));
        return paged(items);
      }
      const s = fx.services.find((x) => x.id === id);
      return s && seg.length === 3 ? send(200, s) : send(404, notFound("service"));
    }

    if (resource === "locations" && m === "GET") {
      if (requireScope("locations.read")) return;
      if (seg.length === 2) return paged(fx.locations);
      const l = fx.locations.find((x) => x.id === id);
      return l && seg.length === 3 ? send(200, l) : send(404, notFound("location"));
    }

    return send(404, notFound("route"));
  });

  /** Queue a failure for the next `times` requests matching method+path (body as JSON; text as text/html; neither = a generic non-JSON gateway page). */
  const arm = ({ method, path, status, times = 1, headers, body, text }) => {
    failures.push({ method, path, status, times, headers, body, text });
  };
  const arm429 = ({ persistent = false, retryAfter = "1" } = {}) => {
    failures = [{ ...failure429(), times: persistent ? Infinity : 1, headers: { "Retry-After": retryAfter } }];
  };
  const disarm = () => {
    failures = [];
  };
  /** Invalidate every token issued so far: the next API call gets a 401 until a new token is fetched. */
  const revokeTokens = () => tokens.clear();
  const setTokenTtl = (seconds) => {
    tokenTtl = seconds;
  };
  const tokensIssued = () => issued;
  /** Whether this exact token value was minted by the mock at some point (revoked ones included). */
  const wasIssued = (token) => everIssued.has(token);
  const setPageCap = (n) => {
    pageCap = n;
  };
  /** The next `n` writes with a new Idempotency-Key answer 409 idempotency_conflict with Retry-After: 1. */
  const setPendingConflicts = (n) => {
    pendingConflicts = n;
  };
  /** Replay a stored write: what the mock holds for an Idempotency-Key (undefined if unknown). */
  const storedWrite = (key) => idempotency.get(key);
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port, requests, arm, arm429, disarm, revokeTokens, setTokenTtl, tokensIssued, wasIssued, setPageCap, setPendingConflicts, storedWrite })));
}
