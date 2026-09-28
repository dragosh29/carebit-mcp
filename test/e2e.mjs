// End-to-end test: fixtures are validated against the schemas in Carebit's published OpenAPI 3.1
// document, the mock's responses likewise, then the built MCP server is driven over stdio by a real
// MCP client against a local mock of the API (token endpoint included).
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as fx from "./fixtures.mjs";
import { startMock, CLIENT_ID, CLIENT_SECRET, PROJECT_SCOPES } from "./mock-server.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const started = Date.now();
let passed = 0;
const check = async (name, fn) => {
  await fn();
  passed++;
  console.log(`  ok  ${name}`);
};

// 1. Fixtures match the published spec (so the mock returns what the real API documents).
const SPEC_URL = "https://carebit.dev/openapi.json";
if (!existsSync(`${root}spec.json`)) {
  try {
    const text = await (await fetch(SPEC_URL, { headers: { Accept: "application/json" } })).text();
    JSON.parse(text); // fail here, not later, if the download was an error page
    writeFileSync(`${root}spec.json`, text);
  } catch (err) {
    console.error(`Could not download the Carebit spec (${err?.cause?.code ?? err.message}). Save it manually:\n  curl -o spec.json ${SPEC_URL}`);
    process.exit(1);
  }
}
const spec = JSON.parse(readFileSync(`${root}spec.json`, "utf8"));
assert.equal(spec.openapi, "3.1.0", "the Carebit document is OpenAPI 3.1");
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addSchema({ $id: "cb", components: spec.components });
// Inline response and request schemas refer to "#/components/..." relative to the document, so their
// refs are pointed at the "cb" schema.
const inline = (schema) => JSON.parse(JSON.stringify(schema).replaceAll('"#/components/', '"cb#/components/'));
const compiled = new Map();
const validateWith = (schema, obj, label) => {
  const key = typeof schema === "string" ? schema : JSON.stringify(schema);
  if (!compiled.has(key)) compiled.set(key, typeof schema === "string" ? ajv.getSchema(`cb#/components/schemas/${schema}`) ?? ajv.compile({ $ref: `cb#/components/schemas/${schema}` }) : ajv.compile(inline(schema)));
  const v = compiled.get(key);
  assert.ok(v(obj), `${label}: ${ajv.errorsText(v.errors)}`);
};
const validate = (name, obj, id = "") => validateWith(name, obj, `${name} ${id}`);
const responseSchema = (path, method, status = "200") => spec.paths[path][method].responses[status].content["application/json"].schema;
const requestSchema = (path, method) => spec.paths[path][method].requestBody.content["application/json"].schema;

console.log("fixtures vs OpenAPI schemas");
await check("organization, token, clinicians, locations, services, patients, bookings, agenda items, slots, invoices, payments, human tasks", async () => {
  validate("Organization", fx.organization);
  validate("Token", fx.tokenInfo(fx.uuid(1001), "2026-09-28T13:00:00Z", PROJECT_SCOPES));
  fx.clinicians.forEach((c) => validate("Clinician", c, c.id));
  fx.locations.forEach((l) => validate("Location", l, l.id));
  fx.services.forEach((s) => validate("Service", s, s.id));
  fx.patients.forEach((p) => validate("Patient", p, p.id));
  fx.bookings.forEach((b) => validate("Booking", b, b.id));
  Object.values(fx.agenda).flat().forEach((i) => validate("ClinicianAgendaItem", i, i.start_time));
  fx.slots.forEach((s) => validate("AvailabilitySlot", s, s.start_time));
  fx.invoices.forEach((i) => validate("Invoice", i, i.id));
  fx.payments.forEach((p) => validate("Payment", p, p.id));
  fx.humanTasks.forEach((t) => validate("HumanTask", t, t.id));
  // Negative control, so a schema that accepted anything would be noticed: additionalProperties is false
  // on every resource schema, and formats are enforced.
  const v = ajv.compile({ $ref: "cb#/components/schemas/Patient" });
  assert.equal(v({ ...fx.patients[0], id: "not-a-uuid" }), false, "the schema must reject a non-UUID id");
  assert.equal(v({ ...fx.patients[0], extra_field: 1 }), false, "the schema must reject an undeclared key");
  const ids = [...fx.clinicians, ...fx.locations, ...fx.services, ...fx.patients, ...fx.bookings, ...fx.invoices, ...fx.payments, ...fx.humanTasks].map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length, "every fixture id is distinct");
  // Every scope the server names in a 403 message, and every scope the mock's project holds, is one the spec defines.
  const documentedScopes = Object.keys(spec.components.securitySchemes.OAuth2.flows.clientCredentials.scopes);
  for (const s of PROJECT_SCOPES) assert.ok(documentedScopes.includes(s), `undocumented scope ${s}`);
  // The mock's credentials are obviously fake values, never the example credentials in the spec.
  const text = JSON.stringify(spec);
  for (const [name, value] of [["CLIENT_ID", CLIENT_ID], ["CLIENT_SECRET", CLIENT_SECRET]]) {
    assert.match(value, /^carebit-test-[a-z]+-not-real$/, `${name} must be an obviously fake, low-entropy value`);
    assert.ok(!text.includes(value), `${name} must not be a value printed in the spec`);
  }
});

// 2. The mock's responses (token, lists, single records, writes, errors) match the documented schemas.
const { server: mock, port, requests, arm, arm429, disarm, revokeTokens, setTokenTtl, tokensIssued, wasIssued, setPageCap, setPendingConflicts, storedWrite } = await startMock();
const base = `http://127.0.0.1:${port}`;
const rawToken = async (id = CLIENT_ID, secret = CLIENT_SECRET, scope) => {
  const form = new URLSearchParams({ grant_type: "client_credentials", client_id: id, client_secret: secret });
  if (scope) form.set("scope", scope);
  const res = await fetch(`${base}/oauth/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form.toString() });
  return { status: res.status, json: await res.json() };
};
await check("mock: token endpoint, list envelopes, records, writes with the Idempotency-Key contract, and errors all match the documented schemas", async () => {
  const bad = await rawToken(CLIENT_ID, "wrong");
  assert.equal(bad.status, 401);
  validate("Error", bad.json);
  assert.equal(bad.json.error.code, "invalid_client");
  const badScope = await rawToken(CLIENT_ID, CLIENT_SECRET, "bookings.read webhook_endpoints.read");
  assert.equal(badScope.status, 400);
  assert.equal(badScope.json.error.code, "invalid_scope", "authentication guide: a scope not on the project is 400 invalid_scope");
  const tok = await rawToken();
  assert.equal(tok.status, 200);
  validate("OAuthTokenResponse", tok.json, "POST /oauth/token");
  const token = tok.json.access_token;
  const raw = async (method, path, init = {}) => {
    const res = await fetch(base + path, { method, ...init, headers: { Authorization: `Bearer ${token}`, ...(init.body ? { "Content-Type": "application/json" } : {}), ...(init.headers ?? {}) } });
    return { status: res.status, json: await res.json(), headers: res.headers };
  };
  validate("Token", (await raw("GET", "/v1/token")).json);
  validate("Organization", (await raw("GET", "/v1/organization")).json);
  const lists = [
    ["/v1/clinicians?limit=100", "/v1/clinicians"],
    ["/v1/patients?limit=100", "/v1/patients"],
    [`/v1/bookings?start_time_from=2026-10-05T00:00:00Z&start_time_to=2026-10-09T23:59:59Z&limit=100`, "/v1/bookings"],
    ["/v1/invoices?limit=100", "/v1/invoices"],
    ["/v1/payments?limit=100", "/v1/payments"],
    ["/v1/human_tasks?limit=100", "/v1/human_tasks"],
    ["/v1/locations?limit=100", "/v1/locations"],
    [`/v1/clinician_agenda?clinician_ids[]=${fx.ADA}&start_date=2026-10-05&end_date=2026-10-09`, "/v1/clinician_agenda"],
    [`/v1/availability_slots?clinician_id=${fx.ADA}&service_variant_id=${fx.VAR_NEW_ADA}&start_date=2026-10-05&end_date=2026-10-07`, "/v1/availability_slots"],
  ];
  for (const [url, path] of lists) {
    const r = await raw("GET", url);
    assert.equal(r.status, 200, `${url}: ${JSON.stringify(r.json)}`);
    validateWith(responseSchema(path, "get"), r.json, `GET ${path} list response`);
    assert.equal(r.json.object, "list");
    assert.ok(r.json.data.length > 0, `${path} returns records`);
  }
  const limited = await raw("GET", "/v1/services"); // the mock answers the first services call with a 429
  assert.equal(limited.status, 429);
  validate("Error", limited.json);
  assert.equal(limited.json.error.type, "rate_limit_error");
  validateWith(responseSchema("/v1/services", "get"), (await raw("GET", "/v1/services")).json, "GET /v1/services list response");
  // Pagination guide: limit above 100 is a 422; cursor walks to has_more false / next_cursor null.
  assert.equal((await raw("GET", "/v1/clinicians?limit=101")).status, 422);
  const page1 = (await raw("GET", "/v1/clinicians?limit=100")).json;
  assert.deepEqual([page1.data.length, page1.has_more, typeof page1.next_cursor], [4, true, "string"]);
  const page2 = (await raw("GET", `/v1/clinicians?limit=100&cursor=${encodeURIComponent(page1.next_cursor)}`)).json;
  assert.deepEqual([page2.data.length, page2.has_more, page2.next_cursor], [2, false, null]);
  validate("Clinician", (await raw("GET", `/v1/clinicians/${fx.ADA}`)).json);
  validate("Booking", (await raw("GET", `/v1/bookings/${fx.B_SAM_MON}`)).json);
  validate("Patient", (await raw("GET", `/v1/patients/${fx.SAM}`)).json);
  validate("Invoice", (await raw("GET", `/v1/invoices/${fx.INV_SAM}`)).json);
  validate("AvailabilitySlot", (await raw("GET", `/v1/next_availability_slot?clinician_id=${fx.ADA}&service_variant_id=${fx.VAR_NEW_ADA}&from_date=2026-10-06`)).json);
  const noSlot = await raw("GET", `/v1/next_availability_slot?clinician_id=${fx.ADA}&service_variant_id=${fx.VAR_NEW_ADA}&from_date=2027-06-01`);
  assert.equal(noSlot.status, 404);
  validate("Error", noSlot.json);
  const missing = await raw("GET", `/v1/patients/${fx.uuid(999999)}`);
  assert.equal(missing.status, 404);
  validate("Error", missing.json);
  const noWindow = await raw("GET", "/v1/bookings");
  assert.equal(noWindow.status, 400);
  validate("Error", noWindow.json);
  assert.equal((await raw("GET", "/v1/bookings?status=awaiting_recall")).json.data.length, 1, "recall statuses list without a window");
  // Idempotency guide header contract on writes.
  const taskBody = JSON.stringify({ content: "Mock check", due_date: "2026-10-10" });
  const noKey = await raw("POST", "/v1/human_tasks", { body: taskBody });
  assert.equal(noKey.status, 400);
  assert.equal(noKey.json.error.code, "idempotency_key_required");
  const key = "mock-check-key-1";
  const first = await raw("POST", "/v1/human_tasks", { body: taskBody, headers: { "Idempotency-Key": key } });
  assert.equal(first.status, 201);
  validate("HumanTask", first.json);
  const replay = await raw("POST", "/v1/human_tasks", { body: taskBody, headers: { "Idempotency-Key": key } });
  assert.deepEqual([replay.status, replay.headers.get("idempotency-replayed"), replay.json], [201, "true", first.json], "same key + same body replays the stored response");
  const reused = await raw("POST", "/v1/human_tasks", { body: JSON.stringify({ content: "Different", due_date: "2026-10-10" }), headers: { "Idempotency-Key": key } });
  assert.equal(reused.status, 422);
  assert.equal(reused.json.error.code, "idempotency_key_reused");
  const invalid = await raw("POST", "/v1/human_tasks", { body: JSON.stringify({ content: "" }), headers: { "Idempotency-Key": "mock-check-key-2" } });
  assert.equal(invalid.status, 422);
  validate("Error", invalid.json);
  assert.equal(invalid.json.error.errors.length, 2, "validation-errors guide: every offending field is listed");
  const bookingBody = JSON.stringify({ patient_id: fx.SAM, service_id: fx.SVC_FOLLOW, service_variant_id: fx.VAR_FOLLOW, start_time: "2026-10-12T09:00:00Z" });
  const booked = await raw("POST", "/v1/bookings", { body: bookingBody, headers: { "Idempotency-Key": "mock-check-key-3" } });
  assert.equal(booked.status, 201);
  validate("Booking", booked.json);
  const cancelled = await raw("POST", `/v1/bookings/${booked.json.id}/cancellations`, { body: JSON.stringify({ cancellation_reason: "booked_in_error" }), headers: { "Idempotency-Key": "mock-check-key-4" } });
  assert.equal(cancelled.status, 200);
  validate("Booking", cancelled.json);
  assert.deepEqual([cancelled.json.status, cancelled.json.cancellation_source], ["canceled", "api"]);
  const again = await raw("POST", `/v1/bookings/${booked.json.id}/cancellations`, { body: "{}", headers: { "Idempotency-Key": "mock-check-key-5" } });
  assert.equal(again.status, 422, "a canceled booking cannot be canceled again");
  // A token without a scope gets the documented 403.
  const narrow = (await rawToken(CLIENT_ID, CLIENT_SECRET, "clinicians.read")).json.access_token;
  const forbidden = await fetch(`${base}/v1/organization`, { headers: { Authorization: `Bearer ${narrow}` } });
  assert.equal(forbidden.status, 403);
  validate("Error", await forbidden.json());
});
requests.length = 0; // only count what the MCP server does from here on
arm429();

// 3. Drive the server through MCP. `writes` is the literal CAREBIT_ALLOW_WRITES value; null leaves it unset.
const connect = async ({ id = CLIENT_ID, secret = CLIENT_SECRET, writes = "true", scope } = {}) => {
  const client = new Client({ name: "e2e", version: "1.0.0" });
  const env = { ...process.env, CAREBIT_CLIENT_ID: id, CAREBIT_CLIENT_SECRET: secret, CAREBIT_BASE_URL: base };
  delete env.CAREBIT_ALLOW_WRITES;
  delete env.CAREBIT_SCOPE;
  if (writes !== null) env.CAREBIT_ALLOW_WRITES = writes;
  if (scope !== undefined) env.CAREBIT_SCOPE = scope;
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [`${root}dist/index.js`], env, stderr: "ignore" }));
  return client;
};
const call = async (client, name, args = {}) => {
  const res = await client.callTool({ name, arguments: args });
  return { res, data: res.isError ? undefined : JSON.parse(res.content[0].text), text: res.content[0].text };
};
const since = (n) => requests.slice(n);
const READ_TOOLS = ["find_availability", "get_booking", "get_clinician", "get_clinician_agenda", "get_invoice", "get_organization", "get_patient", "list_bookings", "list_clinicians", "list_human_tasks", "list_invoices", "list_locations", "list_payments", "list_services", "search_patients"];
const WRITE_TOOLS = ["cancel_booking", "create_booking", "create_human_task"];

const client = await connect();
console.log("mcp tools");

await check("tools/list exposes 18 tools; reads are read-only, cancel_booking destructive, the creates not", async () => {
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), [...READ_TOOLS, ...WRITE_TOOLS].sort());
  for (const t of tools) {
    assert.equal(t.annotations?.readOnlyHint, READ_TOOLS.includes(t.name), `${t.name} readOnlyHint`);
    if (WRITE_TOOLS.includes(t.name)) assert.equal(t.annotations?.destructiveHint, t.name === "cancel_booking", `${t.name} destructiveHint`);
  }
});

await check("get_organization fetches a token with the documented form body first, then uses it as a Bearer on /v1/organization and /v1/token", async () => {
  const n = requests.length;
  const { data } = await call(client, "get_organization");
  const tokenReq = since(n).find((r) => r.path === "/oauth/token");
  assert.ok(tokenReq, "a token request was made");
  assert.match(tokenReq.contentType, /^application\/x-www-form-urlencoded/);
  assert.deepEqual(tokenReq.body, { grant_type: "client_credentials", client_id: CLIENT_ID, client_secret: CLIENT_SECRET }, "no scope is sent unless CAREBIT_SCOPE is set");
  assert.equal(tokenReq.auth, undefined, "no Authorization header on the token request");
  assert.deepEqual(since(n).map((r) => r.path).sort(), ["/oauth/token", "/v1/organization", "/v1/token"]);
  assert.equal(data.organization.name, "Example Private Clinic");
  assert.equal(data.organization.email, "reception@example.invalid", "the Organization's own contact details are returned as stored");
  assert.deepEqual(data.token.scopes, [...PROJECT_SCOPES].sort());
  assert.equal(data.token.project.name, "MCP prototype");
  assert.equal(tokensIssued(), 3, "one token for the MCP server so far (two were minted by the mock check)");
});

await check("list_clinicians pages by cursor with limit 100 until has_more is false; emails only on request", async () => {
  const n = requests.length;
  const { data } = await call(client, "list_clinicians");
  const pages = since(n).filter((r) => r.path === "/v1/clinicians");
  assert.equal(pages.length, 2, "two pages of four then two");
  assert.deepEqual(pages.map((r) => r.query.limit), ["100", "96"], "each page asks for min(100, records still wanted)");
  assert.equal(pages[0].query.cursor, undefined);
  assert.ok(pages[1].query.cursor, "the second page sends next_cursor as cursor");
  assert.deepEqual([data.count, data.complete, data.next_cursor], [6, true, undefined]);
  assert.equal(data.clinicians[0].display_name, "Dr Ada Example");
  assert.equal(data.clinicians[0].email, undefined);
  assert.equal(data.clinicians[1].medical_specialty, "Orthopaedic surgery (queries to [email redacted] or [phone redacted])", "an email and phone typed into a specialty are redacted");
  assert.ok(!JSON.stringify(data).includes("@example.invalid"));
  const capped = await call(client, "list_clinicians", { max_results: 4 });
  assert.deepEqual([capped.data.count, capped.data.complete], [4, false]);
  assert.match(capped.data.note, /cursor "/);
  const rest = await call(client, "list_clinicians", { max_results: 4, cursor: capped.data.next_cursor, include_contact_details: true });
  assert.deepEqual(rest.data.clinicians.map((c) => c.display_name), ["Dr Eve Fixture", "Finn Placeholder"]);
  assert.equal(rest.data.clinicians[0].email, "eve.fixture@example.invalid");
  assert.equal(requests.at(-1).query.cursor, capped.data.next_cursor, "the continuation sends the cursor exactly as returned");
  const one = await call(client, "get_clinician", { clinician_id: fx.BEN });
  assert.equal(one.data.clinician.display_name, "Mr Ben Sample");
  assert.equal(one.data.clinician.email, undefined);
});

await check("get_clinician_agenda sends clinician_ids[], start_date and end_date; items come in time order with patient contact details withheld; a 46-day range is refused locally", async () => {
  const n = requests.length;
  const { data } = await call(client, "get_clinician_agenda", { clinician_id: fx.ADA, start_date: "2026-10-05", end_date: "2026-10-05" });
  const req = requests.at(-1);
  assert.deepEqual(req.query, { "clinician_ids[]": fx.ADA, start_date: "2026-10-05", end_date: "2026-10-05" });
  assert.deepEqual(data.items.map((i) => [i.type, i.start_time.slice(11, 16)]), [["availability", "09:00"], ["booking", "09:00"], ["booking", "10:00"], ["booking", "11:00"], ["unavailability", "13:00"], ["availability", "14:00"]]);
  const b = data.items[1].booking;
  assert.equal(b.patient.display_name, "Mr Sam Evans", "patient names are returned");
  assert.equal(b.patient.date_of_birth, undefined);
  assert.equal(b.patient.nhs_number, undefined);
  assert.equal(b.patient.email, undefined);
  assert.equal(b.information_for_staff_members, undefined, "clinical free text is withheld by default");
  assert.equal(b.has_information_for_staff_members, true);
  assert.equal(b.payor.formatted_payor_name, "Example Health Insurance");
  assert.equal(b.payor.insurance_policy_number, undefined);
  const text = JSON.stringify(data);
  for (const leak of ["9434765919", "943 476 5919", "sam.evans@", "CF64 3DH", "1984-03-12", "POL-0001-000123", "07700"]) assert.ok(!text.includes(leak), `${leak} leaked in the default output`);
  assert.equal(since(n).length, 1, "one request, no pagination parameters (none are documented)");
  const before = requests.length;
  const tooLong = await call(client, "get_clinician_agenda", { clinician_id: fx.ADA, start_date: "2026-10-01", end_date: "2026-11-15" });
  assert.ok(tooLong.res.isError);
  assert.match(tooLong.text, /46 days; the API allows at most 45 days/);
  assert.equal(requests.length, before, "refused before any request");
});

await check("find_availability lists slots in a range or fetches the next slot, with the documented parameters; no slot within 8 months gives a clear message", async () => {
  const range = await call(client, "find_availability", { clinician_id: fx.ADA, service_variant_id: fx.VAR_NEW_ADA, start_date: "2026-10-05", end_date: "2026-10-06" });
  assert.equal(requests.at(-1).path, "/v1/availability_slots");
  assert.deepEqual(requests.at(-1).query, { clinician_id: fx.ADA, service_variant_id: fx.VAR_NEW_ADA, start_date: "2026-10-05", end_date: "2026-10-06" });
  assert.equal(range.data.mode, "slots_in_range");
  assert.deepEqual(range.data.slots.map((s) => s.start_time), fx.slots.slice(0, 5).map((s) => s.start_time));
  const next = await call(client, "find_availability", { clinician_id: fx.ADA, service_variant_id: fx.VAR_NEW_ADA, start_date: "2026-10-06" });
  assert.equal(requests.at(-1).path, "/v1/next_availability_slot");
  assert.deepEqual(requests.at(-1).query, { clinician_id: fx.ADA, service_variant_id: fx.VAR_NEW_ADA, from_date: "2026-10-06" });
  assert.deepEqual([next.data.mode, next.data.slot.start_time], ["next_slot", "2026-10-06T10:00:00Z"]);
  const today = await call(client, "find_availability", { clinician_id: fx.ADA, service_variant_id: fx.VAR_NEW_ADA });
  assert.equal(requests.at(-1).query.from_date, undefined, "from_date is omitted when no start_date is given (the API defaults to today)");
  assert.equal(today.data.from_date, "today");
  const none = await call(client, "find_availability", { clinician_id: fx.ADA, service_variant_id: fx.VAR_NEW_ADA, start_date: "2027-06-01" });
  assert.ok(none.res.isError);
  assert.match(none.text, /No slot found: the API answered 404.*no slot was available within 8 months/);
});

await check("list_bookings passes every documented filter through exactly, converts bare dates, and refuses windows the API documents as invalid before any request", async () => {
  const n = requests.length;
  const week = await call(client, "list_bookings", { start_time_from: "2026-10-05", start_time_to: "2026-10-09" });
  const pages = since(n).filter((r) => r.path === "/v1/bookings");
  assert.equal(pages.length, 3, "ten diary bookings in pages of four");
  assert.deepEqual(pages[0].query, { start_time_from: "2026-10-05T00:00:00Z", start_time_to: "2026-10-09T23:59:59Z", limit: "100" }, "bare dates become the start and end of the UTC day");
  assert.equal(pages[1].query.start_time_from, "2026-10-05T00:00:00Z", "the original filters are sent on every page, as the guide requires");
  assert.ok(pages[2].query.cursor);
  assert.equal(week.data.count, 10);
  assert.deepEqual(week.data.bookings.slice(0, 3).map((b) => [b.status, b.patient.display_name]), [["confirmed", "Mr Sam Evans"], ["unconfirmed", "Ms Priya Shah"], ["confirmed", "Ms Priya Shah"]]);
  const filtered = await call(client, "list_bookings", { start_time_from: "2026-10-05T00:00:00Z", start_time_to: "2026-10-09T23:59:59Z", clinician_id: fx.ADA, status: "confirmed", updated_since: "2026-10-01T00:00:00Z" });
  assert.deepEqual(requests.at(-1).query, { start_time_from: "2026-10-05T00:00:00Z", start_time_to: "2026-10-09T23:59:59Z", clinician_id: fx.ADA, status: "confirmed", updated_since: "2026-10-01T00:00:00Z", limit: "100" });
  assert.deepEqual(filtered.data.bookings.map((b) => b.id), [fx.uuid(208), fx.uuid(205)]);
  const byPatient = await call(client, "list_bookings", { start_time_from: "2026-08-01", start_time_to: "2026-10-11", patient_id: fx.SAM });
  assert.equal(requests.at(-1).query.patient_id, fx.SAM);
  assert.deepEqual(byPatient.data.bookings.map((b) => b.id), [fx.B_SAM_MON, fx.B_SAM_CANCELED], "a 71-day window is allowed with patient_id");
  const recall = await call(client, "list_bookings", { status: "awaiting_recall" });
  assert.deepEqual(requests.at(-1).query, { status: "awaiting_recall", limit: "100" }, "recall statuses go without a window");
  assert.deepEqual([recall.data.bookings[0].id, recall.data.bookings[0].start_time, recall.data.bookings[0].recall_due_date], [fx.B_RECALL, undefined, "2026-12-01"]);
  const before = requests.length;
  for (const [args, re] of [
    [{}, /Give both start_time_from and start_time_to/],
    [{ start_time_from: "2026-10-01", start_time_to: "2026-11-05" }, /spans 36 days; the API allows at most 30 days \(90 with patient_id\)\. Split it into shorter windows\./],
    [{ start_time_from: "2026-10-01", start_time_to: "2026-10-31" }, /spans 31 days; the API allows at most 30 days \(90 with patient_id\)\. A bare end date counts as the end of that day \(23:59:59Z\); use start_time_from 2026-10-01T00:00:00Z with start_time_to 2026-10-30T23:59:59Z, then 2026-10-31 to 2026-10-31\./],
    [{ start_time_from: "2026-07-01", start_time_to: "2026-09-29", patient_id: fx.SAM }, /spans 91 days; the API allows at most 90 days with patient_id\. A bare end date counts as the end of that day \(23:59:59Z\); use start_time_from 2026-07-01T00:00:00Z with start_time_to 2026-09-28T23:59:59Z, then 2026-09-29 to 2026-09-29\./],
    [{ start_time_from: "2026-07-01", start_time_to: "2026-10-05", patient_id: fx.SAM }, /at most 90 days with patient_id/],
    [{ status: "awaiting_recall", start_time_from: "2026-10-01", start_time_to: "2026-10-05" }, /Omit start_time_from and start_time_to with status awaiting_recall/],
    [{ status: "did_not_attend" }, /including did_not_attend/],
    [{ start_time_from: "2026-10-05T09:00:00+01:00", start_time_to: "2026-10-06" }, /not a UTC time/],
  ]) {
    const bad = await call(client, "list_bookings", args);
    assert.ok(bad.res.isError, `${JSON.stringify(args)} should be refused`);
    assert.match(bad.text, re);
  }
  assert.equal(requests.length, before, "invalid windows are refused before any request");
  const thirty = await call(client, "list_bookings", { start_time_from: "2026-10-01", start_time_to: "2026-10-30" });
  assert.ok(!thirty.res.isError, "thirty calendar days as bare dates are accepted");
  const exact = await call(client, "list_bookings", { start_time_from: "2026-10-01T00:00:00Z", start_time_to: "2026-10-31T00:00:00Z" });
  assert.ok(!exact.res.isError, "an exact 30-day span is accepted");
});

await check("get_booking withholds contact details, the NHS number, policy numbers and free-text information by default and returns them on request", async () => {
  const { data } = await call(client, "get_booking", { booking_id: fx.B_SAM_CANCELED });
  const b = data.booking;
  assert.deepEqual([b.status, b.cancellation_reason, b.cancellation_source], ["canceled", "rescheduled", "staff_member"]);
  assert.equal(b.cancellation_information, "Patient rang from [phone redacted] ([email redacted]) to move it.");
  assert.equal(b.patient.display_name, "Mr Sam Evans");
  assert.equal(b.patient.patient_number, "PAT-1001", "the Organization's own patient number is returned");
  for (const k of ["email", "phone_number", "mobile", "date_of_birth", "nhs_number", "address_line_1", "postcode", "internal_patient_id", "patient_portal_add_payment_method_url"]) assert.equal(b.patient[k], undefined, `patient.${k} should be withheld`);
  const full = await call(client, "get_booking", { booking_id: fx.B_SAM_MON, include_contact_details: true });
  const f = full.data.booking;
  assert.equal(f.patient.email, "sam.evans@example.invalid");
  assert.equal(f.patient.nhs_number, "9434765919");
  assert.equal(f.patient.date_of_birth, "1984-03-12");
  assert.equal(f.patient.postcode, "CF64 3DH");
  assert.equal(f.information_for_staff_members, fx.bookingById[fx.B_SAM_MON].information_for_staff_members, "free text is returned as stored on request");
  assert.equal(f.payor.insurance_policy_number, "POL-0001-000123");
  assert.equal(f.payor.notes, "Excess £100; ring 0800 555 0199 to pre-authorise.");
  assert.equal(f.patient.internal_patient_id, "EXT-9001");
  assert.equal(f.patient.patient_portal_add_payment_method_url, fx.patientById[fx.SAM].patient_portal_add_payment_method_url);
  const c = await call(client, "get_booking", { booking_id: fx.B_SAM_CANCELED, include_contact_details: true });
  assert.equal(c.data.booking.cancellation_information, "Patient rang from 07700 900123 (sam.evans@example.invalid) to move it.");
  const selfPay = await call(client, "get_booking", { booking_id: fx.B_PRIYA_MON });
  assert.deepEqual(selfPay.data.booking.payor, { id: fx.uuid(112), payor_type: "patient", formatted_payor_name: "Ms Priya Shah" }, "a self-paying payor's address and person fields are withheld by default");
});

await check("search_patients sends the documented exact-match filters (first_name, last_name, date_of_birth, email, phone_number, ids[]) and pages; get_patient hides details by default", async () => {
  const n = requests.length;
  const all = await call(client, "search_patients");
  assert.equal(since(n).filter((r) => r.path === "/v1/patients").length, 3, "nine patients in pages of four");
  assert.equal(all.data.count, 9);
  const byName = await call(client, "search_patients", { first_name: "example api", last_name: "PATIENT", date_of_birth: "1970-01-01" });
  assert.deepEqual(requests.at(-1).query, { first_name: "example api", last_name: "PATIENT", date_of_birth: "1970-01-01", limit: "100" });
  assert.deepEqual(byName.data.patients.map((p) => p.id), [fx.EXAMPLE_API], "the testing guide's example patient lookup");
  const byEmail = await call(client, "search_patients", { email: "priya.shah@example.invalid" });
  assert.equal(requests.at(-1).query.email, "priya.shah@example.invalid");
  assert.deepEqual(byEmail.data.patients.map((p) => p.display_name), ["Ms Priya Shah"]);
  assert.equal(byEmail.data.patients[0].email, undefined, "the matched email is not echoed by default");
  const byPhone = await call(client, "search_patients", { phone_number: "07700 900123", include_contact_details: true });
  assert.equal(requests.at(-1).query.phone_number, "07700 900123", "sent exactly as given");
  assert.deepEqual(byPhone.data.patients.map((p) => [p.id, p.phone_number]), [[fx.SAM, "+447700900123"]]);
  const byIds = await call(client, "search_patients", { ids: [fx.SAM, fx.PRIYA, fx.uuid(999999)] });
  assert.deepEqual(requests.at(-1).query["ids[]"], [fx.SAM, fx.PRIYA, fx.uuid(999999)], "ids[] is repeated");
  assert.deepEqual(byIds.data.patients.map((p) => p.id), [fx.SAM, fx.PRIYA], "unknown ids are omitted, as documented");
  const one = await call(client, "get_patient", { patient_id: fx.PRIYA });
  assert.deepEqual([one.data.patient.display_name, one.data.patient.sex, one.data.patient.date_of_birth, one.data.patient.nhs_number], ["Ms Priya Shah", "female", undefined, undefined]);
  assert.ok(!JSON.stringify(one.data).includes("BS1 4DJ"));
});

await check("list_invoices and get_invoice: filters, minor-unit amounts, line items, notes redacted, payment link only on request", async () => {
  const { data } = await call(client, "list_invoices");
  assert.equal(data.count, 5);
  const overdue = data.invoices.find((i) => i.status === "overdue");
  assert.deepEqual([overdue.invoice_number, overdue.total, overdue.total_outstanding, overdue.total_paid, overdue.amounts_in], ["INV-1002", 15000, 15000, 0, "minor currency units (pence for gbp)"]);
  assert.equal(overdue.invoice_notes, "<p>Queries to [email redacted] or [phone redacted].</p>");
  assert.equal(overdue.payment_url, undefined);
  assert.equal(overdue.line_items[0].title, "Follow-up consultation");
  const bySam = await call(client, "list_invoices", { patient_id: fx.SAM, booking_id: fx.B_SAM_MON });
  assert.deepEqual(requests.at(-1).query, { booking_id: fx.B_SAM_MON, patient_id: fx.SAM, limit: "100" });
  assert.deepEqual(bySam.data.invoices.map((i) => i.invoice_number), ["INV-1001"]);
  const one = await call(client, "get_invoice", { invoice_id: fx.INV_PRIYA_OVERDUE, include_contact_details: true });
  assert.equal(one.data.invoice.payment_url, `https://example-clinic.carebit.co/portal/invoices/${fx.INV_PRIYA_OVERDUE}/pay`);
  assert.equal(one.data.invoice.invoice_notes, "<p>Queries to accounts@example.invalid or 020 7946 0000.</p>");
});

await check("list_payments passes patient_id and the paid_at window through; refunds are shown; the stored card id never appears", async () => {
  const { data } = await call(client, "list_payments");
  assert.equal(data.count, 4);
  const sam = data.payments.find((p) => p.id === fx.PAY_SAM);
  assert.deepEqual([sam.status, sam.amount, sam.payment_method_type, sam.payor_type, sam.refunds.length, sam.refunds[0].amount, sam.refunds[0].status], ["partially_refunded", 25000, "card", "insurance_company", 1, 5000, "succeeded"]);
  assert.equal(sam.internal_notes, "Card ending 4242 charged by reception (query [phone redacted]).", "a last-four fragment cannot be told from an ordinary number and stays");
  assert.ok(!JSON.stringify(data).includes(fx.STORED_CARD), "payment_method_id must never be returned");
  const windowed = await call(client, "list_payments", { paid_at_from: "2026-10-01", paid_at_to: "2026-10-31", patient_id: fx.PRIYA });
  assert.deepEqual(requests.at(-1).query, { patient_id: fx.PRIYA, paid_at_from: "2026-10-01T00:00:00Z", paid_at_to: "2026-10-31T23:59:59Z", limit: "100" });
  assert.equal(windowed.data.count, 0, "a payment with no paid_at is omitted when the window is set");
  const october = await call(client, "list_payments", { paid_at_from: "2026-10-01T00:00:00Z", paid_at_to: "2026-10-31T23:59:59Z" });
  assert.deepEqual(october.data.payments.map((p) => p.paid_at), ["2026-10-05T12:00:00Z", "2026-10-08T15:00:00Z"]);
});

await check("list_human_tasks passes patient_id, staff_member_id, document_id and is_completed through; content is redacted by default", async () => {
  const open = await call(client, "list_human_tasks", { is_completed: false });
  assert.deepEqual(requests.at(-1).query, { is_completed: "false", limit: "100" });
  assert.deepEqual(open.data.tasks.map((t) => t.is_completed), [false, false, false, false], "three fixture tasks plus the one the mock check created");
  const byId = (id) => open.data.tasks.find((t) => t.id === id);
  assert.equal(byId(fx.uuid(801)).content, "Chase insurer authorisation for Sam Evans (ring [phone redacted], quote POL-0001-000123).", "a phone number is redacted, a hyphenated reference is not");
  assert.equal(byId(fx.uuid(803)).content, "Send INV-1002 reminder to [email redacted].");
  assert.equal(byId(fx.uuid(802)).content, "Review the referral letter before Monday's clinic (NHS [number redacted], patient now at [postcode redacted]).", "an NHS-shaped 10-digit group and a UK postcode in free text are redacted");
  const forJo = await call(client, "list_human_tasks", { staff_member_id: fx.STAFF_JO, patient_id: fx.PRIYA, document_id: fx.DOC_LETTER });
  assert.deepEqual(requests.at(-1).query, { patient_id: fx.PRIYA, staff_member_id: fx.STAFF_JO, document_id: fx.DOC_LETTER, limit: "100" });
  assert.equal(forJo.data.count, 0);
  const raw = await call(client, "list_human_tasks", { patient_id: fx.PRIYA, include_contact_details: true });
  assert.equal(raw.data.tasks[0].content, "Send INV-1002 reminder to priya.shah@example.invalid.");
});

await check("list_services (after a 429 retry that waits for Retry-After) and list_locations", async () => {
  const n = requests.length;
  const { data } = await call(client, "list_services");
  const tries = since(n).filter((r) => r.path === "/v1/services");
  assert.equal(tries.length, 2, "services should be retried once after 429");
  const gap = tries[1].t - tries[0].t;
  assert.ok(gap >= 1000 && gap < 1900, `retry should wait the Retry-After of 1 s, not the 2 s fallback (waited ${gap} ms)`);
  assert.deepEqual(data.services.map((s) => [s.name, s.duration_minutes, s.is_bookable_online, s.service_variants.length]), [["New patient consultation", 30, true, 2], ["Follow-up consultation", 15, false, 1]]);
  assert.deepEqual(data.services[0].service_variants[0], { id: fx.VAR_NEW_ADA, description: "With Dr Ada Example, London", net_price: 25000, currency: "gbp", clinician_id: fx.ADA, location_id: fx.LOC_LONDON, permits_remote_bookings: false });
  assert.deepEqual(data.services[1].tax_rate, { id: fx.uuid(71), title: "20% VAT", percentage: 20 });
  const online = await call(client, "list_services", { is_bookable_online: true });
  assert.equal(requests.at(-1).query.is_bookable_online, "true");
  assert.equal(online.data.count, 1);
  const locs = await call(client, "list_locations");
  assert.deepEqual(locs.data.locations.map((l) => [l.name, l.postcode]), [["London Clinic", "W1A 1AA"], ["Bristol Clinic", "BS1 4DJ"]], "the Organization's own premises are returned as stored");
});

await check("service names, variant descriptions and invoice line-item titles are redacted by default and returned as stored with include_contact_details", async () => {
  const service = { ...fx.services[0], name: "Clinic line 020 7946 0958", description: "Book via desk@example.invalid", service_variants: [{ ...fx.services[0].service_variants[0], description: "Ring 07700 900123" }] };
  validate("Service", service, "injected");
  const page = { object: "list", url: "https://api.carebit.co/v1/services", data: [service], has_more: false, next_cursor: null };
  arm({ method: "GET", path: "/v1/services", status: 200, body: page });
  const plain = await call(client, "list_services");
  assert.deepEqual([plain.data.services[0].name, plain.data.services[0].description, plain.data.services[0].service_variants[0].description], ["Clinic line [phone redacted]", "Book via [email redacted]", "Ring [phone redacted]"]);
  arm({ method: "GET", path: "/v1/services", status: 200, body: page });
  const raw = await call(client, "list_services", { include_contact_details: true });
  assert.deepEqual([raw.data.services[0].name, raw.data.services[0].description, raw.data.services[0].service_variants[0].description], ["Clinic line 020 7946 0958", "Book via desk@example.invalid", "Ring 07700 900123"]);
  const invoice = { ...fx.invoices[0], line_items: [{ ...fx.invoices[0].line_items[0], title: "Consultation, query 07700 900123 or billing@example.invalid" }] };
  validate("Invoice", invoice, "injected");
  arm({ method: "GET", path: `/v1/invoices/${invoice.id}`, status: 200, body: invoice });
  const inv = await call(client, "get_invoice", { invoice_id: invoice.id });
  assert.equal(inv.data.invoice.line_items[0].title, "Consultation, query [phone redacted] or [email redacted]");
  arm({ method: "GET", path: `/v1/invoices/${invoice.id}`, status: 200, body: invoice });
  const invRaw = await call(client, "get_invoice", { invoice_id: invoice.id, include_contact_details: true });
  assert.equal(invRaw.data.invoice.line_items[0].title, "Consultation, query 07700 900123 or billing@example.invalid");
  const booking = { ...fx.bookingById[fx.B_SAM_MON], service: { ...fx.bookingById[fx.B_SAM_MON].service, name: "Follow-up (ring 020 7946 0958)" } };
  validate("Booking", booking, "injected");
  arm({ method: "GET", path: `/v1/bookings/${booking.id}`, status: 200, body: booking });
  const b = await call(client, "get_booking", { booking_id: booking.id });
  assert.equal(b.data.booking.service.name, "Follow-up (ring [phone redacted])");
  arm({ method: "GET", path: `/v1/bookings/${booking.id}`, status: 200, body: booking });
  const bRaw = await call(client, "get_booking", { booking_id: booking.id, include_contact_details: true });
  assert.equal(bRaw.data.booking.service.name, "Follow-up (ring 020 7946 0958)");
  disarm();
});

await check("a Luhn-valid card number typed into free text is never returned, with or without include_contact_details; a list page claiming more results without a cursor is reported as incomplete", async () => {
  const task = { ...fx.humanTasks[0], content: "Take the balance from card 4242 4242 4242 4242 (Amex 3782 822463 10005 declined); ref 1234 5678 9012 3456 is not a card." };
  validate("HumanTask", task, "injected");
  const page = { object: "list", url: "https://api.carebit.co/v1/human_tasks", data: [task], has_more: false, next_cursor: null };
  for (const include of [false, true]) {
    arm({ method: "GET", path: "/v1/human_tasks", status: 200, body: page });
    const { data } = await call(client, "list_human_tasks", { include_contact_details: include });
    assert.equal(data.tasks[0].content, "Take the balance from card [card number redacted] (Amex [card number redacted] declined); ref 1234 5678 9012 3456 is not a card.", `include_contact_details=${include}`);
    assert.ok(!JSON.stringify(data).includes("4242 4242"), "no card number in the output");
  }
  const booking = { ...fx.bookingById[fx.B_SAM_MON], information_for_staff_members: "Card on file 4242424242424242, patient rang from 07700 900123.", payor: { ...fx.bookingById[fx.B_SAM_MON].payor, notes: "Pay with 5555 5555 5555 4444 if the insurer declines." } };
  validate("Booking", booking, "injected");
  arm({ method: "GET", path: `/v1/bookings/${booking.id}`, status: 200, body: booking });
  const full = await call(client, "get_booking", { booking_id: booking.id, include_contact_details: true });
  assert.equal(full.data.booking.information_for_staff_members, "Card on file [card number redacted], patient rang from 07700 900123.", "the booking's free text on request: card redacted, phone as stored");
  assert.equal(full.data.booking.payor.notes, "Pay with [card number redacted] if the insurer declines.");
  // A page with has_more true and no next_cursor (the guide says the two always agree) is not
  // reported as the whole collection.
  arm({ method: "GET", path: "/v1/locations", status: 200, body: { object: "list", url: "https://api.carebit.co/v1/locations", data: [fx.locations[0]], has_more: true, next_cursor: null } });
  const cut = await call(client, "list_locations");
  assert.ok(!cut.res.isError, cut.text);
  assert.deepEqual([cut.data.count, cut.data.complete, cut.data.next_cursor], [1, false, undefined]);
  assert.match(cut.data.note, /reported more results \(has_more\) for \/v1\/locations but returned no next_cursor/);
  disarm();
});

const humanTaskSchema = requestSchema("/v1/human_tasks", "post");
const bookingSchema = requestSchema("/v1/bookings", "post");
const cancellationSchema = requestSchema("/v1/bookings/{booking_id}/cancellations", "post");

await check("create_human_task posts a body that validates against the documented request schema, with a UUID Idempotency-Key", async () => {
  const { data } = await call(client, "create_human_task", { content: "Call the lab about Sam's results", due_date: "2026-10-07", is_urgent: true, patient_id: fx.SAM, assignee_staff_member_ids: [fx.STAFF_JO, fx.STAFF_KIM] });
  const post = requests.at(-1);
  assert.deepEqual([post.method, post.path], ["POST", "/v1/human_tasks"]);
  validateWith(humanTaskSchema, post.body, "POST /v1/human_tasks body vs request schema");
  assert.deepEqual(post.body, { content: "Call the lab about Sam's results", due_date: "2026-10-07", is_urgent: true, patient_id: fx.SAM, assignees: [{ assignee_type: "staff_member", assignee_id: fx.STAFF_JO }, { assignee_type: "staff_member", assignee_id: fx.STAFF_KIM }] });
  assert.match(post.idempotencyKey, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, "a version-4 UUID per operation");
  assert.deepEqual([data.result, data.task.content, data.task.is_completed, data.task.creation_source, data.task.assignees.length], ["created", "Call the lab about Sam's results", false, "api", 2]);
  const second = await call(client, "create_human_task", { content: "Another", due_date: "2026-10-08" });
  assert.notEqual(requests.at(-1).idempotencyKey, post.idempotencyKey, "a fresh key per call");
  assert.equal(second.data.task.is_urgent, false);
  const card = await call(client, "create_human_task", { content: "Refund to card 4242 4242 4242 4242 (ending 4242).", due_date: "2026-10-08" });
  assert.equal(card.data.task.content, "Refund to card [card number redacted] (ending 4242).", "the echoed record goes through the redaction");
  const listed = await call(client, "list_human_tasks", { is_completed: false });
  assert.equal(listed.data.count, 7, "four open tasks plus the three just created");
});

await check("create_booking posts a body that validates against the documented diary-booking schema and never emails the patient unless asked", async () => {
  const { data } = await call(client, "create_booking", { patient_id: fx.PRIYA, service_id: fx.SVC_FOLLOW, service_variant_id: fx.VAR_FOLLOW, start_time: "2026-10-12T09:00:00Z", clinician_id: fx.ADA, location_id: fx.LOC_LONDON, status: "confirmed" });
  const post = requests.at(-1);
  assert.deepEqual([post.method, post.path], ["POST", "/v1/bookings"]);
  validateWith(bookingSchema, post.body, "POST /v1/bookings body vs request schema (allOf + oneOf)");
  assert.deepEqual(post.body, { patient_id: fx.PRIYA, service_id: fx.SVC_FOLLOW, service_variant_id: fx.VAR_FOLLOW, start_time: "2026-10-12T09:00:00Z", notify_patient: false, clinician_id: fx.ADA, location_id: fx.LOC_LONDON, status: "confirmed" });
  assert.deepEqual([data.result, data.booking.status, data.booking.start_time, data.booking.end_time, data.booking.notify_patient, data.booking.patient.display_name], ["created", "confirmed", "2026-10-12T09:00:00Z", "2026-10-12T09:15:00Z", false, "Ms Priya Shah"]);
  const before = requests.length;
  const backwards = await call(client, "create_booking", { patient_id: fx.PRIYA, service_id: fx.SVC_FOLLOW, service_variant_id: fx.VAR_FOLLOW, start_time: "2026-10-12T09:00:00Z", end_time: "2026-10-12T08:00:00Z" });
  assert.ok(backwards.res.isError);
  assert.match(backwards.text, /end_time .* is not after start_time/);
  assert.equal(requests.length, before, "refused locally");
  const unknownPatient = await call(client, "create_booking", { patient_id: fx.uuid(999999), service_id: fx.SVC_FOLLOW, service_variant_id: fx.VAR_FOLLOW, start_time: "2026-10-12T10:00:00Z" });
  assert.ok(unknownPatient.res.isError);
  assert.match(unknownPatient.text, /Not found: \/v1\/bookings\. Check the ID/);
});

await check("cancel_booking posts to /cancellations with a documented reason; a booking that cannot be canceled passes on the API's 422 message", async () => {
  const created = await call(client, "list_bookings", { start_time_from: "2026-10-12", start_time_to: "2026-10-12", patient_id: fx.PRIYA });
  const id = created.data.bookings[0].id;
  const { data } = await call(client, "cancel_booking", { booking_id: id, cancellation_reason: "booked_in_error", cancellation_information: "Created during a test." });
  const post = requests.at(-1);
  assert.deepEqual([post.method, post.path], ["POST", `/v1/bookings/${id}/cancellations`]);
  validateWith(cancellationSchema, post.body, "POST .../cancellations body vs request schema");
  assert.deepEqual(post.body, { cancellation_reason: "booked_in_error", cancellation_information: "Created during a test." });
  assert.deepEqual([data.result, data.booking.status, data.booking.cancellation_source, data.booking.cancellation_reason], ["canceled", "canceled", "api", "booked_in_error"]);
  const again = await call(client, "cancel_booking", { booking_id: id });
  assert.ok(again.res.isError);
  assert.match(again.text, /\(422 validation error\)\. The Booking cannot be canceled from its current status\. \(invalid_status\)/);
  assert.equal(requests.at(-1).body !== undefined && Object.keys(requests.at(-1).body).length, 0, "an empty body is sent when no reason or note is given");
});

await check("a 409 idempotency_conflict is retried after Retry-After with the same Idempotency-Key", async () => {
  setPendingConflicts(1);
  const n = requests.length;
  const { data, res } = await call(client, "create_human_task", { content: "Conflict retry", due_date: "2026-10-09" });
  assert.ok(!res.isError, res.content[0].text);
  const posts = since(n).filter((r) => r.method === "POST");
  assert.equal(posts.length, 2, "one retry after the 409");
  assert.equal(posts[0].idempotencyKey, posts[1].idempotencyKey, "the same key on the retry, as the guide requires");
  const gap = posts[1].t - posts[0].t;
  assert.ok(gap >= 1000 && gap < 1900, `retry should wait the Retry-After of 1 s (waited ${gap} ms)`);
  assert.equal(data.result, "created");
  assert.ok(storedWrite(posts[1].idempotencyKey), "the mock stored the write under that key");
});

await check("a 429 on a write is retried with the same Idempotency-Key, and so is the retry after a 401 token refresh", async () => {
  arm({ method: "POST", path: "/v1/human_tasks", status: 429, headers: { "Retry-After": "0" }, body: { error: { type: "rate_limit_error", code: "too_many_requests", message: "Too many requests. Please slow down." } } });
  const n = requests.length;
  const limited = await call(client, "create_human_task", { content: "Rate-limited write", due_date: "2026-10-09" });
  assert.ok(!limited.res.isError, limited.text);
  const posts = since(n).filter((r) => r.method === "POST");
  assert.equal(posts.length, 2, "one retry after the 429");
  assert.equal(posts[0].idempotencyKey, posts[1].idempotencyKey, "the same key on the 429 retry, as the rate-limits guide requires");
  assert.equal(limited.data.result, "created");
  disarm();
  revokeTokens();
  const m = requests.length;
  const refreshed = await call(client, "create_human_task", { content: "Write after refresh", due_date: "2026-10-09" });
  assert.ok(!refreshed.res.isError, refreshed.text);
  assert.deepEqual(since(m).map((r) => `${r.method} ${r.path}`), ["POST /v1/human_tasks", "POST /oauth/token", "POST /v1/human_tasks"], "401, a new token, then the write again");
  const again = since(m).filter((r) => r.path === "/v1/human_tasks");
  assert.equal(again[0].idempotencyKey, again[1].idempotencyKey, "the same key after the token refresh");
  assert.equal(refreshed.data.result, "created");
});

await check("a persistent 429 gives up after 3 attempts; Carebit's documented Retry-After of 60 makes the call give up at once, naming the wait and the request id", async () => {
  arm429({ persistent: true, retryAfter: "0" });
  const n = requests.length;
  const { res, text } = await call(client, "list_services");
  assert.ok(res.isError);
  assert.equal(since(n).filter((r) => r.path === "/v1/services").length, 3, "exactly three attempts");
  assert.match(text, /Carebit rate limit reached \(429\): 120 requests and 30 writes per minute per access token/);
  arm429({ retryAfter: "60" }); // the rate-limits guide: "When any limit is hit the API returns 429 with Retry-After: 60"
  const m = requests.length;
  const capped = await call(client, "list_services");
  assert.ok(capped.res.isError);
  assert.equal(since(m).filter((r) => r.path === "/v1/services").length, 1, "no retry when the server asks for a wait longer than the cap");
  assert.match(capped.text, /asked to wait 60 seconds before retrying GET \/v1\/services \(HTTP 429\)\. Try again after that\. \(request id [0-9a-f-]{36}\)/);
  disarm();
});

await check("an HTTP-date Retry-After is honoured", async () => {
  // HTTP-dates have 1 s resolution, so aim at a whole second 4 to 5 s ahead: after the first request's
  // round trip the wait is 3.5 to 5 s, clearly apart from both "retry at once" and the 2 s fallback.
  arm429({ retryAfter: new Date(Math.ceil((Date.now() + 4000) / 1000) * 1000).toUTCString() });
  const n = requests.length;
  const { res } = await call(client, "list_services");
  assert.ok(!res.isError);
  const tries = since(n).filter((r) => r.path === "/v1/services");
  assert.equal(tries.length, 2);
  const gap = tries[1].t - tries[0].t;
  assert.ok(gap >= 3000 && gap < 5600, `retry should wait until the given date (3.5 to 5 s), not retry at once or use the 2 s fallback (waited ${gap} ms)`);
  disarm();
});

await check("a fractional Retry-After is read as seconds, not as a date; a missing Retry-After falls back to 2 s", async () => {
  arm429({ retryAfter: "1.5" }); // Date.parse("1.5") is a date in 2001, which would mean "retry now"
  const n = requests.length;
  const { res } = await call(client, "list_services");
  assert.ok(!res.isError);
  const tries = since(n).filter((r) => r.path === "/v1/services");
  assert.equal(tries.length, 2);
  const gap = tries[1].t - tries[0].t;
  assert.ok(gap >= 1400 && gap < 1900, `retry should wait 1.5 s (waited ${gap} ms)`);
  disarm();
  arm({ method: "GET", path: "/v1/services", status: 429, body: { error: { type: "rate_limit_error", code: "too_many_requests", message: "Too many requests. Please slow down." } } });
  const m = requests.length;
  const fallback = await call(client, "list_services");
  assert.ok(!fallback.res.isError);
  const again = since(m).filter((r) => r.path === "/v1/services");
  assert.equal(again.length, 2);
  const gap2 = again[1].t - again[0].t;
  assert.ok(gap2 >= 2000 && gap2 < 2900, `retry should wait the 2 s fallback (waited ${gap2} ms)`);
  disarm();
});

await check("a GET that keeps failing with 503 gives up after three attempts with advice and without the gateway's HTML; a 502 on a GET is retried; a 502 on a write is never retried", async () => {
  arm({ method: "GET", path: "/v1/locations", status: 503, times: 3, headers: { "Retry-After": "0" } });
  const n = requests.length;
  const failed = await call(client, "list_locations");
  assert.ok(failed.res.isError);
  assert.equal(since(n).filter((r) => r.path === "/v1/locations").length, 3);
  assert.match(failed.text, /Carebit returned 503 for GET \/v1\/locations 3 times in a row\. The service may be unavailable; try again in a few minutes\./);
  assert.ok(!failed.text.includes("<html>"), "gateway HTML should not be passed on");
  assert.ok(!failed.text.includes("request id"), "a gateway page without the header gives no request id");
  disarm();
  arm({ method: "GET", path: "/v1/locations", status: 503, times: 3, headers: { "Retry-After": "0" }, body: { error: { type: "api_error", code: "service_unavailable", message: "Service temporarily unavailable; contact ops@example.invalid." } } });
  const withId = await call(client, "list_locations");
  assert.ok(withId.res.isError);
  assert.match(withId.text, /returned 503 for GET \/v1\/locations 3 times in a row\. The service may be unavailable; try again in a few minutes\. Service temporarily unavailable; contact \[email redacted\]\. \(service_unavailable\) \(request id [0-9a-f-]{36}\)/);
  disarm();
  arm({ method: "GET", path: "/v1/locations", status: 502, headers: { "Retry-After": "0" } });
  const m = requests.length;
  const recovered = await call(client, "list_locations");
  assert.ok(!recovered.res.isError, recovered.text);
  assert.equal(since(m).filter((r) => r.path === "/v1/locations").length, 2);
  disarm();
  arm({ method: "POST", path: "/v1/human_tasks", status: 502, headers: { "Retry-After": "0" } });
  const k = requests.length;
  const write = await call(client, "create_human_task", { content: "Gateway", due_date: "2026-10-09" });
  assert.ok(write.res.isError, "a 502 on a write must surface as an error, not a success");
  assert.equal(since(k).filter((r) => r.method === "POST").length, 1, "exactly one POST");
  assert.match(write.text, /returned 502 for POST \/v1\/human_tasks\. The request was not retried because it may already have been processed/);
  disarm();
});

await check("a 200 whose body is not JSON is an error, not an empty list; body excerpts are redacted before they are cut", async () => {
  arm({ method: "GET", path: "/v1/locations", status: 200 }); // the mock answers with an HTML page
  const { res, text } = await call(client, "list_locations");
  assert.ok(res.isError, `a non-JSON 200 must not be reported as success: ${text}`);
  assert.match(text, /returned 200 for GET \/v1\/locations but the body was not JSON \(starts with: "<html>.*Check CAREBIT_BASE_URL/);
  disarm();
  // An email address that straddles the 60-character cut of the excerpt must not leak in part.
  const page = "<html><body>Please contact reception.desk.london@examplehospital.invalid or ring 020 7946 0958</body></html>";
  arm({ method: "GET", path: "/v1/locations", status: 200, text: page });
  const straddle = await call(client, "list_locations");
  assert.ok(straddle.res.isError);
  assert.match(straddle.text, /starts with: "<html><body>Please contact \[email redacted\] or ring \[phone r"/);
  assert.ok(!straddle.text.includes("examplehosp") && !straddle.text.includes("7946"), "nothing of the address or number survives the cut");
  disarm();
  // The same for a non-JSON error body, cut at 300 characters.
  arm({ method: "GET", path: "/v1/locations", status: 400, text: "x".repeat(290) + " reception.desk.london@examplehospital.invalid 020 7946 0958" });
  const long = await call(client, "list_locations");
  assert.ok(long.res.isError);
  assert.match(long.text, /rejected GET \/v1\/locations \(400\)\. x{290} \[email re$/);
  assert.ok(!long.text.includes("examplehosp") && !long.text.includes("7946"));
  disarm();
});

await check("token-endpoint errors carry the request id, never the client secret even when Carebit echoes it, and a non-JSON 200 from it is cut after redaction", async () => {
  revokeTokens();
  arm({ method: "POST", path: "/oauth/token", status: 400, body: { error: { type: "invalid_request_error", code: "invalid_request", message: `The secret ${CLIENT_SECRET} is not valid for client ${CLIENT_ID}; email support.desk@example.invalid.` } } });
  const echoed = await call(client, "list_locations");
  assert.ok(echoed.res.isError);
  assert.match(echoed.text, /rejected the client credentials at .*\/oauth\/token \(400\)\. Check CAREBIT_CLIENT_ID and CAREBIT_CLIENT_SECRET.* The secret \[redacted\] is not valid for client carebit-test-client-not-real; email \[email redacted\]\. \(invalid_request\) \(request id [0-9a-f-]{36}\)/);
  assert.ok(!echoed.text.includes(CLIENT_SECRET), "the secret must be scrubbed from an echoed message");
  disarm();
  arm({ method: "POST", path: "/oauth/token", status: 403, body: { error: { type: "permission_error", code: "project_disabled", message: "The developer project is disabled." } } });
  const disabled = await call(client, "list_locations");
  assert.ok(disabled.res.isError);
  assert.match(disabled.text, /refused to issue a token \(403\).* The developer project is disabled\. \(project_disabled\) \(request id [0-9a-f-]{36}\)/);
  disarm();
  arm({ method: "POST", path: "/oauth/token", status: 200, text: "<html><body>Please contact reception.desk.london@examplehospital.invalid or ring 020 7946 0958</body></html>" });
  const html = await call(client, "list_locations");
  assert.ok(html.res.isError);
  assert.match(html.text, /with 200 but no access_token \(a non-JSON body starting with "<html><body>Please contact \[email redacted\] or ring \[phone r"\)\. Check CAREBIT_BASE_URL\./);
  assert.ok(!html.text.includes("examplehosp"));
  disarm();
  const recovered = await call(client, "list_locations");
  assert.ok(!recovered.res.isError, "a fresh token is fetched on the next call");
});

await check("a revoked token is refreshed once and the call retried; a token near expiry is refreshed before it expires; a short-lived token is still reused", async () => {
  const issuedBefore = tokensIssued();
  revokeTokens();
  const n = requests.length;
  const { data, res } = await call(client, "list_locations");
  assert.ok(!res.isError, res.content[0].text);
  assert.equal(data.count, 2);
  const [first, , third] = since(n);
  assert.deepEqual(since(n).map((r) => r.path), ["/v1/locations", "/oauth/token", "/v1/locations"], "401, then a new token, then the call again");
  assert.ok(wasIssued(first.auth.slice(7)) && wasIssued(third.auth.slice(7)) && first.auth !== third.auth, "the revoked token was one the mock issued, and the retry carries the new one");
  assert.equal(tokensIssued(), issuedBefore + 1);
  // A token that lives 2 s is refreshed after half its lifetime, i.e. after about a second.
  setTokenTtl(2);
  revokeTokens();
  await call(client, "list_locations"); // fetches the short-lived token
  const issuedShort = tokensIssued();
  await new Promise((r) => setTimeout(r, 1500));
  const m = requests.length;
  const later = await call(client, "list_locations");
  assert.ok(!later.res.isError);
  assert.deepEqual(since(m).map((r) => r.path), ["/oauth/token", "/v1/locations"], "the token is refreshed before the call, with no 401 in between");
  assert.equal(tokensIssued(), issuedShort + 1);
  // A token that lives 60 s (the refresh margin) is kept for 30 s, not fetched before every call:
  // /oauth/token allows 10 requests per minute per client_id.
  setTokenTtl(60);
  revokeTokens();
  await call(client, "list_locations");
  const issuedMinute = tokensIssued();
  const k = requests.length;
  await call(client, "list_locations");
  await call(client, "list_locations");
  assert.deepEqual(since(k).map((r) => r.path), ["/v1/locations", "/v1/locations"], "no token request between calls");
  assert.equal(tokensIssued(), issuedMinute);
  setTokenTtl(3600);
});

await check("bad IDs and dates are rejected before any API call; unknown IDs give a clear 404 with the request id; a missing scope gives a 403 naming the scope", async () => {
  const before = requests.length;
  for (const [tool, args] of [
    ["get_clinician", { clinician_id: "not-a-uuid" }],
    ["get_booking", { booking_id: "../bookings" }],
    ["get_patient", { patient_id: "11111111-1111-4111-8111-00000000008" }],
    ["get_invoice", { invoice_id: "" }],
    ["get_clinician_agenda", { clinician_id: fx.ADA, start_date: "2026-13-01", end_date: "2026-10-05" }],
    ["find_availability", { clinician_id: fx.ADA, service_variant_id: fx.VAR_NEW_ADA, start_date: "05/10/2026" }],
    ["search_patients", { ids: [fx.SAM, "abc"] }],
    ["search_patients", { date_of_birth: "1984-02-30" }],
    ["create_human_task", { content: "x", due_date: "tomorrow" }],
    ["cancel_booking", { booking_id: fx.B_SAM_MON, cancellation_reason: "changed_my_mind" }],
  ]) {
    const bad = await client.callTool({ name: tool, arguments: args });
    assert.ok(bad.isError, `${tool} should reject ${JSON.stringify(args)}`);
  }
  assert.equal(requests.length, before, "no request for invalid input");
  const missing = await call(client, "get_patient", { patient_id: fx.uuid(999999) });
  assert.ok(missing.res.isError);
  assert.match(missing.text, /Not found: \/v1\/patients\/11111111-1111-4111-8111-000000999999\. Check the ID; the resource does not exist or is outside this Organization\. No such patient.*\(request id [0-9a-f-]{36}\)/);
  const narrow = await connect({ scope: "clinicians.read" });
  const tokenReq = requests.length;
  const forbidden = await call(narrow, "get_organization", { include_token_info: false });
  assert.equal(since(tokenReq)[0].body.scope, "clinicians.read", "CAREBIT_SCOPE is sent as the token request's scope");
  assert.ok(forbidden.res.isError);
  assert.match(forbidden.text, /refused GET \/v1\/organization \(403\)\. This endpoint requires the `organization\.read` scope: add it to the developer project/);
  const okNarrow = await call(narrow, "list_clinicians", { max_results: 4 });
  assert.equal(okNarrow.data.count, 4);
  await narrow.close();
});

await check("every request carried the documented form body to /oauth/token or a Bearer token the mock issued, hit a documented method+path, and every write carried an Idempotency-Key", async () => {
  const templates = Object.entries(spec.paths).flatMap(([p, ops]) => Object.keys(ops).filter((m) => m !== "parameters").map((m) => ({ m: m.toUpperCase(), re: new RegExp("^" + p.replace(/\{[^}]+\}/g, "[^/]+") + "$") })));
  assert.ok(requests.length > 60, `expected a busy suite, got ${requests.length} requests`);
  for (const r of requests) {
    if (r.path === "/oauth/token") {
      assert.equal(r.method, "POST");
      assert.equal(r.auth, undefined, "no Authorization header on the token request");
      assert.equal(r.body.grant_type, "client_credentials");
      assert.equal(r.body.client_id, CLIENT_ID);
      continue;
    }
    assert.match(r.auth ?? "", /^Bearer /, `${r.method} ${r.path} must carry a Bearer token`);
    assert.ok(wasIssued(r.auth.slice(7)), `${r.method} ${r.path} must carry a token the mock issued, not one of the same shape`);
    assert.ok(templates.some((t) => t.m === r.method && t.re.test(r.path)), `undocumented call ${r.method} ${r.path}`);
    if (r.method !== "GET") assert.ok(r.idempotencyKey, `${r.method} ${r.path} must carry an Idempotency-Key`);
    assert.ok(!Object.values(r.query).flat().some((v) => String(v).includes(CLIENT_SECRET)), "the client secret never travels in a query string");
  }
  const used = new Set(requests.map((r) => `${r.method} ${r.path.replace(/\/[0-9a-f-]{36}(?=\/|$)/g, "/{id}")}`));
  assert.deepEqual(
    [...used].sort(),
    ["GET /v1/availability_slots", "GET /v1/bookings", "GET /v1/bookings/{id}", "GET /v1/clinician_agenda", "GET /v1/clinicians", "GET /v1/clinicians/{id}", "GET /v1/human_tasks", "GET /v1/invoices", "GET /v1/invoices/{id}", "GET /v1/locations", "GET /v1/next_availability_slot", "GET /v1/organization", "GET /v1/patients", "GET /v1/patients/{id}", "GET /v1/payments", "GET /v1/services", "GET /v1/token", "POST /oauth/token", "POST /v1/bookings", "POST /v1/bookings/{id}/cancellations", "POST /v1/human_tasks"],
  );
  // Nothing this server never reads: stored cards, payors, notes, letters, test results, reports.
  for (const never of ["/payment_methods", "/payors", "/notes", "/letters", "/test_results", "/reports", "/patients/", "/oauth/revoke"]) {
    assert.ok(!requests.some((r) => r.path.includes(never) && !(never === "/patients/" && /^\/v1\/patients\/[0-9a-f-]{36}$/.test(r.path))), `${never} must never be called`);
  }
});
await client.close();

await check("writes are off when CAREBIT_ALLOW_WRITES is unset, and when it is 'false'", async () => {
  for (const value of [null, "false"]) {
    const ro = await connect({ writes: value });
    const { tools } = await ro.listTools();
    assert.deepEqual(tools.filter((t) => WRITE_TOOLS.includes(t.name)), [], `writes exposed with CAREBIT_ALLOW_WRITES ${value === null ? "unset" : `= "${value}"`}`);
    assert.equal(tools.length, READ_TOOLS.length);
    await ro.close();
  }
});

await check("wrong client credentials give an actionable error that names the variables and never echoes the secret", async () => {
  const bad = await connect({ secret: "carebit-test-wrong-secret-not-real" });
  const { res, text } = await call(bad, "list_clinicians");
  assert.ok(res.isError);
  assert.match(text, /rejected the client credentials at .*\/oauth\/token \(401\)\. Check CAREBIT_CLIENT_ID and CAREBIT_CLIENT_SECRET/);
  assert.ok(!text.includes("wrong-secret"), "the secret must not be echoed");
  await bad.close();
});

mock.close();
console.log(`\n${passed} checks passed, ${requests.length} API calls made against the mock, ${((Date.now() - started) / 1000).toFixed(1)} s.`);
