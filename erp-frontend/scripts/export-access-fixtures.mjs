// Writes the answers the prototype's channel-access rules give — every seed persona against
// every seed channel, plus a set of edge-case channels — to
// erp-backend/tests/fixtures/chat_access_matrix.json.
//
// The backend ports these rules (app/domain/chat/access.py). A hand-written expectation would
// agree on the day it was written and drift after; replaying the prototype's own answers is
// the check that the two rule books stay one. Re-run after changing lib/workspaceAccess.js or
// the chat seed:   node scripts/export-access-fixtures.mjs

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  canCreateChannel, canManageChannel, canOpenChannel, channelAccess, discoverableChannels,
} from '../src/lib/workspaceAccess.js'
import { seedChannels, seedMembers, seedProjectDivisions } from '../src/store/protoSeed.js'

const projects = Object.keys(seedProjectDivisions)
const [gala, wed] = projects

// Cases the seed does not reach: each one pins a branch of canOpenChannel.
const edgeCases = [
  // A DM is for its two people — the PM included.
  { id: 'edge-dm', dm: true, memberIds: ['M-05', 'M-06'], name: '', projectId: null },
  // Blocked: out whatever the rule says, but the PM is never blocked.
  { id: 'edge-blocked', name: 'blocked', projectId: gala, access: 'project', blockedIds: ['M-05', 'M-01'] },
  // Let in by name on an invite-only project channel.
  { id: 'edge-invite', name: 'invite', projectId: gala, access: 'invite', memberIds: ['M-06'], listed: true },
  // Named in, but not on the project: moved off it, so the channel is gone.
  { id: 'edge-moved-off', name: 'moved-off', projectId: wed, access: 'project', memberIds: ['M-10'] },
  // Divisions rule on a company channel.
  { id: 'edge-company-divisions', name: 'design-company', projectId: null, access: 'divisions', divisions: ['Design'] },
  // Unlisted: hidden from those who cannot open it, rather than shown locked.
  { id: 'edge-unlisted', name: 'unlisted', projectId: gala, access: 'invite', memberIds: [], listed: false },
  // A voice room follows the same access rule.
  { id: 'edge-voice', kind: 'voice', name: 'room', projectId: gala, access: 'divisions', divisions: ['Production'] },
]

const channels = [...seedChannels, ...edgeCases].map((c) => {
  const a = channelAccess(c)
  return {
    id: c.id,
    project_id: c.projectId || null,
    dm: Boolean(c.dm),
    voice: c.kind === 'voice',
    access: a.access,
    divisions: a.divisions,
    member_ids: a.memberIds,
    blocked_ids: a.blockedIds,
    listed: a.listed,
  }
})
const raw = Object.fromEntries([...seedChannels, ...edgeCases].map((c) => [c.id, c]))

const members = seedMembers.map((m) => ({
  id: m.id,
  workspace_role: m.workspaceRole,
  division: m.division || null,
  project_ids: m.projectIds || [],
}))

const open = {}
const discoverable = {}
const manage = {}
const create = {}
for (const m of seedMembers) {
  open[m.id] = channels.filter((c) => canOpenChannel(m, raw[c.id], seedProjectDivisions)).map((c) => c.id)
  discoverable[m.id] = discoverableChannels(m, Object.values(raw), seedProjectDivisions).map((c) => c.id)
  manage[m.id] = channels.filter((c) => canManageChannel(m, raw[c.id], seedProjectDivisions)).map((c) => c.id)
  create[m.id] = Object.fromEntries([null, ...projects].map((p) => [p ?? 'company', canCreateChannel(m, p, seedProjectDivisions)]))
}

const out = fileURLToPath(new URL('../../erp-backend/tests/fixtures/chat_access_matrix.json', import.meta.url))
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, `${JSON.stringify({ project_divisions: seedProjectDivisions, members, channels, open, discoverable, manage, create }, null, 2)}\n`)
console.log(`wrote ${out}: ${members.length} members x ${channels.length} channels`)
