// Verifies the live-chat client layer under Node: the adapters, the event reducers and the
// socket client — everything that can be checked without a browser or a server.
//
//   npm run verify:chat      (vite-node, so the ESM imports resolve like they do in the app)
//
// The heart of it is "agreement". The server decides who can open which channel; the screens
// ALSO run the prototype's own rules over what it sends. If those two ever disagree, a channel
// you were let into vanishes from your sidebar (or one you were kept out of appears). The
// access matrix the backend's tests already proved against the server
// (erp-backend/tests/fixtures/chat_access_matrix.json) is replayed here: for every person, build
// what the server would send, adapt it, run the client's rules, and demand the same answers.

import { readFileSync } from 'node:fs'
import { mock } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  adaptBootstrap, adaptChannel, adaptMember, adaptMessage, adaptNotification, adaptPresence,
  makeContext, nowWall, wall, bySeq, adaptMeeting, mergeMeeting, upsertMeeting,
} from '../src/store/chatAdapters.js'
import {
  applyChannelRemoved, applyMessageEvent, mergeMessages, pruneTyping, reduceEvent, sortMessages,
  upsertMessage,
} from '../src/store/chatEvents.js'
import { createChatSocket, CLOSE } from '../src/lib/chatSocket.js'
import { adaptNotifications, readReadState } from '../src/store/useNotifications.js'
import { isUnread, sortNotifications } from '../src/lib/notifications.js'
import { adaptTask, removeTask, upsertTask, whyRefused } from '../src/store/taskAdapters.js'
import { fileUrl } from '../src/lib/api.js'
import { discoverableChannels, memberProjectIds, visibleChannels } from '../src/lib/workspaceAccess.js'

let passed = 0
const failures = []
function check(label, ok, detail = '') {
  if (ok) passed += 1
  else failures.push(`${label}${detail ? ` — ${detail}` : ''}`)
}
const section = (name) => console.log(`\n${name}`)
const same = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort())

// ---------------------------------------------------------------------------
section('time')
check('Jakarta wall clock', wall('2026-07-24T04:00:00Z') === '2026-07-24T11:00')
check('across midnight', wall('2026-07-23T17:00:00Z') === '2026-07-24T00:00')
check('offset form', wall('2026-07-24T11:00:00+07:00') === '2026-07-24T11:00')
check('empty and junk', wall(null) === '' && wall('nonsense') === '')
check('now is in the same format', /^\d{4}-\d\d-\d\dT\d\d:\d\d$/.test(nowWall()))

// ---------------------------------------------------------------------------
section('agreement with the server, for every person and every channel')
const matrix = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../erp-backend/tests/fixtures/chat_access_matrix.json', import.meta.url)), 'utf8'),
)
const PD = matrix.project_divisions
const channelsAll = matrix.channels.filter((c) => !c.voice) // voice rooms have no server yet
const uuid = (no) => `u-${no}`
const mem = Object.fromEntries(matrix.members.map((m) => [m.id, m]))

function projectsOf(member) {
  if (member.workspace_role === 'pm') return Object.keys(PD)
  if (member.workspace_role === 'leader') return Object.keys(PD).filter((p) => PD[p].includes(member.division))
  return member.project_ids
}

function serverBootstrap(meNo) {
  const me = mem[meNo]
  const memberOut = (m) => ({
    id: uuid(m.id), memberNo: m.id, name: m.id, initials: 'XX', workspaceRole: m.workspace_role,
    division: m.division, title: null, projectIds: projectsOf(m),
  })
  const canManage = new Set(matrix.manage[meNo])
  const out = (c, locked) => {
    const manages = canManage.has(c.id)
    const dmWith = c.dm ? c.member_ids.find((x) => x !== meNo) : null
    return {
      id: c.id, key: c.id, projectId: c.project_id, projectNo: c.project_id, name: c.dm ? '' : c.id,
      topic: '', access: c.access, divisions: c.divisions, listed: c.listed, isDm: c.dm,
      dmWith: dmWith ? uuid(dmWith) : null, locked, canManage: manages,
      // What the server sends: the lists only to someone who can manage the channel.
      memberIds: manages && !c.dm ? c.member_ids.map(uuid) : null,
      blockedIds: manages && !c.dm ? c.blocked_ids.map(uuid) : null,
      myRequest: null, rev: 5, lastReadSeq: 0, unread: 0, unreadMentions: 0,
    }
  }
  const byId = Object.fromEntries(channelsAll.map((c) => [c.id, c]))
  return {
    me: memberOut(me),
    members: matrix.members.map(memberOut),
    projects: projectsOf(me).map((id) => ({ id, name: id, projectNo: id, divisions: PD[id] })),
    channels: matrix.open[meNo].filter((id) => byId[id]).map((id) => out(byId[id], false)),
    discoverable: matrix.discoverable[meNo].filter((id) => byId[id]).map((id) => out(byId[id], true)),
    presence: {}, myStatus: 'online',
  }
}

for (const meNo of Object.keys(mem)) {
  const a = adaptBootstrap(serverBootstrap(meNo))
  const persona = a.members.find((m) => m.id === meNo)
  const open = visibleChannels(persona, a.channels, a.projectDivisions).map((c) => c.id)
  const locked = discoverableChannels(persona, a.channels, a.projectDivisions).map((c) => c.id)
  const wantOpen = matrix.open[meNo].filter((id) => channelsAll.some((c) => c.id === id))
  const wantLocked = matrix.discoverable[meNo].filter((id) => channelsAll.some((c) => c.id === id))
  check(`${meNo} can open exactly what the server says`, same(open, wantOpen), `client ${open.length} vs server ${wantOpen.length}: ${open.filter((x) => !wantOpen.includes(x))} / ${wantOpen.filter((x) => !open.includes(x))}`)
  check(`${meNo} sees locked exactly what the server says`, same(locked, wantLocked), `client ${locked} vs server ${wantLocked}`)
  check(`${meNo}: the server's own list of channels is what the sidebar shows`, a.channels.length === wantOpen.length + wantLocked.length)
  check(`${meNo}: projects agree`, same(memberProjectIds(persona, a.projectDivisions), projectsOf(mem[meNo])))
}

// ---------------------------------------------------------------------------
section('people, channels, messages')
const members = [
  { id: 'u1', memberNo: 'M-05', name: 'Rina M.', initials: 'RM', workspaceRole: 'staff', division: 'Field', title: 'Stage Manager', projectIds: ['p1'] },
  { id: 'u2', memberNo: 'M-02', name: 'Dinda A.', initials: 'DA', workspaceRole: 'leader', division: 'Field', title: null, projectIds: [] },
].map(adaptMember)
const ctx = makeContext('u1', members)
check('a member is keyed by member number and keeps the uuid', members[0].id === 'M-05' && members[0].uuid === 'u1')
check('context maps both ways', ctx.meNo === 'M-05' && ctx.noOf('u2') === 'M-02' && ctx.uuidOf('M-02') === 'u2')
check('an unknown uuid stays itself rather than vanishing', ctx.noOf('ghost') === 'ghost')

const dm = adaptChannel({ id: 'c3', name: '', access: 'project', isDm: true, dmWith: 'u2', locked: false }, ctx)
check('a DM is its two members, sorted', JSON.stringify(dm.memberIds) === '["M-02","M-05"]' && dm.dm === true)
const lockedCh = adaptChannel({ id: 'c2', name: 'prod', access: 'divisions', divisions: ['Production'], isDm: false, locked: true, myRequest: 'pending', listed: true }, ctx)
check('a locked channel does not list me, and carries my request', !lockedCh.memberIds.includes('M-05') && lockedCh.requests[0].status === 'pending' && lockedCh.requests[0].memberId === 'M-05')
const openInvite = adaptChannel({ id: 'c1', name: 'ops', access: 'invite', divisions: [], isDm: false, locked: false, memberIds: null }, ctx)
check('an invite-only channel I can open lists me (so the client rules agree)', openInvite.memberIds.includes('M-05'))

const raw = { id: 'm1', channelId: 'c1', authorId: 'u2', authorNo: 'M-02', text: 'hi <@M-05>', kind: 'text', createdAt: '2026-07-24T04:00:00Z', editedAt: null, reactions: { '👍': ['u1', 'u2'], '🙌': [] }, seq: 3, rev: 4, quoteId: null, deleted: false, mentions: ['u1'], attachments: [{ id: 'a1', filename: 'x.pdf', contentType: 'application/pdf', sizeBytes: 10, url: '/f' }], clientMsgId: null }
const msg = adaptMessage(raw, ctx)
check('a message reads as the screens expect', msg.authorId === 'M-02' && msg.at === '2026-07-24T11:00' && msg.text === 'hi <@M-05>' && msg.deleted === false && msg.parentId === null)
check('reactions are keyed by member number, and empty ones dropped', JSON.stringify(msg.reactions) === '{"👍":["M-05","M-02"]}')
check('an ordinary message has no kind (that is what lets you edit it)', msg.kind === undefined)
check('attachments carry their link, on the API’s own origin (the page may be served elsewhere)',
  /^https?:\/\/[^/]+\/f$/.test(msg.attachments[0].url) && msg.attachments[0].filename === 'x.pdf')
check('a link that is already a full address is left alone', fileUrl('https://files.example/x') === 'https://files.example/x' && fileUrl('') === '')
check('presence is by member number and shows my chosen status', JSON.stringify(adaptPresence({ u2: 'idle' }, 'dnd', ctx)) === '{"M-02":"idle","M-05":"dnd"}')
check('a notification keeps its read flag', adaptNotification({ id: 'n', kind: 'Mentioned you', at: '2026-07-24T04:00:00Z', title: 't', body: 'b', to: '/chat/x', read: false }).read === false)

// ---------------------------------------------------------------------------
section('ordering and duplicates')
const mk = (id, seq, rev, extra = {}) => ({ id, channelId: 'c1', seq, rev, at: '2026-07-24T11:00', text: id, reactions: {}, ...extra })
check('seq orders a channel even within one minute', [mk('b', 2, 2), mk('a', 1, 1)].sort(bySeq)[0].id === 'a')
check('a message still being sent sorts last', [mk('p', undefined, undefined, { pending: true }), mk('a', 9, 9)].sort(bySeq)[1].id === 'p')
let list = mergeMessages([], [mk('a', 1, 1), mk('b', 2, 2)])
check('merging keeps order', list.map((m) => m.id).join() === 'a,b')
check('an older or equal copy changes nothing', upsertMessage(list, mk('b', 2, 2, { text: 'STALE' })) === list)
check('a newer copy replaces it', upsertMessage(list, mk('b', 2, 3, { text: 'new' })).find((m) => m.id === 'b').text === 'new')
const pend = [mk('pending-x', undefined, undefined, { pending: true, clientMsgId: 'x' })]
const resolved = upsertMessage(pend, mk('m9', 5, 5, { clientMsgId: 'x' }))
check('the server copy replaces the pending one (no duplicate)', resolved.length === 1 && resolved[0].id === 'm9' && !resolved[0].pending)
check('messages from two channels stay grouped', sortMessages([{ ...mk('z', 1, 1), channelId: 'c2' }, mk('a', 1, 1)]).map((m) => m.channelId).join() === 'c1,c2')

// ---------------------------------------------------------------------------
section('what the server tells us, applied')
const baseChannel = (over = {}) => ({ ...adaptChannel({ id: 'c1', name: 'general', access: 'project', divisions: [], listed: true, isDm: false, locked: false, rev: 10, lastReadSeq: 10, unread: 0, unreadMentions: 0 }, ctx), ...over })
const state0 = () => ({
  ctx, meNo: 'M-05', meUuid: 'u1', openChannelId: null, channels: [baseChannel()], messages: [], loaded: {},
  presence: {}, typing: {}, notifications: [],
})
const ev = (type, over = {}) => ({ type, channelId: 'c1', rev: 11, message: { ...raw, id: 'm11', seq: 11, rev: 11, authorId: 'u2', authorNo: 'M-02', mentions: [] }, ...over })

let out = applyMessageEvent(state0(), ev('message.new'))
check('someone else\'s message in a channel I am not looking at is unread', out.patch.channels[0].unread === 1 && out.patch.channels[0].rev === 11)
check('...and is not stored while the channel is not loaded', out.patch.messages === undefined)
out = applyMessageEvent({ ...state0(), loaded: { c1: {} } }, ev('message.new'))
check('in a loaded channel it is added', out.patch.messages.length === 1)
out = applyMessageEvent({ ...state0(), openChannelId: 'c1', loaded: { c1: {} } }, ev('message.new'))
check('in the channel I have open it does not count as unread', out.patch.channels[0].unread === 0)
out = applyMessageEvent(state0(), ev('message.new', { message: { ...raw, id: 'm12', seq: 12, rev: 11, authorId: 'u2', authorNo: 'M-02', mentions: ['u1'] } }))
check('a mention of me counts separately', out.patch.channels[0].unreadMentions === 1)
out = applyMessageEvent(state0(), ev('message.new', { message: { ...raw, id: 'm13', authorId: 'u1', authorNo: 'M-05', rev: 11, mentions: [] } }))
check('my own message never counts as unread', out.patch.channels[0].unread === 0)
out = applyMessageEvent({ ...state0(), loaded: { c1: {} } }, ev('message.new', { rev: 14 }))
check('a skipped revision is reported as a gap to sync', JSON.stringify(out.needsSync) === '["c1"]')
const withMsg = { ...state0(), loaded: { c1: {} }, messages: [adaptMessage({ ...raw, id: 'm11', seq: 11, rev: 11 }, ctx)] }
check('the same event twice does nothing', applyMessageEvent(withMsg, ev('message.updated')) === null)
check('an event for a channel I do not have is ignored', applyMessageEvent(state0(), ev('message.new', { channelId: 'nope' })) === null)

out = reduceEvent(state0(), { type: 'read.updated', channelId: 'c1', lastReadSeq: 10 })
check('reading elsewhere updates the marker', out.patch.channels[0].lastReadSeq === 10)
out = reduceEvent({ ...state0(), channels: [baseChannel({ unread: 3, unreadMentions: 1 })] }, { type: 'read.updated', channelId: 'c1', lastReadSeq: 10 })
check('caught up on another device clears the badge', out.patch.channels[0].unread === 0 && out.patch.channels[0].unreadMentions === 0)

const newChannel = { id: 'c9', name: 'ops', access: 'invite', divisions: [], listed: true, isDm: false, locked: true, canManage: false, rev: 0, unread: 0, unreadMentions: 0, lastReadSeq: 0 }
out = reduceEvent(state0(), { type: 'channel.created', channel: newChannel })
check('a new channel appears, as locked if it is', out.patch.channels.length === 2 && out.patch.channels[1].locked === true)
out = reduceEvent(state0(), { type: 'channel.updated', channel: { ...newChannel, id: 'c1', name: 'renamed', locked: false } })
check('an updated channel is replaced in place', out.patch.channels.length === 1 && out.patch.channels[0].name === 'renamed')
const removed = applyChannelRemoved({ ...state0(), loaded: { c1: {} }, messages: [mk('a', 1, 1)] }, { channelId: 'c1' })
check('a removed channel takes its messages and load state with it', removed.patch.channels.length === 0 && removed.patch.messages.length === 0 && !('c1' in removed.patch.loaded))

out = reduceEvent(state0(), { type: 'presence', userId: 'u2', status: 'idle' })
check('presence is by member number', out.patch.presence['M-02'] === 'idle')
out = reduceEvent({ ...state0(), presence: { 'M-02': 'idle' } }, { type: 'presence', userId: 'u2', status: 'offline' })
check('offline removes the entry', !('M-02' in out.patch.presence))
out = reduceEvent(state0(), { type: 'typing', channelId: 'c1', userId: 'u2' }, 1000)
check('typing expires on its own', out.patch.typing.c1['M-02'] === 6000 && pruneTyping(out.patch.typing, 7000) !== null && Object.keys(pruneTyping(out.patch.typing, 7000)).length === 0 && pruneTyping(out.patch.typing, 2000) === null)
check('my own typing is not shown to me', reduceEvent(state0(), { type: 'typing', channelId: 'c1', userId: 'u1' }) === null)
out = reduceEvent(state0(), { type: 'notification.new', notification: { id: 'n1', kind: 'Mentioned you', at: '2026-07-24T04:00:00Z', title: 't', body: 'b', to: '/chat/c1', read: false } })
check('a notification is added once', out.patch.notifications.length === 1 && reduceEvent({ ...state0(), notifications: out.patch.notifications }, { type: 'notification.new', notification: { id: 'n1', kind: 'Mentioned you', at: 'x', title: 't', body: 'b', to: '/', read: false } }) === null)
check('an unknown frame is ignored, not a crash', reduceEvent(state0(), { type: 'from.the.future' }) === null)

// ---------------------------------------------------------------------------
section('the socket client')
mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })

class FakeWS {
  static instances = []
  constructor(url) { this.url = url; this.readyState = 0; this.sent = []; FakeWS.instances.push(this) }
  send(data) { this.sent.push(JSON.parse(data)) }
  close(code = 1000) { if (this.readyState === 3) return; this.readyState = 3; this.closed = code; queueMicrotask(() => this.onclose?.({ code })) }
  open() { this.readyState = 1; this.onopen?.() }
  receive(frame) { this.onmessage?.({ data: JSON.stringify(frame) }) }
  drop(code) { this.readyState = 3; this.onclose?.({ code }) }
}
const flush = async () => { for (let i = 0; i < 5; i += 1) await Promise.resolve() }
function harness(over = {}) {
  FakeWS.instances = []
  const log = { states: [], frames: [], opens: [], refreshes: 0 }
  const sock = createChatSocket({
    url: () => 'ws://x/api/v1/chat/ws',
    getToken: () => 'tok',
    refreshSession: async () => { log.refreshes += 1; if (over.refreshFails) throw new Error('signed out') },
    onFrame: (f) => log.frames.push(f),
    onState: (s, info) => log.states.push(s),
    onOpen: (h) => log.opens.push(h),
    WebSocketImpl: FakeWS,
  })
  return { sock, log }
}
const connectOk = async (h) => {
  h.sock.start(); await flush()
  const ws = FakeWS.instances.at(-1)
  ws.open()
  ws.receive({ type: 'hello', user_id: 'u1', server_time: '2026-07-24T04:00:00Z', heartbeat_s: 25, presence: {} })
  await flush()
  return ws
}

{
  const h = harness()
  h.sock.start(); await flush()
  const ws = FakeWS.instances[0]
  ws.open()
  check('the first frame it sends is the token, not a URL parameter', ws.sent[0].op === 'auth' && ws.sent[0].token === 'tok' && !ws.url.includes('tok'))
  ws.receive({ type: 'hello', user_id: 'u1', presence: { 'u-1': 'online' } })
  await flush()
  check('hello opens the connection and is handed up camelCased', h.log.states.at(-1) === 'open' && h.log.opens[0].userId === 'u1')
  ws.receive({ type: 'message.new', channel_id: 'c1', rev: 3, message: { created_at: 'x', author_no: 'M-02' } })
  check('frames reach the owner with camelCase keys', h.log.frames[0].channelId === 'c1' && h.log.frames[0].message.authorNo === 'M-02')
  ws.receive({ type: 'pong' })
  check('pongs are not passed up', h.log.frames.length === 1)
  mock.timers.tick(25_000)
  check('it pings every 25 seconds', ws.sent.filter((f) => f.op === 'ping').length === 1)
  h.sock.typing('c1'); h.sock.activity('idle')
  check('typing and presence go out in the server\'s own field names', ws.sent.some((f) => f.op === 'typing' && f.channel_id === 'c1') && ws.sent.some((f) => f.op === 'presence' && f.state === 'idle'))
  h.sock.stop()
  check('stop closes it for good', h.log.states.at(-1) === 'closed' && ws.closed === 1000)
}
{
  const h = harness()
  const ws = await connectOk(h)
  ws.drop(1006)
  check('a lost connection is reported as reconnecting', h.log.states.at(-1) === 'reconnecting')
  mock.timers.tick(1_000)
  await flush()
  check('and it comes back by itself', FakeWS.instances.length === 2)
  h.sock.stop()
}
{
  const h = harness()
  const ws = await connectOk(h)
  ws.drop(CLOSE.FORBIDDEN)
  mock.timers.tick(60_000); await flush()
  check('"not allowed" (4403) stops it for good', h.log.states.at(-1) === 'forbidden' && FakeWS.instances.length === 1)
}
{
  const h = harness()
  const ws = await connectOk(h)
  ws.drop(CLOSE.NOT_LEADER)
  mock.timers.tick(5_000); await flush()
  check('"this is not the chat server" (1013) waits long before trying again', FakeWS.instances.length === 1)
  mock.timers.tick(11_000); await flush()
  check('...then does', FakeWS.instances.length === 2)
  h.sock.stop()
}
{
  const h = harness()
  await connectOk(h)
  for (let i = 0; i < 6; i += 1) {
    const ws = FakeWS.instances.at(-1)
    ws.drop(CLOSE.BAD_AUTH)
    mock.timers.tick(1_000); await flush()
    const next = FakeWS.instances.at(-1)
    if (next !== ws) next.open()
  }
  check('bad credentials are retried a few times and then given up on', h.log.states.at(-1) === 'closed' && FakeWS.instances.length <= 5)
  check('each retry asks for a fresh session first', h.log.refreshes >= 2)
}
{
  const h = harness()
  const ws = await connectOk(h)
  mock.timers.tick(61_000)
  check('a connection that has gone silent for a minute is closed', ws.closed !== undefined)
  h.sock.stop()
}
{
  const h = harness()
  h.sock.start(); await flush()          // connecting: the socket exists but has not opened
  h.sock.nudge(); await flush()
  mock.timers.tick(1); await flush()
  check('nudging while a connection is still opening does not start a second one', FakeWS.instances.length === 1)
  h.sock.stop()
}
{
  const h = harness()
  await connectOk(h)
  const first = FakeWS.instances.at(-1)
  first.drop(1006)
  h.sock.nudge(); await flush(); mock.timers.tick(1); await flush()
  const open = FakeWS.instances.filter((w) => w.readyState === 1 || w.readyState === 0)
  check('a reconnect never leaves the old socket open beside the new one', open.length <= 1)
  h.sock.stop()
}
{
  const h = harness({ refreshFails: true })
  h.sock.start(); await flush()
  check('signed out (no session to refresh): it does not open a socket', FakeWS.instances.length === 0)
  h.sock.stop()
}
mock.timers.reset()

// ---------------------------------------------------------------------------
section('the bell: events and CRM items from /notifications')
{
  const raw = [
    { id: 'rem:1', kind: 'Birthday', at: '2026-07-26T01:00:00Z', title: 'Birthday · A', body: 'today', to: '/crm/CL-05', read: null },
    { id: 'rsvp:1:x', kind: 'New RSVP', at: '2026-07-26T05:00:00Z', title: 'Dewi', body: 'Gala', to: '/events/EV-1?tab=guests', read: null },
    { id: 'review:EV-2:x', kind: 'Invitation to review', at: '2026-07-24T05:00:00Z', title: 'Year-end', body: 'Ready to publish for the first time', to: '/events/EV-2?tab=invitation', read: null },
  ]
  const got = adaptNotifications(raw)
  check('times become Jakarta wall clock', got.find((i) => i.id === 'rsvp:1:x').at === '2026-07-26T12:00')
  check('things to act on come first, even when older', got[0].kind === 'Invitation to review')
  check('the rest are newest first', got[1].id === 'rsvp:1:x' && got[2].id === 'rem:1')
  check('read stays null: this browser keeps it', got.every((i) => i.read === null))
  check('empty and missing lists are fine', adaptNotifications([]).length === 0 && adaptNotifications(undefined).length === 0)
  check('sorting does not change its input', (() => { const a = [raw[0], raw[2]]; sortNotifications(a); return a[0] === raw[0] })())

  const mem = (() => { const m = {}; return { getItem: (k) => m[k] ?? null, setItem: (k, v) => { m[k] = v } } })()
  check('no saved state: nothing is read yet', JSON.stringify(readReadState('u1', mem)) === JSON.stringify({ seenAt: '', ids: [] }))
  mem.setItem('oscenia.notif.read.u1', JSON.stringify({ seenAt: '2026-07-26T10:00', ids: ['rsvp:1:x'] }))
  const st = readReadState('u1', mem)
  check('read state is per person', readReadState('u2', mem).ids.length === 0)
  check('older than "mark all read" is read', !isUnread({ id: 'rem:1', at: '2026-07-26T08:00' }, st))
  check('a newer item is unread', isUnread({ id: 'rsvp:2:y', at: '2026-07-26T11:00' }, st))
  check('an item opened since is read', !isUnread({ id: 'rsvp:1:x', at: '2026-07-26T11:00' }, st))
  mem.setItem('oscenia.notif.read.u3', '{not json')
  check('unreadable saved state starts clean', readReadState('u3', mem).ids.length === 0)
}

// ---------------------------------------------------------------------------
section('meetings: what a call left behind')
{
  const members = [
    { id: 'M-02', uuid: 'u-2', name: 'Dinda A.' }, { id: 'M-05', uuid: 'u-5', name: 'Rina M.' },
  ]
  const ctx = makeContext('u-5', members)
  const brief = (over = {}) => ({
    id: 'mt-1', channelId: 'c1', logChannelId: 'c1', video: true,
    startedAt: '2026-07-24T09:27:00Z', endedAt: '2026-07-24T09:45:00Z', hostId: 'u-2',
    participantIds: ['u-2', 'u-5'], access: 'participants', filesViewOnly: false, hasSummary: true,
    summaryPostedAt: null, canRead: true, canManage: false, canOpenFiles: true, canPostSummary: false, ...over,
  })
  const full = brief({
    readerIds: [], transcript: [{ at: '2026-07-24T09:28:00Z', speakerId: 'u-2', text: 'Hello' }],
    notes: [{ id: 'n1', authorId: 'u-5', at: '2026-07-24T09:30:00Z', text: 'Get it in writing' }],
    files: [{ id: 'f1', filename: 'plan.pdf', kind: 'pdf', sizeBytes: 100, uploaderId: 'u-2', at: '2026-07-24T09:31:00Z' }],
    summary: { overview: 'o', agenda: [], discussion: [], decisions: ['d'], source: 'ai', provider: 'deepseek', model: 'm', at: '2026-07-24T10:00:00Z', by: 'u-2',
      actionItems: [{ text: 'Call', ownerId: 'u-5', due: '2026-07-25' }, { text: 'Book', ownerId: null, due: null }] },
  })

  const b = adaptMeeting(brief(), ctx)
  check('people become member numbers, times Jakarta wall clock', b.hostId === 'M-02' && b.participantIds.join() === 'M-02,M-05' && b.startedAt === '2026-07-24T16:27')
  check('a brief has no body: those keys are left off', !('transcript' in b) && !('summary' in b) && b.detail === false)
  check('and says what the caller may do', b.canRead && !b.canManage && b.hasSummary && b.access.mode === 'participants')

  const f = adaptMeeting(full, ctx)
  check('a full meeting carries what was said', f.detail && f.transcript[0].speakerId === 'M-02' && f.transcript[0].at === '2026-07-24T16:28')
  check('notes and files in the prototype’s shape', f.notes[0].by === 'M-05' && f.files[0].name === 'plan.pdf' && f.files[0].size === 100)
  check('action items keep owners (as member numbers) and dates', f.summary.actionItems[0].ownerId === 'M-05' && f.summary.actionItems[1].ownerId === null && f.summary.source === 'ai')

  const merged = mergeMeeting(f, adaptMeeting(brief({ summaryPostedAt: '2026-07-24T11:00:00Z' }), ctx))
  check('a brief merged over a full meeting keeps what was read', merged.detail && merged.transcript.length === 1 && merged.summary.overview === 'o')
  check('and takes the brief’s news', merged.summaryPostedAt === '2026-07-24T18:00')
  const lost = mergeMeeting(f, adaptMeeting(brief({ canRead: false, hasSummary: false }), ctx))
  check('losing access takes the minutes with it', !lost.detail && lost.transcript.length === 0 && lost.summary === null && lost.notes.length === 0)
  const first = mergeMeeting(null, adaptMeeting(brief({ canRead: false }), ctx))
  check('a meeting you cannot read starts empty', first.detail === false && first.transcript.length === 0)

  const earlier = adaptMeeting(brief({ id: 'mt-0', startedAt: '2026-07-23T09:00:00Z' }), ctx)
  const list = upsertMeeting(upsertMeeting([], b), earlier)
  check('meetings are kept oldest first, one per id', list.map((m) => m.id).join() === 'mt-0,mt-1')
  check('upserting the same one replaces, not duplicates', upsertMeeting(list, adaptMeeting(brief({ video: false }), ctx)).length === 2)
  check('a call line carries its meeting', adaptMessage({ id: 'm', channelId: 'c1', createdAt: '2026-07-24T09:45:00Z', text: 'Video call', kind: 'call', meetingId: 'mt-1', authorId: 'u-2', reactions: {} }, ctx).meetingId === 'mt-1')
}

// ---------------------------------------------------------------------------
section('tasks: the server’s task becomes the prototype’s, and projects carry both ids')
{
  const members = [
    { id: 'u-2', memberNo: 'M-02', name: 'Dinda A.', initials: 'DA', workspaceRole: 'leader', division: 'Field', projectIds: [] },
    { id: 'u-5', memberNo: 'M-05', name: 'Rina M.', initials: 'RM', workspaceRole: 'staff', division: 'Field', projectIds: ['p-gala'] },
  ]
  const projects = [
    { id: 'p-gala', projectNo: 'EVT-2026-GALA-01', name: 'Gala', divisions: ['Field'], clientName: 'Aurora Bank', eventDate: '2026-08-14', stage: 'Execution Event', pmName: 'Dinda A.' },
    { id: 'p-wed', projectNo: 'EVT-2026-WED-02', name: 'Wedding', divisions: ['Design', 'Field'], clientName: null, eventDate: null, stage: 'DP Paid', pmName: null },
  ]
  const boot = adaptBootstrap({
    me: members[1], members, projects, channels: [], discoverable: [], presence: {}, myStatus: 'online',
  })
  const rina = boot.members.find((m) => m.id === 'M-05')
  check('a member’s projects carry the uuid and the business number', rina.projectIds.join() === 'p-gala,EVT-2026-GALA-01')
  check('divisions are keyed both ways, with the same answer', boot.projectDivisions['p-wed'].join() === 'Design,Field' && boot.projectDivisions['EVT-2026-WED-02'].join() === 'Design,Field')
  check('so the prototype’s rules work on the business number', memberProjectIds(rina, boot.projectDivisions).includes('EVT-2026-GALA-01'))
  check('a leader reaches a project by division, under either id', memberProjectIds(boot.members[0], boot.projectDivisions).includes('EVT-2026-WED-02'))
  check('project cards carry client, date, stage and PIC, and blanks where not on file',
    boot.chatProjects[0].client === 'Aurora Bank' && boot.chatProjects[0].pm === 'Dinda A.' && boot.chatProjects[1].client === '' && boot.chatProjects[1].eventDate === '')

  const raw = {
    id: 'tid-1', taskNo: 'T-405', projectId: 'p-gala', projectNo: 'EVT-2026-GALA-01', division: 'Field', title: 'Rigging', description: 'Before load-in',
    assigneeId: 'u-5', assigneeNo: 'M-05', assignedById: 'u-2', assignedByNo: 'M-02', assignedAt: '2026-07-26T03:00:00Z', deadline: '2026-08-30',
    priority: 'High', status: 'Leader approved', blockerReason: '', rev: 4, overdue: false, myStage: 'pm', completedAt: null,
    approvals: { leader: { byId: 'u-2', byNo: 'M-02', at: '2026-07-26T05:00:00Z' } },
    activity: [{ at: '2026-07-26T03:00:00Z', byId: 'u-2', byNo: 'M-02', kind: 'assign', text: 'assigned' }],
    attachments: [{ id: 'f1', filename: 'plan.pdf', kind: 'pdf', sizeBytes: 100, uploaderId: 'u-5', uploaderNo: null, createdAt: '2026-07-26T04:00:00Z' }],
  }
  const t = adaptTask(raw, boot.ctx)
  check('a task is keyed by its number and its project’s business number', t.id === 'T-405' && t.projectId === 'EVT-2026-GALA-01' && t.projectUuid === 'p-gala')
  check('people become member numbers, times Jakarta wall clock', t.assigneeId === 'M-05' && t.assignedById === 'M-02' && t.assignedAt === '2026-07-26T10:00')
  check('approvals keep who and when', t.approvals.leader.by === 'M-02' && t.approvals.leader.at === '2026-07-26T12:00' && !t.approvals.pm)
  check('history and files in the prototype’s shape (a missing number falls back to the uuid lookup)',
    t.activity[0].text === 'assigned' && t.activity[0].by === 'M-02' && t.attachments[0].name === 'plan.pdf' && t.attachments[0].by === 'M-05')
  check('what the server adds comes along', t.rev === 4 && t.myStage === 'pm' && t.overdue === false && t.completedAt === null)

  const older = { ...t, rev: 3, status: 'Submitted' }
  check('a stale version never replaces a newer one', upsertTask([t], older)[0].status === 'Leader approved')
  check('a newer one does', upsertTask([t], { ...t, rev: 5, status: 'PM approved' })[0].status === 'PM approved')
  const second = adaptTask({ ...raw, id: 'tid-2', taskNo: 'T-406', assignedAt: '2026-07-25T03:00:00Z' }, boot.ctx)
  check('tasks are kept oldest assigned first', upsertTask([t], second).map((x) => x.id).join() === 'T-406,T-405')
  check('a removed task goes', removeTask([t, second], 'T-405').map((x) => x.id).join() === 'T-406')
  check('the server’s own words are shown when it refuses', whyRefused({ status: 409, message: 'A task that is To do cannot be submitted.' }) === 'A task that is To do cannot be submitted.')
  check('a task that has gone is said plainly', whyRefused({ status: 404 }).includes('no longer'))
}

// ---------------------------------------------------------------------------
console.log(`\n${passed} checks passed`)
if (failures.length) {
  console.log(`\n${failures.length} FAILED:`)
  failures.forEach((f) => console.log(`  ✗ ${f}`))
  process.exit(1)
}
