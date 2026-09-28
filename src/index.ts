#!/usr/bin/env node
// Carebit MCP server: lets Claude, ChatGPT and other MCP clients work with a Carebit private-practice Organization.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { CarebitClient, CarebitError } from "./client.js";
import * as fmt from "./format.js";

const clientId = process.env.CAREBIT_CLIENT_ID?.trim();
const clientSecret = process.env.CAREBIT_CLIENT_SECRET?.trim();
if (!clientId || !clientSecret) {
  console.error("CAREBIT_CLIENT_ID and CAREBIT_CLIENT_SECRET must both be set. In Carebit, go to Settings > Developer platform, create a project with the scopes you need and create an API credential for it.");
  process.exit(1);
}
const scope = process.env.CAREBIT_SCOPE?.trim() || undefined;
if (scope !== undefined && !/^[a-z_]+\.[a-z_]+( [a-z_]+\.[a-z_]+)*$/.test(scope)) {
  console.error(`CAREBIT_SCOPE must be a space-separated list of scopes such as "bookings.read clinicians.read" (got "${scope}").`);
  process.exit(1);
}
const allowWrites = /^(1|true|yes)$/i.test(process.env.CAREBIT_ALLOW_WRITES ?? "");
const baseUrl = process.env.CAREBIT_BASE_URL?.trim() || undefined;
const api = new CarebitClient(clientId, clientSecret, baseUrl, scope);

const server = new McpServer(
  { name: "carebit", version: "0.1.0" },
  {
    instructions: [
      "Tools for a Carebit private-practice Organization (clinicians, diaries, availability, bookings, patients, invoices, payments, staff tasks, services, locations).",
      "Every resource is identified by a UUID. Times are ISO 8601 in UTC with a Z suffix; dates are YYYY-MM-DD. Money is in minor currency units (pence for gbp).",
      "Booking statuses: unconfirmed, confirmed, prepared, arrived, did_not_attend, canceled, awaiting_payment, and the recall statuses awaiting_recall, overdue_for_recall, recall_expired, recall_canceled (recall bookings have no start_time).",
      "Typical flow for 'what does Dr X have on today?': list_clinicians to find the clinician id, then get_clinician_agenda for the date.",
      "Typical flow for 'when is the next free slot for a follow-up with Dr X?': list_services for the service_variant_id, then find_availability.",
      "Typical flow for 'which invoices are unpaid?': list_invoices and read status and total_outstanding.",
      "Patient contact details, dates of birth, NHS numbers, addresses, insurance policy numbers, clinician emails and the free-text information on a booking are only returned when explicitly requested with include_contact_details.",
    ].join("\n"),
  },
);

const READ = { readOnlyHint: true, openWorldHint: true } as const;

// Every identifier in the spec is "an RFC 4122 version 4 UUID" (format: uuid).
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuid = (what: string) => z.string().regex(UUID, `${what} IDs are UUIDs such as 11111111-1111-4111-8111-000000000001`);

const isRealDate = (y: number, m: number, d: number) => {
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
};
// Dates are documented as ISO 8601 YYYY-MM-DD.
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const isoDate = z.string().transform((v, ctx) => {
  const m = DATE.exec(v.trim());
  if (!m || !isRealDate(Number(m[1]), Number(m[2]), Number(m[3]))) {
    ctx.addIssue({ code: "custom", message: `"${v}" is not a date; give YYYY-MM-DD (for example 2026-10-05)` });
    return z.NEVER;
  }
  return m[0];
});
// Time filters are documented as "UTC ISO 8601 format (YYYY-MM-DDTHH:MM:SSZ)". A bare date is accepted
// too and becomes the start (or, for an upper bound, the end) of that UTC day. Offsets such as +01:00
// are refused because the API documents Z only.
const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?Z)?$/;
const utcDateTime = (endOfDay: boolean) =>
  z.string().transform((v, ctx) => {
    const m = DATE_TIME.exec(v.trim());
    const bad = !m || !isRealDate(Number(m[1]), Number(m[2]), Number(m[3])) || (m[4] !== undefined && (Number(m[4]) > 23 || Number(m[5]) > 59 || Number(m[6] ?? 0) > 59));
    if (bad) {
      ctx.addIssue({ code: "custom", message: `"${v}" is not a UTC time; give YYYY-MM-DDTHH:MM:SSZ (for example 2026-10-05T09:00:00Z) or a date YYYY-MM-DD` });
      return z.NEVER;
    }
    if (m[4] === undefined) return `${m[1]}-${m[2]}-${m[3]}T${endOfDay ? "23:59:59" : "00:00:00"}Z`;
    return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] ?? "00"}Z`;
  });
const DAY_MS = 86_400_000;
const inclusiveDays = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / DAY_MS) + 1;

const BOOKING_STATUSES = ["arrived", "awaiting_payment", "awaiting_recall", "canceled", "confirmed", "did_not_attend", "overdue_for_recall", "prepared", "recall_canceled", "recall_expired", "unconfirmed"] as const;
const RECALL_STATUSES = new Set(["awaiting_recall", "overdue_for_recall", "recall_expired", "recall_canceled"]);
const CANCELLATION_REASONS = [
  "abusive_behavior", "booked_in_error", "childcare_issues", "clinician_annual_leave", "clinician_emergency", "clinician_schedule_change", "colleague_unavailable", "double_booked", "duplicate_booking",
  "equipment_issue", "facility_unavailable", "failed_to_pay_in_advance", "family_emergency_illness", "fear_or_anxiety", "financial_concerns", "financial_requirements_not_met", "forgot_to_attend",
  "insurance_company_not_permitted", "insurance_coverage_issues", "insurance_verification_failed", "language_barrier", "medication_interference", "no_longer_required", "no_response_to_recall", "other",
  "patient_deceased", "patient_not_permitted", "personal_emergency_illness", "pre_booking_steps_not_completed", "professional_discretion", "quote_declined", "referral_not_provided", "relocated", "rescheduled",
  "scheduling_conflict", "staff_issue", "switched_to_another_clinician", "symptoms_resolved", "too_unwell", "transportation_issues", "unable_failed_to_prepare_for_booking", "unknown", "weather_conditions",
  "wrong_clinician", "wrong_location", "wrong_service_type",
] as const;

type Json = Record<string, unknown> | unknown[];
const ok = (data: Json) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });
const fail = (err: unknown) => ({
  isError: true,
  content: [{ type: "text" as const, text: err instanceof CarebitError ? err.message : `Unexpected error: ${(err as Error)?.message ?? String(err)}` }],
});
const safe = <A>(fn: (args: A) => Promise<Json>) => async (args: A) => {
  try {
    return ok(await fn(args));
  } catch (err) {
    return fail(err);
  }
};
const includeContact = (what: string) => z.boolean().default(false).describe(`Include ${what}, and stop redacting email addresses, phone numbers, NHS-number-shaped digit groups and UK postcodes typed into names and other text`);
const maxResults = (n = 100) => z.number().int().min(1).max(1000).default(n).describe("Maximum number of records to return (pages of up to 100 are fetched until this is reached)");
const cursorArg = z.string().min(1).max(2000).optional().describe("next_cursor from a previous call, to continue where it stopped (send the same filters)");
const pageNote = (r: { complete: boolean; next_cursor?: string; note?: string }) => (r.complete ? undefined : r.note ?? `More results exist; call again with cursor "${r.next_cursor}" and the same filters to continue.`);

server.registerTool(
  "get_organization",
  {
    title: "Get the Organization",
    description: "The Organization this credential belongs to (name, type, contact details, address, currency, time zone) and, by default, the access token's granted scopes and developer project, so you know which other tools will work.",
    inputSchema: { include_token_info: z.boolean().default(true).describe("Also call GET /v1/token for the granted scopes and project") },
    annotations: READ,
  },
  safe(async ({ include_token_info }) => {
    const [org, tok] = await Promise.all([api.get("/v1/organization", undefined, "organization.read"), include_token_info ? api.get("/v1/token") : Promise.resolve(undefined)]);
    return { organization: fmt.organization(org ?? {}), ...(tok ? { token: fmt.token(tok) } : {}) };
  }),
);

server.registerTool(
  "list_clinicians",
  {
    title: "List clinicians",
    description: "The Organization's clinicians with display name, title, specialty and id (the id other tools take). Practice email addresses only with include_contact_details.",
    inputSchema: { max_results: maxResults(), cursor: cursorArg, include_contact_details: includeContact("clinician practice email addresses") },
    annotations: READ,
  },
  safe(async ({ max_results, cursor, include_contact_details }) => {
    const r = await api.list("/v1/clinicians", { maxItems: max_results, maxPages: 20, cursor, scope: "clinicians.read" });
    return { count: r.items.length, complete: r.complete, next_cursor: r.next_cursor, note: pageNote(r), clinicians: r.items.map((c) => fmt.clinician(c, include_contact_details)) };
  }),
);

server.registerTool(
  "get_clinician",
  {
    title: "Get a clinician",
    description: "One clinician by id.",
    inputSchema: { clinician_id: uuid("Clinician"), include_contact_details: includeContact("the clinician's practice email address") },
    annotations: READ,
  },
  safe(async ({ clinician_id, include_contact_details }) => ({ clinician: fmt.clinician(await api.get(`/v1/clinicians/${clinician_id}`, undefined, "clinicians.read"), include_contact_details) })),
);

server.registerTool(
  "get_clinician_agenda",
  {
    title: "Get a clinician's diary",
    description:
      "A clinician's diary for a date range (at most 45 days inclusive, as the API documents): bookings, availability intervals and unavailability intervals in time order, each with start and end time, location and services. Bookings carry the patient's name; the patient's contact details, date of birth, NHS number and address, and the booking's free-text information, only with include_contact_details. Availability shows the schedule, not bookable times: use find_availability for those.",
    inputSchema: {
      clinician_id: uuid("Clinician"),
      start_date: isoDate.describe("First date to include, YYYY-MM-DD"),
      end_date: isoDate.describe("Last date to include, YYYY-MM-DD (inclusive; at most 45 days after start_date)"),
      include_contact_details: includeContact("patient contact details, date of birth, NHS number, address, payor details and the booking's information fields"),
    },
    annotations: READ,
  },
  safe(async ({ clinician_id, start_date, end_date, include_contact_details }) => {
    const days = inclusiveDays(start_date, end_date);
    if (days < 1) throw new CarebitError(`end_date (${end_date}) is before start_date (${start_date}).`);
    if (days > 45) throw new CarebitError(`The range ${start_date} to ${end_date} is ${days} days; the API allows at most 45 days inclusive. Split it into shorter ranges.`);
    // The endpoint documents no limit or cursor parameters, only the list envelope; one request is made.
    const res = await api.get(`/v1/clinician_agenda`, { "clinician_ids[]": [clinician_id], start_date, end_date }, "clinician_agenda.read");
    const items = Array.isArray(res?.data) ? res.data : [];
    return {
      clinician_id,
      start_date,
      end_date,
      count: items.length,
      note: res?.has_more === true ? "The API reported more items (has_more) but documents no cursor parameter for this endpoint; narrow the date range." : undefined,
      items: items.map((i: any) => fmt.agendaItem(i, include_contact_details)),
    };
  }),
);

server.registerTool(
  "find_availability",
  {
    title: "Find bookable slots",
    description:
      "Times a clinician can be booked for a service variant (list_services gives service_variant_id). With start_date and end_date (at most 45 days inclusive) it lists every slot in the range (GET /v1/availability_slots); without end_date it returns the next slot on or after start_date (today when omitted), searching up to 8 months ahead (GET /v1/next_availability_slot). Results account for existing bookings, unavailability, service duration, buffers and rooms, include services patients cannot book online, and ignore the Patient Portal's minimum notice.",
    inputSchema: {
      clinician_id: uuid("Clinician"),
      service_variant_id: uuid("Service variant"),
      start_date: isoDate.optional().describe("First date to search, YYYY-MM-DD (defaults to today for the next-slot search)"),
      end_date: isoDate.optional().describe("Last date to include, YYYY-MM-DD; when given, every slot in the range is listed"),
    },
    annotations: READ,
  },
  safe(async ({ clinician_id, service_variant_id, start_date, end_date }) => {
    if (end_date !== undefined) {
      if (start_date === undefined) throw new CarebitError("Give start_date together with end_date to list slots in a range.");
      const days = inclusiveDays(start_date, end_date);
      if (days < 1) throw new CarebitError(`end_date (${end_date}) is before start_date (${start_date}).`);
      if (days > 45) throw new CarebitError(`The range ${start_date} to ${end_date} is ${days} days; the API allows at most 45 days inclusive.`);
      const res = await api.get("/v1/availability_slots", { clinician_id, service_variant_id, start_date, end_date }, "availability_slots.read");
      const items = Array.isArray(res?.data) ? res.data : [];
      return { mode: "slots_in_range", start_date, end_date, count: items.length, note: res?.has_more === true ? "The API reported more slots (has_more) but documents no cursor parameter for this endpoint; narrow the date range." : undefined, slots: items.map(fmt.slot) };
    }
    try {
      const s = await api.get("/v1/next_availability_slot", { clinician_id, service_variant_id, from_date: start_date }, "availability_slots.read");
      return { mode: "next_slot", from_date: start_date ?? "today", slot: fmt.slot(s ?? {}) };
    } catch (err) {
      if (err instanceof CarebitError && err.status === 404) throw new CarebitError(`No slot found: the API answered 404, which it documents as "the Clinician or ServiceVariant was not found, or no slot was available within 8 months". Check both ids with list_clinicians and list_services. ${err.message}`, 404, err.code);
      throw err;
    }
  }),
);

server.registerTool(
  "list_bookings",
  {
    title: "List bookings",
    description:
      "Bookings in the Organization. Diary queries need start_time_from and start_time_to (UTC; a bare date is taken as the whole day), a range of at most 30 days, or 90 days with patient_id, ordered by start_time. For the recall statuses awaiting_recall, overdue_for_recall, recall_expired and recall_canceled omit the time window (those bookings have no start_time; results are ordered by recall_due_date); did_not_attend still needs it. Filters are ANDed and sent as documented: clinician_id, patient_id, status, updated_since. Patient names are returned; their contact details and the booking's free-text information only with include_contact_details.",
    inputSchema: {
      start_time_from: utcDateTime(false).optional().describe("Inclusive lower bound for start_time, YYYY-MM-DDTHH:MM:SSZ or YYYY-MM-DD"),
      start_time_to: utcDateTime(true).optional().describe("Inclusive upper bound for start_time, YYYY-MM-DDTHH:MM:SSZ or YYYY-MM-DD (a bare date means the end of that day, 23:59:59Z, so a 31-day calendar month given as bare dates is 31 days and must be split)"),
      clinician_id: uuid("Clinician").optional(),
      patient_id: uuid("Patient").optional().describe("Only this patient's bookings (allows a 90-day window)"),
      status: z.enum(BOOKING_STATUSES).optional(),
      updated_since: utcDateTime(false).optional().describe("Only bookings updated since this UTC time"),
      max_results: maxResults(),
      cursor: cursorArg,
      include_contact_details: includeContact("patient contact details, date of birth, NHS number, address, payor details and the booking's information fields"),
    },
    annotations: READ,
  },
  safe(async ({ start_time_from, start_time_to, clinician_id, patient_id, status, updated_since, max_results, cursor, include_contact_details }) => {
    const recall = status !== undefined && RECALL_STATUSES.has(status);
    if (recall) {
      if (start_time_from !== undefined || start_time_to !== undefined) throw new CarebitError(`Omit start_time_from and start_time_to with status ${status}: recall bookings have no diary start_time and the API does not apply a window to them.`);
    } else {
      if (start_time_from === undefined || start_time_to === undefined) throw new CarebitError("Give both start_time_from and start_time_to: the API requires a time window for diary queries (including did_not_attend); only the recall statuses go without one.");
      const spanDays = (Date.parse(start_time_to) - Date.parse(start_time_from)) / DAY_MS;
      if (spanDays < 0) throw new CarebitError(`start_time_to (${start_time_to}) is before start_time_from (${start_time_from}).`);
      const limit = patient_id ? 90 : 30;
      if (spanDays > limit) {
        // A bare end date became 23:59:59Z, so "2026-10-01" to "2026-10-31" spans 31 days; the split
        // suggested keeps every booking of the last day (an upper bound of T00:00:00Z would drop it).
        const lastDay = start_time_to.slice(0, 10);
        const cut = new Date(Date.parse(start_time_from) + limit * DAY_MS - 1000).toISOString().replace(".000Z", "Z");
        const hint = start_time_to.endsWith("T23:59:59Z") && spanDays <= limit + 1 ? ` A bare end date counts as the end of that day (23:59:59Z); use start_time_from ${start_time_from} with start_time_to ${cut}, then ${lastDay} to ${lastDay}.` : " Split it into shorter windows.";
        throw new CarebitError(`The window ${start_time_from} to ${start_time_to} spans ${Math.ceil(spanDays)} days; the API allows at most ${limit} days${patient_id ? " with patient_id" : " (90 with patient_id)"}.${hint}`);
      }
    }
    const r = await api.list("/v1/bookings", { maxItems: max_results, maxPages: 20, cursor, scope: "bookings.read", query: { start_time_from, start_time_to, clinician_id, patient_id, status, updated_since } });
    return { count: r.items.length, complete: r.complete, next_cursor: r.next_cursor, note: pageNote(r), bookings: r.items.map((b) => fmt.booking(b, include_contact_details)) };
  }),
);

server.registerTool(
  "get_booking",
  {
    title: "Get a booking",
    description: "One booking: status, times, clinician, patient (name by default), service and variants, location, payor, recall and cancellation details. Contact details and the free-text information fields only with include_contact_details.",
    inputSchema: { booking_id: uuid("Booking"), include_contact_details: includeContact("patient contact details, date of birth, NHS number, address, payor details and the booking's information fields") },
    annotations: READ,
  },
  safe(async ({ booking_id, include_contact_details }) => ({ booking: fmt.booking(await api.get(`/v1/bookings/${booking_id}`, undefined, "bookings.read"), include_contact_details) })),
);

server.registerTool(
  "search_patients",
  {
    title: "Search patients",
    description:
      "Patients with an active connection to the Organization, filtered with the exact-match filters the API documents (all case-insensitive; ANDed): first_name, last_name, date_of_birth, email, phone_number, or up to 25 ids. There is no partial-name search. Without filters the whole connected list is paged. Names, sex and patient number are returned; contact details, date of birth, NHS number and address only with include_contact_details (a search by email or phone still confirms that such a record exists).",
    inputSchema: {
      first_name: z.string().min(1).max(200).optional().describe("Exact first name"),
      last_name: z.string().min(1).max(200).optional().describe("Exact last name"),
      date_of_birth: isoDate.optional().describe("Exact date of birth, YYYY-MM-DD"),
      email: z.string().email().optional().describe("Exact email address"),
      phone_number: z.string().min(3).max(30).optional().describe("Exact phone or mobile number, E.164 where possible (+447700900123); a number without + or 00 is treated as UK"),
      ids: z.array(uuid("Patient")).min(1).max(25).optional().describe("Only these patient ids (at most 25)"),
      max_results: maxResults(),
      cursor: cursorArg,
      include_contact_details: includeContact("patient contact details, date of birth, NHS number, address, third-party identifier and payment-method link"),
    },
    annotations: READ,
  },
  safe(async ({ first_name, last_name, date_of_birth, email, phone_number, ids, max_results, cursor, include_contact_details }) => {
    const r = await api.list("/v1/patients", { maxItems: max_results, maxPages: 20, cursor, scope: "patients.read", query: { first_name, last_name, date_of_birth, email, phone_number, "ids[]": ids } });
    return { count: r.items.length, complete: r.complete, next_cursor: r.next_cursor, note: pageNote(r), patients: r.items.map((p) => fmt.patient(p, include_contact_details)) };
  }),
);

server.registerTool(
  "get_patient",
  {
    title: "Get a patient",
    description: "One patient by id. Name, sex and patient number by default; contact details, date of birth, NHS number, address, third-party identifier and payment-method link only with include_contact_details.",
    inputSchema: { patient_id: uuid("Patient"), include_contact_details: includeContact("patient contact details, date of birth, NHS number, address, third-party identifier and payment-method link") },
    annotations: READ,
  },
  safe(async ({ patient_id, include_contact_details }) => ({ patient: fmt.patient(await api.get(`/v1/patients/${patient_id}`, undefined, "patients.read"), include_contact_details) })),
);

server.registerTool(
  "list_invoices",
  {
    title: "List invoices",
    description: "Invoices in the Organization with status, totals, outstanding and paid amounts (minor currency units), supply date, payor type, patient and booking ids and line items. Filters sent as documented: booking_id, patient_id (ANDed). The Patient Portal payment link only with include_contact_details.",
    inputSchema: { booking_id: uuid("Booking").optional(), patient_id: uuid("Patient").optional(), max_results: maxResults(), cursor: cursorArg, include_contact_details: includeContact("the Patient Portal payment link") },
    annotations: READ,
  },
  safe(async ({ booking_id, patient_id, max_results, cursor, include_contact_details }) => {
    const r = await api.list("/v1/invoices", { maxItems: max_results, maxPages: 20, cursor, scope: "invoices.read", query: { booking_id, patient_id } });
    return { count: r.items.length, complete: r.complete, next_cursor: r.next_cursor, note: pageNote(r), invoices: r.items.map((i) => fmt.invoice(i, include_contact_details)) };
  }),
);

server.registerTool(
  "get_invoice",
  {
    title: "Get an invoice",
    description: "One invoice by id with its line items. Line-item titles and invoice notes are the practice's own text and go through the redaction unless include_contact_details is set.",
    inputSchema: { invoice_id: uuid("Invoice"), include_contact_details: includeContact("the Patient Portal payment link") },
    annotations: READ,
  },
  safe(async ({ invoice_id, include_contact_details }) => ({ invoice: fmt.invoice(await api.get(`/v1/invoices/${invoice_id}`, undefined, "invoices.read"), include_contact_details) })),
);

server.registerTool(
  "list_payments",
  {
    title: "List payments",
    description: "Payments in the Organization with status, amount (minor currency units), method type, payor type, invoice and patient ids and any refunds. Filters sent as documented: patient_id, paid_at_from, paid_at_to (UTC; payments with no paid_at are omitted when a bound is set). Stored card details are never returned.",
    inputSchema: {
      patient_id: uuid("Patient").optional(),
      paid_at_from: utcDateTime(false).optional().describe("Inclusive lower bound for paid_at, YYYY-MM-DDTHH:MM:SSZ or YYYY-MM-DD"),
      paid_at_to: utcDateTime(true).optional().describe("Inclusive upper bound for paid_at, YYYY-MM-DDTHH:MM:SSZ or YYYY-MM-DD (a bare date means the end of that day)"),
      max_results: maxResults(),
      cursor: cursorArg,
      include_contact_details: includeContact("nothing extra (internal notes are the practice's own text)"),
    },
    annotations: READ,
  },
  safe(async ({ patient_id, paid_at_from, paid_at_to, max_results, cursor, include_contact_details }) => {
    const r = await api.list("/v1/payments", { maxItems: max_results, maxPages: 20, cursor, scope: "payments.read", query: { patient_id, paid_at_from, paid_at_to } });
    return { count: r.items.length, complete: r.complete, next_cursor: r.next_cursor, note: pageNote(r), payments: r.items.map((p) => fmt.payment(p, include_contact_details)) };
  }),
);

server.registerTool(
  "list_human_tasks",
  {
    title: "List staff tasks",
    description: "The Organization's staff task queue (HumanTasks), newest first: content, due date, urgency, completion, assignees, patient and document ids. Filters sent as documented: patient_id, staff_member_id, document_id, is_completed (false for open tasks only).",
    inputSchema: {
      patient_id: uuid("Patient").optional(),
      staff_member_id: uuid("Staff member").optional().describe("Only tasks assigned to this staff member"),
      document_id: uuid("Document").optional().describe("Only tasks about this document (a letter, test result, photo or booking form)"),
      is_completed: z.boolean().optional().describe("true for completed tasks only, false for open tasks only"),
      max_results: maxResults(),
      cursor: cursorArg,
      include_contact_details: includeContact("nothing extra (task content is the practice's own text)"),
    },
    annotations: READ,
  },
  safe(async ({ patient_id, staff_member_id, document_id, is_completed, max_results, cursor, include_contact_details }) => {
    const r = await api.list("/v1/human_tasks", { maxItems: max_results, maxPages: 20, cursor, scope: "human_tasks.read", query: { patient_id, staff_member_id, document_id, is_completed } });
    return { count: r.items.length, complete: r.complete, next_cursor: r.next_cursor, note: pageNote(r), tasks: r.items.map((t) => fmt.humanTask(t, include_contact_details)) };
  }),
);

server.registerTool(
  "list_services",
  {
    title: "List services",
    description: "The Organization's services with duration, online-bookable flag, tax rate and their variants (id, price in minor units, clinician and location it is specific to). Variant ids are what find_availability and create_booking take. Filter sent as documented: is_bookable_online. Names and descriptions are the practice's own text and go through the redaction unless include_contact_details is set.",
    inputSchema: { is_bookable_online: z.boolean().optional().describe("Only services patients can book online"), max_results: maxResults(), cursor: cursorArg, include_contact_details: includeContact("nothing extra (service names and descriptions are the practice's own text)") },
    annotations: READ,
  },
  safe(async ({ is_bookable_online, max_results, cursor, include_contact_details }) => {
    const r = await api.list("/v1/services", { maxItems: max_results, maxPages: 20, cursor, scope: "services.read", query: { is_bookable_online } });
    return { count: r.items.length, complete: r.complete, next_cursor: r.next_cursor, note: pageNote(r), services: r.items.map((s) => fmt.service(s, include_contact_details)) };
  }),
);

server.registerTool(
  "list_locations",
  {
    title: "List locations",
    description: "The Organization's locations (clinics) with their addresses.",
    inputSchema: { max_results: maxResults(), cursor: cursorArg },
    annotations: READ,
  },
  safe(async ({ max_results, cursor }) => {
    const r = await api.list("/v1/locations", { maxItems: max_results, maxPages: 20, cursor, scope: "locations.read" });
    return { count: r.items.length, complete: r.complete, next_cursor: r.next_cursor, note: pageNote(r), locations: r.items.map(fmt.location) };
  }),
);

if (allowWrites) {
  const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } as const;
  const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true } as const;
  const notRetried = "Every write carries a fresh Idempotency-Key (a UUID), as the API requires. If Carebit answers with a gateway error (502/503/504) the request is NOT retried, because it may already have been processed: check with the matching list tool before calling again.";

  server.registerTool(
    "create_human_task",
    {
      title: "Create a staff task",
      description: `Add a task to the Organization's staff task queue (POST /v1/human_tasks): content, due date, urgency, optional reminders, optional patient and document, and optional staff-member assignees (ids from Carebit; this server has no staff-member tool). ${notRetried} Only available when CAREBIT_ALLOW_WRITES=true.`,
      inputSchema: {
        content: z.string().min(1).max(5000).describe("What needs doing"),
        due_date: isoDate.describe("Date by which staff should complete it, YYYY-MM-DD"),
        is_urgent: z.boolean().default(false),
        is_remindable: z.boolean().optional().describe("Whether Carebit may send reminders when the task becomes due (API default when omitted)"),
        patient_id: uuid("Patient").optional(),
        document_id: uuid("Document").optional(),
        assignee_staff_member_ids: z.array(uuid("Staff member")).max(20).default([]).describe("Staff members to assign (sent as assignees with assignee_type staff_member)"),
      },
      annotations: WRITE,
    },
    safe(async ({ content, due_date, is_urgent, is_remindable, patient_id, document_id, assignee_staff_member_ids }) => {
      // Body shape: spec POST /v1/human_tasks request schema (content and due_date required).
      const body = {
        content,
        due_date,
        is_urgent,
        ...(is_remindable !== undefined ? { is_remindable } : {}),
        ...(patient_id !== undefined ? { patient_id } : {}),
        ...(document_id !== undefined ? { document_id } : {}),
        ...(assignee_staff_member_ids.length ? { assignees: assignee_staff_member_ids.map((id) => ({ assignee_type: "staff_member", assignee_id: id })) } : {}),
      };
      const { data, headers } = await api.post("/v1/human_tasks", body, "human_tasks.create");
      return { result: headers.get("idempotency-replayed") === "true" ? "already created (replayed)" : "created", task: fmt.humanTask(data ?? {}, false) };
    }),
  );

  server.registerTool(
    "create_booking",
    {
      title: "Create a diary booking",
      description: `Create a diary booking (POST /v1/bookings) for a patient: start_time (UTC), service_id and service_variant_id (from list_services), and optionally clinician_id, location_id, end_time, status (unconfirmed or confirmed; the API's default applies when omitted), is_remote, and information for the patient or staff. Check the slot with find_availability first. notify_patient defaults to false here so no email goes to the patient unless asked; the API's own default is true. Recall bookings (status awaiting_recall) are not supported by this tool. ${notRetried} Only available when CAREBIT_ALLOW_WRITES=true.`,
      inputSchema: {
        patient_id: uuid("Patient"),
        service_id: uuid("Service"),
        service_variant_id: uuid("Service variant"),
        start_time: utcDateTime(false).describe("Start, YYYY-MM-DDTHH:MM:SSZ (UTC)"),
        end_time: utcDateTime(false).optional().describe("End, YYYY-MM-DDTHH:MM:SSZ; the service duration applies when omitted"),
        clinician_id: uuid("Clinician").optional(),
        location_id: uuid("Location").optional(),
        status: z.enum(["unconfirmed", "confirmed"]).optional(),
        notify_patient: z.boolean().default(false).describe("Whether Carebit emails the patient about this booking (confirmation, updates, cancellation)"),
        is_remote: z.boolean().optional(),
        information_for_patient: z.string().max(5000).optional(),
        information_for_staff_members: z.string().max(5000).optional(),
      },
      annotations: WRITE,
    },
    safe(async ({ patient_id, service_id, service_variant_id, start_time, end_time, clinician_id, location_id, status, notify_patient, is_remote, information_for_patient, information_for_staff_members }) => {
      if (end_time !== undefined && Date.parse(end_time) <= Date.parse(start_time)) throw new CarebitError(`Not booked. end_time (${end_time}) is not after start_time (${start_time}).`);
      // Body shape: spec POST /v1/bookings, diary branch (patient_id, service_id, service_variant_id, start_time required).
      const body = {
        patient_id,
        service_id,
        service_variant_id,
        start_time,
        notify_patient,
        ...(end_time !== undefined ? { end_time } : {}),
        ...(clinician_id !== undefined ? { clinician_id } : {}),
        ...(location_id !== undefined ? { location_id } : {}),
        ...(status !== undefined ? { status } : {}),
        ...(is_remote !== undefined ? { is_remote } : {}),
        ...(information_for_patient !== undefined ? { information_for_patient } : {}),
        ...(information_for_staff_members !== undefined ? { information_for_staff_members } : {}),
      };
      const { data, headers } = await api.post("/v1/bookings", body, "bookings.create");
      return { result: headers.get("idempotency-replayed") === "true" ? "already created (replayed)" : "created", booking: fmt.booking(data ?? {}, false) };
    }),
  );

  server.registerTool(
    "cancel_booking",
    {
      title: "Cancel a booking",
      description: `Cancel a booking (POST /v1/bookings/{booking_id}/cancellations), the same path as a staff cancellation: the API records cancellation_source api, applies any attendance penalty invoice the Organization has configured (except for bookings awaiting payment), and emails the patient if the booking's notify_patient is true. cancellation_reason is required when the Organization requires reasons. Cannot be undone. ${notRetried} Only available when CAREBIT_ALLOW_WRITES=true.`,
      inputSchema: {
        booking_id: uuid("Booking"),
        cancellation_reason: z.enum(CANCELLATION_REASONS).optional().describe("Documented reason code, e.g. booked_in_error, rescheduled, no_longer_required"),
        cancellation_information: z.string().max(5000).optional().describe("Free-text note recorded with the cancellation"),
      },
      annotations: DESTRUCTIVE,
    },
    safe(async ({ booking_id, cancellation_reason, cancellation_information }) => {
      // Body shape: spec POST /v1/bookings/{booking_id}/cancellations (both fields optional, nullable).
      const body = { ...(cancellation_reason !== undefined ? { cancellation_reason } : {}), ...(cancellation_information !== undefined ? { cancellation_information } : {}) };
      const { data, headers } = await api.post(`/v1/bookings/${booking_id}/cancellations`, body, "bookings.cancel");
      return { result: headers.get("idempotency-replayed") === "true" ? "already canceled (replayed)" : "canceled", booking: fmt.booking(data ?? {}, false) };
    }),
  );
}

await server.connect(new StdioServerTransport());
console.error(`Carebit MCP server running against ${api.base} (writes ${allowWrites ? "enabled" : "disabled"}).`);
