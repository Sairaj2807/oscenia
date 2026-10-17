// Writes the answers the prototype's meeting rules give — every seed persona against a meeting
// held in every seed channel (and the access-rule edge cases), in each of the three access modes,
// with and without view-only files — to erp-backend/tests/fixtures/chat_meeting_matrix.json.
//
// The backend ports these rules (app/domain/chat/meeting_rules.py). Replaying the prototype's own
// answers is the check that the two stay one rule book. Re-run after changing lib/meetings.js,
// lib/workspaceAccess.js or the chat seed:   node scripts/export-meeting-fixtures.mjs

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { canManageMeeting, canOpenMeetingFiles, canSeeMeeting, MEETING_ACCESS } from '../src/lib/meetings.js'
import { channelAccess } from '../src/lib/workspaceAccess.js'
import { seedChannels, seedMembers, seedProjectDivisions } from '../src/store/protoSeed.js'

const projects = Object.keys(seedProjectDivisions)
const [gala, wed] = projects

// The same edge channels the access matrix pins, so every branch of canOpenChannel is reached.
const edgeChannels = [
  { id: 'edge-dm', dm: true, memberIds: ['M-02', 'M-05'], name: '', projectId: null },
  { id: 'edge-blocked', name: 'blocked', projectId: gala, access: 'project', blockedIds: ['M-05', 'M-01'] },
  { id: 'edge-invite', name: 'invite', projectId: gala, access: 'invite', memberIds: ['M-06'], listed: true },
  { id: 'edge-moved-off', name: 'moved-off', projectId: wed, access: 'project', memberIds: ['M-10'] },
  { id: 'edge-company-divisions', name: 'design-company', projectId: null, access: 'divisions', divisions: ['Design'] },
]
const channels = [...seedChannels.filter((c) => c.kind !== 'voice'), ...edgeChannels]

const channelOut = channels.map((c) => {
  const a = channelAccess(c)
  return {
    id: c.id, project_id: c.projectId || null, dm: Boolean(c.dm), access: a.access, divisions: a.divisions,
    member_ids: a.memberIds, blocked_ids: a.blockedIds, listed: a.listed,
  }
})

const members = seedMembers.map((m) => ({
  id: m.id, workspace_role: m.workspaceRole, division: m.division || null, project_ids: m.projectIds || [],
}))

// Who was on the call and who the host named is fixed; what varies is where, and the access.
const HOST = 'M-02'
const PARTICIPANTS = ['M-02', 'M-05']
const READERS = ['M-06', 'M-10']

const meetings = []
for (const c of channels) {
  for (const mode of MEETING_ACCESS) {
    for (const viewOnly of [false, true]) {
      const m = {
        id: `${c.id}|${mode}|${viewOnly ? 'view' : 'open'}`,
        channelId: c.id, hostId: HOST, participantIds: PARTICIPANTS,
        access: { mode, extraIds: mode === 'people' ? READERS : [] }, filesViewOnly: viewOnly,
      }
      const ask = (fn) => seedMembers.filter((p) => fn(p, m)).map((p) => p.id)
      meetings.push({
        id: m.id, channel: c.id, host: HOST, participants: PARTICIPANTS, access: m.access.mode,
        readers: m.access.extraIds, files_view_only: viewOnly,
        see: ask((p) => canSeeMeeting(p, m, channels, seedProjectDivisions)),
        manage: ask((p) => canManageMeeting(p, m, channels)),
        files: ask((p) => canOpenMeetingFiles(p, m, channels, seedProjectDivisions)),
      })
    }
  }
}

const out = fileURLToPath(new URL('../../erp-backend/tests/fixtures/chat_meeting_matrix.json', import.meta.url))
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, `${JSON.stringify({ project_divisions: seedProjectDivisions, members, channels: channelOut, meetings }, null, 2)}\n`)
console.log(`wrote ${out}: ${members.length} members x ${meetings.length} meetings`)
