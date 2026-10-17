// A client's relationships from the server (`/clients/{id}/relations`, `/crm/calendar`), in the shapes the
// CRM screens already draw. The offline demo keeps its own copy of these in the proto store; signed in,
// the server is the record, and these functions are the only place the two shapes meet.

/** `GET /clients/{id}/relations` -> the shape `ClientRelations` reads (`EMPTY_RELATION` plus the log). */
export function adaptRelations(row) {
  const r = row || {}
  return {
    pics: (r.contacts || []).map((c) => ({
      id: c.id,
      name: c.name,
      role: c.role || '',
      phone: c.phone || '',
      email: c.email || '',
      birthday: c.birthday || '',
      greet: c.greet !== false,
      channel: c.channel || 'whatsapp',
    })),
    anniversary: r.anniversary || null,
    greetAnniversary: Boolean(r.greetAnniversary),
    anniversaryChannel: r.anniversaryChannel || 'whatsapp',
    nudgeLeadMonths: r.nudgeLeadMonths ?? 3,
    cycles: (r.cycles || []).map((c) => ({ id: c.id, name: c.name, history: c.history || [] })),
    handledNudges: (r.handledNudges || []).map((h) => h.key),
    outreach: (r.handledNudges || []).map((h) => ({ key: h.key, at: h.handledAt, note: h.note })),
    greetings: (r.greetings || []).map((g) => ({
      id: g.id, kind: g.kind, to: g.to, channel: g.channel, year: g.occasionYear, at: g.markedAt,
    })),
  }
}

/** A contact form's values -> the request body. A blank birthday is sent as null so it clears. */
export function contactBody(pic) {
  return {
    name: String(pic.name || '').trim(),
    role: pic.role || '',
    phone: pic.phone || '',
    email: pic.email || '',
    birthday: pic.birthday ? String(pic.birthday).trim() : null,
    greet: pic.greet !== false,
    channel: pic.channel || 'whatsapp',
  }
}

/** The months a cycle ran, typed as "2024-07, 2025-07" (commas, spaces or new lines) -> a list. */
export function parseMonths(text) {
  return String(text || '')
    .split(/[\s,;]+/)
    .map((m) => m.trim())
    .filter(Boolean)
}

/** One `GET /crm/calendar` item -> the row `RelationshipCalendar` draws (the demo's item shape plus the send links). */
export function adaptCalendarItem(item) {
  const birthday = item.kind === 'Birthday'
  return {
    kind: item.kind,
    // Screens link to a client by its number (`/crm/CL-01`); the uuid is kept for the writes.
    clientId: item.clientNo,
    clientUuid: item.clientId,
    client: item.client,
    date: item.date,
    inDays: item.inDays,
    key: item.key || null,
    title: item.title,
    detail: item.detail || '',
    pic: birthday ? { id: item.picId, greet: item.greet, channel: item.channel } : null,
    greet: Boolean(item.greet),
    channel: item.channel || null,
    alreadySent: Boolean(item.alreadySent),
    message: item.message || null,
    whatsappUrl: item.whatsappUrl || null,
    emailUrl: item.emailUrl || null,
  }
}
