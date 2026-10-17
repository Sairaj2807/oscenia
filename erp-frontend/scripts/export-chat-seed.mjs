// Writes the prototype's team-chat seed — the ten people, the four projects they work on, the
// channels (company, per project, per division, the leaders' room, two DMs), the messages with
// their reactions and quotes, and the one pending join request — to
// erp-backend/app/seed/chat_seed.json, which the backend's demo seeder loads.
//
// Exported rather than re-typed, like the events seed: the access rules the prototype's own
// checks assert (who can open what, who sees a locked channel) only hold if the data is
// identical. Re-run after changing src/store/protoSeed.js:   node scripts/export-chat-seed.mjs
//
// Left out because they have no server behind them yet: voice channels. Call-log messages
// (`kind: 'call'`) and the meeting records they point at ARE exported: what a call leaves behind
// (its people, transcript, notes, files and minutes) is stored by the server.

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { channelAccess } from '../src/lib/workspaceAccess.js'
import {
  seedChannels, seedMeetings, seedMembers, seedMessages, seedPresence, seedProjectDivisions,
} from '../src/store/protoSeed.js'
import { seedProjects } from '../src/store/seed.js'

const members = seedMembers.map((m) => ({
  id: m.id,
  name: m.name,
  workspace_role: m.workspaceRole,
  division: m.division || null,
  title: m.title || null,
  project_ids: m.projectIds || [],
}))

const projects = seedProjects.map((p) => ({
  project_no: p.id,
  name: p.name,
  client_name: p.client,
  stage: p.stage,
  division: p.division,
  contract_value: String(p.contractValue),
  estimated_cost: String(p.estimatedCost),
  event_date: p.eventDate,
  stage_since: p.stageSince,
}))

const channels = seedChannels
  .filter((c) => c.kind !== 'voice')
  .map((c) => {
    const a = channelAccess(c)
    return {
      key: c.id,
      name: c.name || '',
      project: c.projectId || null,
      dm: Boolean(c.dm),
      access: a.access,
      divisions: a.divisions,
      member_ids: a.memberIds,
      blocked_ids: a.blockedIds,
      listed: a.listed,
      topic: c.topic || '',
      requests: (c.requests || []).map((r) => ({ member: r.memberId, at: r.at, note: r.note || '', status: r.status })),
    }
  })

const keep = new Set(channels.map((c) => c.key))
const messages = seedMessages
  .filter((m) => (!m.kind || m.kind === 'call') && keep.has(m.channelId))
  .map((m) => ({
    key: m.id,
    channel: m.channelId,
    author: m.authorId,
    at: m.at,
    text: m.text,
    kind: m.kind || 'text',
    meeting: m.meetingId || null,
    reactions: m.reactions || {},
    quote: m.quoteId || null,
  }))

const meetings = seedMeetings
  .filter((m) => keep.has(m.channelId))
  .map((m) => ({
    key: m.id,
    channel: m.channelId,
    host: m.hostId,
    participants: m.participantIds,
    video: m.video,
    started_at: m.startedAt,
    ended_at: m.endedAt,
    access: m.access.mode,
    readers: m.access.extraIds,
    files_view_only: m.filesViewOnly,
    transcript: m.transcript.map((l) => ({ at: l.at, speaker: l.speakerId, text: l.text })),
    notes: m.notes.map((n) => ({ by: n.by, at: n.at, text: n.text })),
    files: m.files.map((f) => ({ name: f.name, kind: f.kind, size: f.size, by: f.by, at: f.at })),
    summary: m.summary && {
      overview: m.summary.overview,
      agenda: m.summary.agenda,
      discussion: m.summary.discussion,
      decisions: m.summary.decisions,
      action_items: m.summary.actionItems.map((a) => ({ text: a.text, owner: a.ownerId || null, due: a.due || null })),
      source: m.summary.source,
      at: m.summary.at,
      by: m.summary.by,
    },
  }))

const out = fileURLToPath(new URL('../../erp-backend/app/seed/chat_seed.json', import.meta.url))
mkdirSync(dirname(out), { recursive: true })
writeFileSync(
  out,
  `${JSON.stringify({
    members,
    projects,
    project_divisions: seedProjectDivisions,
    channels,
    messages,
    meetings,
    presence: seedPresence,
    // The prototype starts everyone caught up to the end of 24 Jul, so only the last two days
    // show as unread (useProto.js, `lastRead`).
    read_through: '2026-07-24T23:59',
  }, null, 2)}\n`,
)
console.log(`wrote ${out}: ${members.length} people, ${projects.length} projects, ${channels.length} channels, ${messages.length} messages, ${meetings.length} meetings`)
