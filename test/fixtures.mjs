// Fake Carebit data shaped exactly like the schemas in Carebit's OpenAPI document (validated in e2e.mjs).
// Every identifier is a deterministic, obviously fake UUID; every person, email address, phone number
// and NHS-shaped number is invented (example.invalid addresses, 07700 900xxx numbers).
const API = "https://api.carebit.co";
export const uuid = (n) => `11111111-1111-4111-8111-${String(n).padStart(12, "0")}`;
const at = (day, h, m = 0) => `2026-10-${String(day).padStart(2, "0")}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00Z`;
const stamp = "2026-09-01T10:00:00Z";

// ---- Organization (GET /v1/organization) ----
export const ORG_ID = uuid(1);
export const organization = {
  id: ORG_ID,
  object: "organization",
  name: "Example Private Clinic",
  organization_type: "private_practice",
  email: "reception@example.invalid",
  phone: "020 7946 0000",
  formatted_address: "1 Example Street, London, W1A 1AA, GB",
  address_line_1: "1 Example Street",
  address_line_2: null,
  city: "London",
  county: "Greater London",
  postcode: "W1A 1AA",
  country_code: "GB",
  currency: "gbp",
  time_zone: "Europe/London",
  subdomain: "example-clinic",
  created_at: stamp,
  updated_at: stamp,
};

// GET /v1/token (Token). The secret is never in this object, as documented.
export const PROJECT_ID = uuid(2);
export const tokenInfo = (tokenId, expiresAt, scopes) => ({
  id: tokenId,
  object: "token",
  created_at: stamp,
  expires_at: expiresAt,
  links: { organization: `${API}/v1/organization`, self: `${API}/v1/token` },
  livemode: true,
  organization: { id: ORG_ID, object: "organization", name: organization.name },
  project: { id: PROJECT_ID, object: "project", name: "MCP prototype" },
  scopes,
});

// ---- Staff members (only referenced by HumanTask assignees; this server has no staff tool) ----
export const STAFF_JO = uuid(21);
export const STAFF_KIM = uuid(22);

// ---- Locations ----
export const LOC_LONDON = uuid(31);
export const LOC_BRISTOL = uuid(32);
const mkLocation = (id, name, line1, city, county, postcode) => ({
  id,
  object: "location",
  name,
  formatted_address: `${line1}, ${city}, ${postcode}, GB`,
  address_line_1: line1,
  address_line_2: null,
  city,
  county,
  postcode,
  country_code: "GB",
  created_at: stamp,
  updated_at: stamp,
});
export const locations = [mkLocation(LOC_LONDON, "London Clinic", "1 Example Street", "London", "Greater London", "W1A 1AA"), mkLocation(LOC_BRISTOL, "Bristol Clinic", "2 Sample Road", "Bristol", "Bristol", "BS1 4DJ")];

// ---- Clinicians (six, so the four-per-page mock needs two pages) ----
export const ADA = uuid(41);
export const BEN = uuid(42);
const mkClinician = (id, title, first, last, specialty, email) => ({
  id,
  object: "clinician",
  display_name: [title, first, last].filter(Boolean).join(" "),
  title,
  first_name: first,
  last_name: last,
  medical_specialty: specialty,
  email,
  links: { bookings: `${API}/v1/bookings?clinician_id=${id}` },
  created_at: stamp,
  updated_at: stamp,
});
export const clinicians = [
  mkClinician(ADA, "Dr", "Ada", "Example", "Dermatology", "ada.example@example.invalid"),
  mkClinician(BEN, "Mr", "Ben", "Sample", "Orthopaedic surgery (queries to ben.sample@example.invalid or 07700 900001)", "ben.sample@example.invalid"),
  mkClinician(uuid(43), "Ms", "Cara", "Test", null, null),
  mkClinician(uuid(44), "Dr", "Dan", "Demo", "General practice", "dan.demo@example.invalid"),
  mkClinician(uuid(45), "Dr", "Eve", "Fixture", "Cardiology", "eve.fixture@example.invalid"),
  mkClinician(uuid(46), null, "Finn", "Placeholder", "Physiotherapy", "finn@example.invalid"),
];

// ---- Services and variants ----
export const SVC_NEW = uuid(51);
export const SVC_FOLLOW = uuid(52);
export const VAR_NEW_ADA = uuid(61);
export const VAR_NEW_REMOTE = uuid(62);
export const VAR_FOLLOW = uuid(63);
const taxRate = { id: uuid(71), title: "20% VAT", description: "Standard rate", percentage: 20 };
const mkVariant = (id, description, price, clinicianId, locationId, remote) => ({
  id,
  description,
  net_price: price,
  currency: "gbp",
  clinician_id: clinicianId,
  location_id: locationId,
  links: { clinician: clinicianId ? `${API}/v1/clinicians/${clinicianId}` : null, location: locationId ? `${API}/v1/locations/${locationId}` : null },
  permits_remote_bookings: remote,
});
export const services = [
  {
    id: SVC_NEW,
    object: "service",
    name: "New patient consultation",
    description: "First appointment, 30 minutes.",
    duration_minutes: 30,
    is_bookable_online: true,
    tax_rate: null,
    service_variants: [mkVariant(VAR_NEW_ADA, "With Dr Ada Example, London", 25000, ADA, LOC_LONDON, false), mkVariant(VAR_NEW_REMOTE, "Video consultation", 20000, null, null, true)],
    created_at: stamp,
    updated_at: stamp,
  },
  {
    id: SVC_FOLLOW,
    object: "service",
    name: "Follow-up consultation",
    description: null,
    duration_minutes: 15,
    is_bookable_online: false,
    tax_rate: taxRate,
    service_variants: [mkVariant(VAR_FOLLOW, "Standard follow-up", 15000, null, null, true)],
    created_at: stamp,
    updated_at: stamp,
  },
];

// ---- Patients (nine, so the four-per-page mock needs three pages) ----
export const SAM = uuid(81);
export const PRIYA = uuid(82);
export const EXAMPLE_API = uuid(83);
const mkPatient = (id, title, first, last, { dob = null, sex = null, email = null, phone = null, mobile = null, nhs = null, line1 = null, city = null, postcode = null, number = null, internal = null } = {}) => ({
  id,
  object: "patient",
  title,
  first_name: first,
  last_name: last,
  display_name: [title, first, last].filter(Boolean).join(" "),
  sex,
  date_of_birth: dob,
  email,
  phone,
  phone_country_dial_code: phone ? "GB" : null,
  mobile,
  mobile_country_dial_code: mobile ? "GB" : null,
  phone_number: mobile ? `+44${mobile.replace(/^0/, "")}` : phone ? `+44${phone.replace(/^0/, "").replace(/ /g, "")}` : null,
  nhs_number: nhs,
  address_line_1: line1,
  address_line_2: null,
  city,
  county: null,
  postcode,
  country_code: line1 ? "GB" : null,
  patient_number: number,
  internal_patient_id: internal,
  is_opted_out_of_sms: false,
  creation_source: "app",
  patient_portal_add_payment_method_url: `https://example-clinic.carebit.co/portal/patients/${id}/payment_methods/new`,
  created_at: stamp,
  updated_at: stamp,
});
export const patients = [
  mkPatient(SAM, "Mr", "Sam", "Evans", { dob: "1984-03-12", sex: "male", email: "sam.evans@example.invalid", mobile: "07700900123", nhs: "9434765919", line1: "1 Plymouth Road", city: "Penarth", postcode: "CF64 3DH", number: "PAT-1001", internal: "EXT-9001" }),
  mkPatient(PRIYA, "Ms", "Priya", "Shah", { dob: "1991-07-30", sex: "female", email: "priya.shah@example.invalid", phone: "0117 496 0000", nhs: "9434765927", line1: "5 Sample Street", city: "Bristol", postcode: "BS1 4DJ", number: "PAT-1002" }),
  // The example patient the testing guide tells integrators to create (fabricated name, DOB 1 January 1970).
  mkPatient(EXAMPLE_API, null, "Example API", "Patient", { dob: "1970-01-01", sex: "other", number: "PAT-1003" }),
  ...Array.from({ length: 6 }, (_, i) => mkPatient(uuid(90 + i), null, `Person${i + 1}`, `Surname${i + 1}`, { dob: `199${i}-01-0${i + 1}`, email: `person${i + 1}@example.invalid`, number: `PAT-10${10 + i}` })),
];
export const patientById = Object.fromEntries(patients.map((p) => [p.id, p]));

// ---- Payors (nested on Bookings) ----
const mkPayor = (id, type, overrides = {}) => ({
  id,
  object: "payor",
  payor_type: type,
  formatted_payor_name: null,
  formatted_name: null,
  title: null,
  first_name: null,
  last_name: null,
  address_line_1: null,
  address_line_2: null,
  city: null,
  county: null,
  postcode: null,
  country_code: null,
  insurance_company_id: null,
  alternative_payor_id: null,
  insurance_policy_number: null,
  insurance_authorization_code: null,
  insurance_policy_start_date: null,
  insurance_policy_end_date: null,
  notes: null,
  created_at: stamp,
  updated_at: stamp,
  ...overrides,
});
export const INSURER_ID = uuid(101);
const payorSamInsurer = mkPayor(uuid(111), "insurance_company", {
  formatted_payor_name: "Example Health Insurance",
  insurance_company_id: INSURER_ID,
  insurance_policy_number: "POL-0001-000123",
  insurance_authorization_code: "AUTH-77",
  insurance_policy_start_date: "2026-01-01",
  insurance_policy_end_date: "2026-12-31",
  notes: "Excess £100; ring 0800 555 0199 to pre-authorise.",
});
const payorPriyaSelf = mkPayor(uuid(112), "patient", { formatted_payor_name: "Ms Priya Shah", formatted_name: "Ms Priya Shah", title: "Ms", first_name: "Priya", last_name: "Shah", address_line_1: "5 Sample Street", city: "Bristol", postcode: "BS1 4DJ", country_code: "GB" });

// ---- Bookings (the week of Monday 5 October 2026) ----
export const RECALL_PROGRAMME = uuid(121);
const serviceOf = (id) => services.find((s) => s.id === id);
const variantOf = (id) => services.flatMap((s) => s.service_variants).find((v) => v.id === id);
const clinicianOf = (id) => clinicians.find((c) => c.id === id) ?? null;
const locationOf = (id) => locations.find((l) => l.id === id) ?? null;
const mkBooking = (n, { patient, clinician, service, variant, location, start, end, status, payor = null, remote = false, remoteMethod = null, infoPatient = null, infoStaff = null, cancel = null, recall = null, updated = stamp, notify = true }) => ({
  id: uuid(200 + n),
  object: "booking",
  status,
  start_time: start,
  end_time: end,
  is_remote: remote,
  remote_method: remoteMethod,
  clinician: clinicianOf(clinician),
  patient: patientById[patient],
  service: serviceOf(service),
  service_variants: variant ? [variantOf(variant)] : [],
  location: locationOf(location),
  payor,
  notify_patient: notify,
  recall_due_date: recall?.due ?? null,
  recall_programme_id: recall?.programme ?? null,
  canceled_at: cancel?.at ?? null,
  cancellation_reason: cancel?.reason ?? null,
  cancellation_source: cancel?.source ?? null,
  cancellation_information: cancel?.information ?? null,
  information_for_patient: infoPatient,
  information_for_staff_members: infoStaff,
  links: {
    clinician: clinician ? `${API}/v1/clinicians/${clinician}` : null,
    invoices: `${API}/v1/invoices?booking_id=${uuid(200 + n)}`,
    letters: `${API}/v1/letters?booking_id=${uuid(200 + n)}`,
    notes: `${API}/v1/notes?booking_id=${uuid(200 + n)}`,
    recall_programme: recall ? `${API}/v1/recall_programmes/${recall.programme}` : null,
    service: `${API}/v1/services/${service}`,
    test_results: `${API}/v1/test_results?booking_id=${uuid(200 + n)}`,
  },
  created_at: stamp,
  updated_at: updated,
});
export const B_SAM_MON = uuid(201);
export const B_PRIYA_MON = uuid(202);
export const B_SAM_CANCELED = uuid(203);
export const B_DNA = uuid(204);
export const B_RECALL = uuid(207);
export const bookings = [
  mkBooking(1, { patient: SAM, clinician: ADA, service: SVC_NEW, variant: VAR_NEW_ADA, location: LOC_LONDON, start: at(5, 9), end: at(5, 9, 30), status: "confirmed", payor: payorSamInsurer, infoPatient: "<p>Please arrive 10 minutes early.</p>", infoStaff: "<p>Referral letter mentions NHS number 943 476 5919 and GP on 020 7946 0958.</p>" }),
  mkBooking(2, { patient: PRIYA, clinician: ADA, service: SVC_FOLLOW, variant: VAR_FOLLOW, location: LOC_LONDON, start: at(5, 10), end: at(5, 10, 15), status: "unconfirmed", payor: payorPriyaSelf }),
  mkBooking(3, { patient: SAM, clinician: BEN, service: SVC_FOLLOW, variant: VAR_FOLLOW, location: LOC_BRISTOL, start: at(6, 14), end: at(6, 14, 15), status: "canceled", cancel: { at: at(2, 16), reason: "rescheduled", source: "staff_member", information: "Patient rang from 07700 900123 (sam.evans@example.invalid) to move it." } }),
  mkBooking(4, { patient: uuid(90), clinician: ADA, service: SVC_NEW, variant: VAR_NEW_ADA, location: LOC_LONDON, start: at(7, 9), end: at(7, 9, 30), status: "did_not_attend" }),
  mkBooking(5, { patient: uuid(91), clinician: ADA, service: SVC_NEW, variant: VAR_NEW_REMOTE, location: null, start: at(8, 11), end: at(8, 11, 30), status: "confirmed", remote: true, remoteMethod: "native_video", updated: "2026-10-01T09:00:00Z" }),
  mkBooking(6, { patient: uuid(92), clinician: ADA, service: SVC_FOLLOW, variant: VAR_FOLLOW, location: LOC_LONDON, start: at(9, 15), end: at(9, 15, 15), status: "arrived" }),
  // A recall Booking: no diary start_time, listed by status only, ordered by recall_due_date.
  mkBooking(7, { patient: SAM, clinician: ADA, service: SVC_FOLLOW, variant: null, location: LOC_LONDON, start: null, end: null, status: "awaiting_recall", recall: { due: "2026-12-01", programme: RECALL_PROGRAMME } }),
  mkBooking(8, { patient: PRIYA, clinician: ADA, service: SVC_NEW, variant: VAR_NEW_ADA, location: LOC_LONDON, start: at(5, 11), end: at(5, 11, 30), status: "confirmed", updated: "2026-10-02T09:00:00Z" }),
  mkBooking(9, { patient: uuid(93), clinician: BEN, service: SVC_NEW, variant: VAR_NEW_ADA, location: LOC_BRISTOL, start: at(5, 15), end: at(5, 15, 30), status: "confirmed" }),
  mkBooking(10, { patient: uuid(94), clinician: ADA, service: SVC_FOLLOW, variant: VAR_FOLLOW, location: LOC_LONDON, start: at(6, 9), end: at(6, 9, 15), status: "confirmed" }),
  mkBooking(11, { patient: uuid(95), clinician: ADA, service: SVC_FOLLOW, variant: VAR_FOLLOW, location: LOC_LONDON, start: at(6, 9, 15), end: at(6, 9, 30), status: "prepared" }),
];
export const bookingById = Object.fromEntries(bookings.map((b) => [b.id, b]));

// ---- Clinician agenda (GET /v1/clinician_agenda): Dr Ada Example's diary items, one per day/interval ----
const agendaItem = (clinician, type, start, end, { booking = null, location = LOC_LONDON, services: svc = [], variants = [] } = {}) => ({
  object: "clinician_agenda_item",
  type,
  booking,
  clinician_id: clinician,
  start_time: start,
  end_time: end,
  location_id: type === "unavailability" ? null : location,
  room_id: null,
  service_ids: svc,
  service_variant_ids: variants,
});
export const agenda = {
  [ADA]: [
    agendaItem(ADA, "availability", at(5, 9), at(5, 13), { services: [SVC_NEW, SVC_FOLLOW], variants: [VAR_NEW_ADA, VAR_FOLLOW] }),
    ...[B_SAM_MON, B_PRIYA_MON, uuid(208)].map((id) => agendaItem(ADA, "booking", bookingById[id].start_time, bookingById[id].end_time, { booking: bookingById[id], services: [bookingById[id].service.id], variants: bookingById[id].service_variants.map((v) => v.id) })),
    agendaItem(ADA, "unavailability", at(5, 13), at(5, 14)),
    agendaItem(ADA, "availability", at(5, 14), at(5, 17), { services: [SVC_NEW, SVC_FOLLOW], variants: [VAR_NEW_ADA, VAR_FOLLOW] }),
    agendaItem(ADA, "availability", at(6, 9), at(6, 13), { services: [SVC_FOLLOW], variants: [VAR_FOLLOW] }),
    ...[uuid(210), uuid(211)].map((id) => agendaItem(ADA, "booking", bookingById[id].start_time, bookingById[id].end_time, { booking: bookingById[id], services: [bookingById[id].service.id], variants: bookingById[id].service_variants.map((v) => v.id) })),
    ...[uuid(204)].map((id) => agendaItem(ADA, "booking", bookingById[id].start_time, bookingById[id].end_time, { booking: bookingById[id], services: [SVC_NEW], variants: [VAR_NEW_ADA] })),
    agendaItem(ADA, "booking", at(8, 11), at(8, 11, 30), { booking: bookingById[uuid(205)], location: null, services: [SVC_NEW], variants: [VAR_NEW_REMOTE] }),
    agendaItem(ADA, "booking", at(9, 15), at(9, 15, 15), { booking: bookingById[uuid(206)], services: [SVC_FOLLOW], variants: [VAR_FOLLOW] }),
  ],
  [BEN]: [agendaItem(BEN, "booking", at(5, 15), at(5, 15, 30), { booking: bookingById[uuid(209)], location: LOC_BRISTOL, services: [SVC_NEW], variants: [VAR_NEW_ADA] })],
};

// ---- Availability slots (GET /v1/availability_slots, GET /v1/next_availability_slot): Dr Ada, new-patient variant ----
const mkSlot = (start, end) => ({
  object: "availability_slot",
  resource_type: "clinician",
  clinician_id: ADA,
  service_id: SVC_NEW,
  service_variant_id: VAR_NEW_ADA,
  location_id: LOC_LONDON,
  room_id: null,
  start_time: start,
  end_time: end,
});
export const slots = [mkSlot(at(5, 9, 30), at(5, 10)), mkSlot(at(5, 11, 30), at(5, 12)), mkSlot(at(5, 12), at(5, 12, 30)), mkSlot(at(5, 14), at(5, 14, 30)), mkSlot(at(6, 10), at(6, 10, 30)), mkSlot(at(7, 10), at(7, 10, 30))];

// ---- Invoices ----
export const INV_SAM = uuid(301);
export const INV_PRIYA_OVERDUE = uuid(302);
const lineItem = (n, invoice, { title, qty = 1, unit, tax = 0, discount = 0, variant = null, booking = null }) => ({
  id: uuid(400 + n),
  object: "invoice_line_item",
  title,
  quantity: qty,
  unit_price: unit,
  net_amount: unit * qty - discount,
  tax_amount: tax,
  discount_amount: discount,
  gross_amount: unit * qty - discount + tax,
  total: unit * qty - discount + tax,
  currency: "gbp",
  service_variant_id: variant,
  booking_id: booking,
  tax_rate_id: tax ? taxRate.id : null,
  created_at: stamp,
  updated_at: stamp,
});
const mkInvoice = (id, number, { title, status, patient, clinician, bookings: bk = [], total, paid, notes = null, supply = "2026-10-05", payorType = "patient", lines }) => ({
  id,
  object: "invoice",
  invoice_number: number,
  title,
  status,
  currency: "gbp",
  subtotal: total,
  tax_amount: 0,
  total_discount_amount: 0,
  total,
  total_paid: paid,
  total_outstanding: total - paid,
  supply_date: supply,
  payor_type: payorType,
  patient_id: patient,
  clinician_id: clinician,
  booking_ids: bk,
  invoice_notes: notes,
  payment_url: number ? `https://example-clinic.carebit.co/portal/invoices/${id}/pay` : null,
  line_items: lines,
  links: { patient: patient ? `${API}/v1/patients/${patient}` : null },
  created_at: stamp,
  updated_at: stamp,
});
export const invoices = [
  mkInvoice(INV_SAM, "INV-1001", { title: "New patient consultation", status: "paid", patient: SAM, clinician: ADA, bookings: [B_SAM_MON], total: 25000, paid: 25000, payorType: "insurance_company", lines: [lineItem(1, INV_SAM, { title: "New patient consultation with Dr Ada Example", unit: 25000, variant: VAR_NEW_ADA, booking: B_SAM_MON })] }),
  mkInvoice(INV_PRIYA_OVERDUE, "INV-1002", { title: "Follow-up consultation", status: "overdue", patient: PRIYA, clinician: ADA, bookings: [B_PRIYA_MON], total: 15000, paid: 0, notes: "<p>Queries to accounts@example.invalid or 020 7946 0000.</p>", lines: [lineItem(2, INV_PRIYA_OVERDUE, { title: "Follow-up consultation", unit: 15000, variant: VAR_FOLLOW, booking: B_PRIYA_MON })] }),
  mkInvoice(uuid(303), null, { title: "Draft", status: "draft", patient: SAM, clinician: BEN, bookings: [B_SAM_CANCELED], total: 15000, paid: 0, lines: [lineItem(3, uuid(303), { title: "Follow-up consultation", unit: 15000, variant: VAR_FOLLOW, booking: B_SAM_CANCELED })] }),
  mkInvoice(uuid(304), "INV-1004", { title: "Video consultation", status: "partially_paid", patient: uuid(91), clinician: ADA, bookings: [uuid(205)], total: 20000, paid: 5000, lines: [lineItem(4, uuid(304), { title: "Video consultation", unit: 20000, variant: VAR_NEW_REMOTE, booking: uuid(205) })] }),
  mkInvoice(uuid(305), "INV-1005", { title: "Follow-up consultation", status: "unpaid", patient: uuid(92), clinician: ADA, bookings: [uuid(206)], total: 15000, paid: 0, supply: "2026-10-09", lines: [lineItem(5, uuid(305), { title: "Follow-up consultation", unit: 15000, variant: VAR_FOLLOW, booking: uuid(206) })] }),
];

// ---- Payments and refunds ----
export const PAY_SAM = uuid(501);
const mkRefund = (id, payment, { amount, status, reason, source, succeeded = null, notes = null, error = null, nextSteps = null, patient, invoice }) => ({
  id,
  object: "refund",
  amount,
  currency: "gbp",
  status,
  reason,
  refund_source: source,
  succeeded_at: succeeded,
  error,
  next_steps: nextSteps,
  notes,
  invoice_id: invoice,
  patient_id: patient,
  payment_id: payment,
  links: { patient: `${API}/v1/patients/${patient}` },
  created_at: stamp,
  updated_at: stamp,
});
const mkPayment = (id, { amount, status, paidAt, method, patient, invoice, payorType = "patient", paymentMethodId = null, notes = null, refunds = [] }) => ({
  id,
  object: "payment",
  amount,
  currency: "gbp",
  status,
  paid_at: paidAt,
  payment_method_type: method,
  payment_method_id: paymentMethodId,
  payor_type: payorType,
  invoice_id: invoice,
  patient_id: patient,
  internal_notes: notes,
  refunds,
  links: { patient: patient ? `${API}/v1/patients/${patient}` : null },
  created_at: stamp,
  updated_at: stamp,
});
export const STORED_CARD = uuid(601); // a stored card PaymentMethod id; must never appear in tool output
export const payments = [
  mkPayment(PAY_SAM, { amount: 25000, status: "partially_refunded", paidAt: "2026-10-05T12:00:00Z", method: "card", patient: SAM, invoice: INV_SAM, payorType: "insurance_company", paymentMethodId: STORED_CARD, notes: "Card ending 4242 charged by reception (query 07700 900002).", refunds: [mkRefund(uuid(511), PAY_SAM, { amount: 5000, status: "succeeded", reason: "overcharged", source: "payment_account", succeeded: "2026-10-06T09:00:00Z", patient: SAM, invoice: INV_SAM })] }),
  mkPayment(uuid(502), { amount: 5000, status: "paid", paidAt: "2026-10-08T15:00:00Z", method: "bank_transfer", patient: uuid(91), invoice: uuid(304) }),
  mkPayment(uuid(503), { amount: 15000, status: "scheduled", paidAt: null, method: "card", patient: PRIYA, invoice: INV_PRIYA_OVERDUE, paymentMethodId: STORED_CARD }),
  mkPayment(uuid(504), { amount: 15000, status: "paid", paidAt: "2026-09-20T10:00:00Z", method: "cash", patient: uuid(92), invoice: null }),
];

// ---- Human tasks (newest first, as documented) ----
export const DOC_LETTER = uuid(701);
const mkTask = (n, { content, due, urgent = false, remindable = true, completed = null, completedBy = null, patient = null, document = null, assignees = [], source = "staff_member", created }) => ({
  id: uuid(800 + n),
  object: "human_task",
  content,
  due_date: due,
  is_urgent: urgent,
  is_remindable: remindable,
  completed_at: completed,
  completed_by_staff_member_id: completedBy,
  assignees: assignees.map((id) => ({ assignee_type: "staff_member", assignee_id: id })),
  patient_id: patient,
  document_id: document,
  creation_source: source,
  links: { completed_by_staff_member: completedBy ? `${API}/v1/staff_members/${completedBy}` : null, document: document ? `${API}/v1/letters/${document}` : null, patient: patient ? `${API}/v1/patients/${patient}` : null },
  created_at: created,
  updated_at: created,
});
export const humanTasks = [
  mkTask(1, { content: "Chase insurer authorisation for Sam Evans (ring 0800 555 0199, quote POL-0001-000123).", due: "2026-10-06", urgent: true, patient: SAM, assignees: [STAFF_JO], created: "2026-10-02T09:00:00Z" }),
  mkTask(2, { content: "Review the referral letter before Monday's clinic (NHS 943 476 5919, patient now at BS1 4DJ).", due: "2026-10-04", patient: SAM, document: DOC_LETTER, assignees: [STAFF_KIM], created: "2026-10-01T16:00:00Z" }),
  mkTask(3, { content: "Send INV-1002 reminder to priya.shah@example.invalid.", due: "2026-10-03", patient: PRIYA, assignees: [STAFF_JO], created: "2026-10-01T09:00:00Z" }),
  mkTask(4, { content: "Order more consent forms.", due: "2026-09-30", completed: "2026-09-29T14:00:00Z", completedBy: STAFF_KIM, assignees: [STAFF_KIM], created: "2026-09-25T09:00:00Z" }),
  mkTask(5, { content: "Confirm Priya Shah's follow-up.", due: "2026-09-28", completed: "2026-09-28T10:00:00Z", completedBy: STAFF_JO, patient: PRIYA, assignees: [STAFF_JO], created: "2026-09-24T09:00:00Z", source: "automation" }),
  mkTask(6, { content: "Archive last year's letters.", due: "2026-09-20", completed: "2026-09-21T10:00:00Z", completedBy: null, source: "api", remindable: false, created: "2026-09-10T09:00:00Z" }),
];
