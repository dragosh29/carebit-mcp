// Turn Carebit API records into compact objects an assistant can read quickly.
// Field names follow the schemas in Carebit's OpenAPI document (Organization, Token, Clinician,
// ClinicianAgendaItem, AvailabilitySlot, Booking, Patient, Payor, Service, ServiceVariant, TaxRate,
// Location, Invoice, InvoiceLineItem, Payment, Refund, HumanTask).

type Rec = Record<string, any>;

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// Phone-number-like sequences, a heuristic. Three shapes, digits optionally separated by a space, dot
// or hyphen:
//   international: "+" or "00", a 1-3 digit country code, an optional "(0)" trunk prefix, then 6-14
//     digits (+44 7700 900123, +447700900321, +44 (0)7700 900123, 0044 20 7946 0958, 00 44 7700 900123);
//   bracketed UK area code: "(0...)" then 5-10 digits ((020) 7946 0958, (0117) 496 0000, (07700) 900789);
//   UK national: "0" then 8-10 more digits (07700 900789, 020 7946 0958, 07 700 900 789, 07700.900123).
// Bounded by characters other than letters, digits, "_" and "-", so UUIDs, timestamps and hyphenated
// references such as INV-1001 are left alone. Any other 9-11 digit string starting with 0 (an order
// number, say) is redacted too; the raw text is available with include_contact_details.
const PHONE = /(?<![\w-])(?:(?:\+|00)[ .-]?[1-9]\d{0,2}(?:[ .-]?\(0\))?(?:[ .-]?\d){6,14}|\(0\d{0,4}\)(?:[ .-]?\d){5,10}|0(?:[ .-]?\d){8,10})(?![\w-])/g;
// NHS numbers are 10 digits, usually written 3-3-4 (943 476 5919) or unbroken. Any 10-digit group in
// that shape is redacted, including a 10-digit reference that is not an NHS number; the nhs_number
// field itself is withheld by default. Runs after PHONE, so a UK number starting with 0 is already gone.
const NHS_NUMBER = /(?<![\w-])\d{3}[ -]?\d{3}[ -]?\d{4}(?![\w-])/g;
// UK postcodes (CF64 3DH, SW1A 1AA, M1 1AE, EC1A1BB): one or two capitals, a digit, an optional
// letter or digit, an optional space, a digit and two capitals, not touching other letters or digits.
// Upper case only, so ordinary words are left alone; a code written in the same shape would be
// redacted too.
const POSTCODE = /(?<![A-Za-z0-9])[A-Z]{1,2}\d[A-Z\d]? ?\d[A-Z]{2}(?![A-Za-z0-9])/g;
// A payment card number typed into free text: 13 to 19 digits, optionally in groups separated by
// spaces or hyphens, bounded like the phone pattern, that pass the Luhn check (which one arbitrary
// digit string in ten also passes, so a long reference number can be caught too). Runs first, so a
// card number is never partly consumed by the phone or NHS patterns, and runs even when contact
// details were requested: this server never returns card data. A fragment such as "ending 4242"
// cannot be told from an ordinary number and is left alone.
const CARD = /(?<![\w-])\d(?:[ -]?\d){12,18}(?![\w-])/g;
const luhn = (digits: string): boolean => {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = Number(digits[i]);
    if (double) n = n > 4 ? n * 2 - 9 : n * 2;
    sum += n;
    double = !double;
  }
  return sum % 10 === 0;
};
const redactCards = (text: string) => text.replace(CARD, (m) => (luhn(m.replace(/\D/g, "")) ? "[card number redacted]" : m));

const redactString = (text: string) => redactCards(text).replace(EMAIL, "[email redacted]").replace(PHONE, "[phone redacted]").replace(NHS_NUMBER, "[number redacted]").replace(POSTCODE, "[postcode redacted]");

/**
 * Replace email addresses, phone-number-like sequences, 10-digit NHS-number-shaped groups and UK
 * postcodes inside free text (names, notes, task content, cancellation notes, error messages)
 * unless contact details were requested. Luhn-valid card numbers are replaced either way. Dates
 * inside free text are not touched: the date_of_birth field itself is withheld by patient().
 */
export function redactContacts(text: unknown, includeContact: boolean): string | undefined {
  if (typeof text !== "string") return undefined;
  if (text === "") return undefined;
  return includeContact ? redactCards(text) : redactString(text);
}

const str = (v: unknown) => (v === undefined || v === null || v === "" ? undefined : String(v));
const num = (v: unknown) => {
  const n = Number(v);
  return v === undefined || v === null || v === "" || !Number.isFinite(n) ? undefined : n;
};
const bool = (v: unknown) => (typeof v === "boolean" ? v : undefined);
const ids = (v: unknown) => (Array.isArray(v) ? v.map(str).filter((x): x is string => x !== undefined) : undefined);

// GET /v1/organization: the account holder's own Organization, returned as stored (its contact
// details are the customer's own, not a third party's).
export function organization(o: Rec) {
  return {
    id: str(o.id),
    name: str(o.name),
    organization_type: str(o.organization_type),
    email: str(o.email),
    phone: str(o.phone),
    formatted_address: str(o.formatted_address),
    address_line_1: str(o.address_line_1),
    address_line_2: str(o.address_line_2),
    city: str(o.city),
    county: str(o.county),
    postcode: str(o.postcode),
    country_code: str(o.country_code),
    currency: str(o.currency),
    time_zone: str(o.time_zone),
    subdomain: str(o.subdomain),
    created_at: str(o.created_at),
    updated_at: str(o.updated_at),
  };
}

// GET /v1/token: the access token in use (no secret), its project and scopes.
export function token(t: Rec) {
  return {
    scopes: ids(t.scopes),
    expires_at: str(t.expires_at),
    livemode: bool(t.livemode),
    project: t.project && typeof t.project === "object" ? { id: str(t.project.id), name: str(t.project.name) } : undefined,
    organization: t.organization && typeof t.organization === "object" ? { id: str(t.organization.id), name: str(t.organization.name) } : undefined,
  };
}

// Clinician. The email is the clinician's practice contact address, staff personal data: only on request.
export function clinician(c: Rec, includeContact: boolean) {
  return {
    id: str(c.id),
    display_name: redactContacts(c.display_name, includeContact),
    title: str(c.title),
    first_name: redactContacts(c.first_name, includeContact),
    last_name: redactContacts(c.last_name, includeContact),
    medical_specialty: redactContacts(c.medical_specialty, includeContact),
    ...(includeContact ? { email: str(c.email) } : {}),
    created_at: str(c.created_at),
    updated_at: str(c.updated_at),
  };
}

// Location: the Organization's own premises, returned as stored.
export function location(l: Rec) {
  return {
    id: str(l.id),
    name: str(l.name),
    formatted_address: str(l.formatted_address),
    address_line_1: str(l.address_line_1),
    address_line_2: str(l.address_line_2),
    city: str(l.city),
    county: str(l.county),
    postcode: str(l.postcode),
    country_code: str(l.country_code),
    created_at: str(l.created_at),
    updated_at: str(l.updated_at),
  };
}

export function serviceVariant(v: Rec, includeContact: boolean) {
  return {
    id: str(v.id),
    description: redactContacts(v.description, includeContact),
    net_price: num(v.net_price),
    currency: str(v.currency),
    clinician_id: str(v.clinician_id),
    location_id: str(v.location_id),
    permits_remote_bookings: bool(v.permits_remote_bookings),
  };
}

// Service with its ServiceVariants and optional TaxRate. Prices are in minor currency units. Names
// and descriptions are the practice's own text and go through the same redaction as every other
// free-text field.
export function service(s: Rec, includeContact: boolean) {
  return {
    id: str(s.id),
    name: redactContacts(s.name, includeContact),
    description: redactContacts(s.description, includeContact),
    duration_minutes: num(s.duration_minutes),
    is_bookable_online: bool(s.is_bookable_online),
    tax_rate: s.tax_rate && typeof s.tax_rate === "object" ? { id: str(s.tax_rate.id), title: str(s.tax_rate.title), percentage: num(s.tax_rate.percentage) } : undefined,
    service_variants: Array.isArray(s.service_variants) ? s.service_variants.map((v: Rec) => serviceVariant(v, includeContact)) : [],
    created_at: str(s.created_at),
    updated_at: str(s.updated_at),
  };
}

// Patient. Names, sex and the Organization's own patient_number are returned; contact details, date
// of birth, NHS number, address, the third-party-system identifier and the Patient Portal payment
// link only on request.
export function patient(p: Rec, includeContact: boolean) {
  return {
    id: str(p.id),
    display_name: redactContacts(p.display_name, includeContact),
    title: str(p.title),
    first_name: redactContacts(p.first_name, includeContact),
    last_name: redactContacts(p.last_name, includeContact),
    sex: str(p.sex),
    patient_number: str(p.patient_number),
    is_opted_out_of_sms: bool(p.is_opted_out_of_sms),
    creation_source: str(p.creation_source),
    ...(includeContact
      ? {
          date_of_birth: str(p.date_of_birth),
          nhs_number: str(p.nhs_number),
          email: str(p.email),
          phone_number: str(p.phone_number),
          phone: str(p.phone),
          phone_country_dial_code: str(p.phone_country_dial_code),
          mobile: str(p.mobile),
          mobile_country_dial_code: str(p.mobile_country_dial_code),
          address_line_1: str(p.address_line_1),
          address_line_2: str(p.address_line_2),
          city: str(p.city),
          county: str(p.county),
          postcode: str(p.postcode),
          country_code: str(p.country_code),
          internal_patient_id: str(p.internal_patient_id),
          patient_portal_add_payment_method_url: str(p.patient_portal_add_payment_method_url),
        }
      : {}),
    created_at: str(p.created_at),
    updated_at: str(p.updated_at),
  };
}

// Payor on a Booking. The payor's name and type are returned; the person's address, insurance policy
// and authorisation numbers, policy dates and notes only on request.
export function payor(p: Rec, includeContact: boolean) {
  return {
    id: str(p.id),
    payor_type: str(p.payor_type),
    formatted_payor_name: redactContacts(p.formatted_payor_name, includeContact),
    insurance_company_id: str(p.insurance_company_id),
    alternative_payor_id: str(p.alternative_payor_id),
    ...(includeContact
      ? {
          title: str(p.title),
          first_name: str(p.first_name),
          last_name: str(p.last_name),
          formatted_name: str(p.formatted_name),
          address_line_1: str(p.address_line_1),
          address_line_2: str(p.address_line_2),
          city: str(p.city),
          county: str(p.county),
          postcode: str(p.postcode),
          country_code: str(p.country_code),
          insurance_policy_number: str(p.insurance_policy_number),
          insurance_authorization_code: str(p.insurance_authorization_code),
          insurance_policy_start_date: str(p.insurance_policy_start_date),
          insurance_policy_end_date: str(p.insurance_policy_end_date),
          notes: redactContacts(p.notes, includeContact),
        }
      : {}),
  };
}

// Booking. The two information fields are free text that may hold clinical detail, so they are
// withheld by default and only flagged as present; cancellation notes go through the redaction.
export function booking(b: Rec, includeContact: boolean) {
  const obj = (v: unknown): Rec | undefined => (v && typeof v === "object" ? (v as Rec) : undefined);
  const c = obj(b.clinician);
  const s = obj(b.service);
  const l = obj(b.location);
  const p = obj(b.patient);
  const py = obj(b.payor);
  return {
    id: str(b.id),
    status: str(b.status),
    start_time: str(b.start_time),
    end_time: str(b.end_time),
    is_remote: bool(b.is_remote),
    remote_method: str(b.remote_method),
    clinician: c ? { id: str(c.id), display_name: redactContacts(c.display_name, includeContact) } : undefined,
    patient: p ? patient(p, includeContact) : undefined,
    service: s ? { id: str(s.id), name: redactContacts(s.name, includeContact), duration_minutes: num(s.duration_minutes) } : undefined,
    service_variants: Array.isArray(b.service_variants) ? b.service_variants.map((v: Rec) => serviceVariant(v, includeContact)) : [],
    location: l ? { id: str(l.id), name: str(l.name) } : undefined,
    payor: py ? payor(py, includeContact) : undefined,
    notify_patient: bool(b.notify_patient),
    recall_due_date: str(b.recall_due_date),
    recall_programme_id: str(b.recall_programme_id),
    canceled_at: str(b.canceled_at),
    cancellation_reason: str(b.cancellation_reason),
    cancellation_source: str(b.cancellation_source),
    cancellation_information: redactContacts(b.cancellation_information, includeContact),
    ...(includeContact
      ? { information_for_patient: redactContacts(b.information_for_patient, includeContact), information_for_staff_members: redactContacts(b.information_for_staff_members, includeContact) }
      : {
          has_information_for_patient: typeof b.information_for_patient === "string" && b.information_for_patient !== "",
          has_information_for_staff_members: typeof b.information_for_staff_members === "string" && b.information_for_staff_members !== "",
        }),
    created_at: str(b.created_at),
    updated_at: str(b.updated_at),
  };
}

// ClinicianAgendaItem: a booking, availability or unavailability interval.
export function agendaItem(i: Rec, includeContact: boolean) {
  return {
    type: str(i.type),
    start_time: str(i.start_time),
    end_time: str(i.end_time),
    clinician_id: str(i.clinician_id),
    location_id: str(i.location_id),
    room_id: str(i.room_id),
    service_ids: ids(i.service_ids),
    service_variant_ids: ids(i.service_variant_ids),
    booking: i.booking && typeof i.booking === "object" ? booking(i.booking, includeContact) : undefined,
  };
}

// AvailabilitySlot: no personal data.
export function slot(s: Rec) {
  return {
    start_time: str(s.start_time),
    end_time: str(s.end_time),
    clinician_id: str(s.clinician_id),
    service_id: str(s.service_id),
    service_variant_id: str(s.service_variant_id),
    location_id: str(s.location_id),
    room_id: str(s.room_id),
    resource_type: str(s.resource_type),
  };
}

export function invoiceLineItem(li: Rec, includeContact: boolean) {
  return {
    id: str(li.id),
    title: redactContacts(li.title, includeContact),
    quantity: num(li.quantity),
    unit_price: num(li.unit_price),
    net_amount: num(li.net_amount),
    tax_amount: num(li.tax_amount),
    discount_amount: num(li.discount_amount),
    gross_amount: num(li.gross_amount),
    total: num(li.total),
    currency: str(li.currency),
    service_variant_id: str(li.service_variant_id),
    booking_id: str(li.booking_id),
    tax_rate_id: str(li.tax_rate_id),
  };
}

// Invoice. Amounts are minor currency units as documented. The Patient Portal payment link is a URL
// that lets whoever holds it pay this patient's invoice, so it is only returned on request.
export function invoice(inv: Rec, includeContact: boolean) {
  return {
    id: str(inv.id),
    invoice_number: str(inv.invoice_number),
    title: redactContacts(inv.title, includeContact),
    status: str(inv.status),
    currency: str(inv.currency),
    amounts_in: "minor currency units (pence for gbp)",
    total: num(inv.total),
    total_outstanding: num(inv.total_outstanding),
    total_paid: num(inv.total_paid),
    subtotal: num(inv.subtotal),
    tax_amount: num(inv.tax_amount),
    total_discount_amount: num(inv.total_discount_amount),
    supply_date: str(inv.supply_date),
    payor_type: str(inv.payor_type),
    patient_id: str(inv.patient_id),
    clinician_id: str(inv.clinician_id),
    booking_ids: ids(inv.booking_ids),
    invoice_notes: redactContacts(inv.invoice_notes, includeContact),
    ...(includeContact ? { payment_url: str(inv.payment_url) } : {}),
    line_items: Array.isArray(inv.line_items) ? inv.line_items.map((li: Rec) => invoiceLineItem(li, includeContact)) : [],
    created_at: str(inv.created_at),
    updated_at: str(inv.updated_at),
  };
}

export function refund(r: Rec, includeContact: boolean) {
  return {
    id: str(r.id),
    amount: num(r.amount),
    currency: str(r.currency),
    status: str(r.status),
    reason: str(r.reason),
    refund_source: str(r.refund_source),
    succeeded_at: str(r.succeeded_at),
    error: redactContacts(r.error, includeContact),
    next_steps: redactContacts(r.next_steps, includeContact),
    notes: redactContacts(r.notes, includeContact),
    invoice_id: str(r.invoice_id),
    created_at: str(r.created_at),
  };
}

// Payment. payment_method_id (the stored card PaymentMethod that was charged) is never returned:
// this server never reads or charges stored cards.
export function payment(p: Rec, includeContact: boolean) {
  return {
    id: str(p.id),
    status: str(p.status),
    amount: num(p.amount),
    currency: str(p.currency),
    amounts_in: "minor currency units (pence for gbp)",
    paid_at: str(p.paid_at),
    payment_method_type: str(p.payment_method_type),
    payor_type: str(p.payor_type),
    invoice_id: str(p.invoice_id),
    patient_id: str(p.patient_id),
    internal_notes: redactContacts(p.internal_notes, includeContact),
    refunds: Array.isArray(p.refunds) ? p.refunds.map((r: Rec) => refund(r, includeContact)) : [],
    created_at: str(p.created_at),
    updated_at: str(p.updated_at),
  };
}

// HumanTask. The content is staff-written free text and goes through the redaction.
export function humanTask(t: Rec, includeContact: boolean) {
  return {
    id: str(t.id),
    content: redactContacts(t.content, includeContact),
    due_date: str(t.due_date),
    is_urgent: bool(t.is_urgent),
    is_remindable: bool(t.is_remindable),
    is_completed: t.completed_at !== undefined ? t.completed_at !== null : undefined,
    completed_at: str(t.completed_at),
    completed_by_staff_member_id: str(t.completed_by_staff_member_id),
    assignees: Array.isArray(t.assignees) ? t.assignees.map((a: Rec) => ({ assignee_type: str(a.assignee_type), assignee_id: str(a.assignee_id) })) : [],
    patient_id: str(t.patient_id),
    document_id: str(t.document_id),
    creation_source: str(t.creation_source),
    created_at: str(t.created_at),
    updated_at: str(t.updated_at),
  };
}
