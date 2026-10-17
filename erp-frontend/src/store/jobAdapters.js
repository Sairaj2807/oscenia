// The server's scheduled jobs, their runs and the reminders they raise (backlog item: Daily Jobs).
//
// Pure functions so `verify:adapters` can pin the shapes without a server. The API client has
// already turned snake_case into camelCase by the time these see a row.

const entries = (detail) => Object.entries(detail || {}).filter(([, v]) => v !== null && typeof v !== 'object')

/** One run of a job: `run_for` is the period it was for, so a second run for it is a no-op, not a duplicate. */
export function adaptRun(r) {
  return {
    id: r.id,
    jobKey: r.jobKey,
    runFor: r.runFor,
    status: r.status,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
    // A short, flat summary the card can print ("posted: 3"), never the raw object.
    facts: entries(r.detail).map(([k, v]) => ({ key: k, value: String(v) })),
    failure: r.status === 'failed' ? String(r.detail?.error ?? r.detail?.message ?? 'The run failed.') : null,
    byUser: r.triggeredByUserId ?? null,
  }
}

/** A job as listed: what it is, when it runs, and how its last run went. */
export function adaptJob(j) {
  return {
    key: j.key,
    name: j.name,
    schedule: j.schedule,
    description: j.description,
    lastRun: j.lastRun ? adaptRun(j.lastRun) : null,
  }
}

const KIND_LABEL = {
  birthday: 'Birthday',
  anniversary: 'Anniversary',
  overdue_invoice: 'Overdue invoice',
  asset_return: 'Asset not returned',
}

/** A reminder a job raised for someone to act on. */
export function adaptReminder(r) {
  return {
    id: r.id,
    kind: r.kind,
    kindLabel: KIND_LABEL[r.kind] ?? r.kind,
    subject: r.subject,
    detail: r.detail ?? '',
    clientId: r.clientId ?? null,
    ref: r.ref ?? null,
    dueDate: r.dueDate ?? null,
    status: r.status,
    raisedBy: r.raisedByJob ?? null,
  }
}

/** `GET /ops/summary`: how many jobs, which runs failed, how many reminders are open. */
export function adaptOps(o) {
  return {
    jobs: Number(o.jobs ?? 0),
    failedRuns: (o.failedRuns || []).map(adaptRun),
    openReminders: Number(o.openReminders ?? 0),
  }
}
