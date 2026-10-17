// The AI summary + minutes for a meeting (round 2, CH4). The one place the app asks for a
// summary: the meeting panel calls `summarizeMeeting`, which returns what to store.
//
// It posts the transcript and notes to the site's serverless function
// (oscenia-web/api/meeting-summary.js → DeepSeek, or OpenAI by env var). The key stays on the
// server. When the AI is not connected — no key (503), local dev without the function, no
// network — it falls back to the demo AI summary (lib/meetings.js demoMinutes), labelled as a
// simulation, so the prototype shows what the minutes will look like without a key.
import { demoMinutes } from './meetings.js'

// The root path, so it works with the app served under /erp/.
export const ENDPOINT = '/api/meeting-summary'

// Real AI is switched on at build time (VITE_AI_SUMMARY=on, with DEEPSEEK_API_KEY set in Vercel).
// Off — the prototype's default — the panel goes straight to the demo summary, without a
// request that could only fail.
export const AI_ENABLED = import.meta.env?.VITE_AI_SUMMARY === 'on'

// Under the function's limits (api/meeting-summary.js LIMITS), with room for the rest.
const MAX_LINES = 400
const MAX_CHARS = 16000
/** The latest lines that fit: a long meeting still gets a summary of how it ended. */
export function fit(lines) {
  const out = []
  let size = 0
  for (const l of [...lines].reverse()) {
    size += JSON.stringify(l).length
    if (size > MAX_CHARS || out.length >= MAX_LINES) break
    out.unshift(l)
  }
  return out
}

/** A name the AI wrote back → the id of someone on the call, or null. */
export function ownerIdFor(name, participantIds, members) {
  const n = String(name || '').trim().toLowerCase().replace(/\.$/, '')
  if (!n) return null
  const people = participantIds.map((id) => members.find((m) => m.id === id)).filter(Boolean)
  const full = (m) => m.name.toLowerCase().replace(/\.$/, '')
  const exact = people.find((m) => full(m) === n)
  if (exact) return exact.id
  // "Dinda" for "Dinda A." — only for a one-word answer that names one person.
  if (/\s/.test(n)) return null
  const first = people.filter((m) => full(m).split(/\s+/)[0] === n)
  return first.length === 1 ? first[0].id : null
}

/**
 * → { overview, agenda, discussion, decisions, actionItems, source, provider, model, reason? }
 * `reason` is set when it fell back to the offline minutes and something is worth saying.
 */
export async function summarizeMeeting(meeting, members, { projectName, title, lang = 'en', fetchImpl = globalThis.fetch, delayMs = 1400, useAi = AI_ENABLED } = {}) {
  const name = (id) => members.find((m) => m.id === id)?.name || id
  // The demo takes a moment, as a real AI call would, so the button's "Working…" is seen.
  const offline = async (reason) => {
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs))
    return { ...demoMinutes(meeting, members, projectName, lang), source: 'demo', provider: null, model: null, reason }
  }
  const body = {
    title: title || projectName || 'Meeting',
    date: meeting.startedAt.slice(0, 10),
    participants: meeting.participantIds.map(name),
    transcript: fit(meeting.transcript.map((l) => ({ speaker: name(l.speakerId), text: l.text }))),
    notes: meeting.notes.map((n) => ({ by: name(n.by), text: n.text })),
    lang: lang === 'id' ? 'id' : 'en',
  }
  if (!useAi) return offline(null)
  let res
  try {
    res = await fetchImpl(ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  } catch {
    return offline(null)
  }
  // No function here (local dev serves the app's page instead), or no key: not connected.
  const json = /json/i.test(res.headers?.get?.('content-type') || '') ? await res.json().catch(() => null) : null
  if (!json || res.status === 503 || res.status === 404 || res.status === 405) return offline(null)
  if (!res.ok || !json.summary) return offline(json.error || `The AI service answered ${res.status}.`)
  const s = json.summary
  return {
    overview: s.overview, agenda: s.agenda, discussion: s.discussion, decisions: s.decisions,
    actionItems: (Array.isArray(s.actionItems) ? s.actionItems : []).map((a) => ({ text: a.text, ownerId: ownerIdFor(a.owner, meeting.participantIds, members), due: a.due || null })),
    source: 'ai', provider: json.provider, model: json.model,
  }
}
