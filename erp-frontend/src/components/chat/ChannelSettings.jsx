// Channel settings (CH5): name, topic, who may join, who is let in or kept out, and the join
// requests waiting for a decision. The same form creates a channel. What a persona may change
// is re-checked by the store (createChannel / updateChannel / decideJoinRequest).
import { useEffect, useState } from 'react'
import { Check, X, Hash, Volume2 } from 'lucide-react'
import Modal from '../Modal'
import { Avatar } from '../workspace/parts'
import { useProto, selectPersona } from '../../store/chatProto'
import { DIVISIONS } from '../../store/protoSeed'
import { channelAccess, memberProjectIds, WORKSPACE_ROLES } from '../../lib/workspaceAccess'
import { useT } from '../../i18n'

const RULES = {
  project: ['Everyone on the project', 'Anyone working on this project can open it.'],
  divisions: ['Selected divisions', 'Only the divisions you tick (plus anyone you add below).'],
  invite: ['Invite only', 'Only the people you add.'],
}
const COMPANY_RULES = { ...RULES, project: ['Everyone at Oscenia', 'Anyone on the team can open it.'] }

/** `channel` to edit, or `projectId` (null = company) + `create` to make a new one. */
export default function ChannelSettings({ channel = null, projectId = channel?.projectId ?? null, onClose, onSaved }) {
  const t = useT()
  const persona = useProto(selectPersona)
  const members = useProto((s) => s.members)
  const projectDivisions = useProto((s) => s.projectDivisions)
  const live = useProto((s) => (channel ? s.channels.find((c) => c.id === channel.id) : null))
  const onServer = useProto((s) => s.live) // a real server: no voice channels, and the form can be refused

  // A manager's list of who has asked in comes from its own call; fetch it when the form opens.
  useEffect(() => { if (channel) useProto.getState().loadRequests?.(channel.id) }, [channel?.id])
  const start = channel ? channelAccess(channel) : { access: 'project', divisions: [], memberIds: [], blockedIds: [], listed: true }
  const [kind, setKind] = useState(channel?.kind === 'voice' ? 'voice' : 'text')
  const [name, setName] = useState(channel?.name || '')
  const [topic, setTopic] = useState(channel?.topic || '')
  const [access, setAccess] = useState(start.access)
  const [divisions, setDivisions] = useState(start.divisions)
  const [memberIds, setMemberIds] = useState(start.memberIds)
  const [blockedIds, setBlockedIds] = useState(start.blockedIds)
  const [listed, setListed] = useState(channel ? start.listed : true)
  const [error, setError] = useState('')

  const rules = projectId ? RULES : COMPANY_RULES
  const divisionChoices = projectId ? projectDivisions[projectId] || [] : DIVISIONS
  // People who could be let in: those on the project (everyone, for a company channel).
  const people = members.filter((m) => m.id !== persona.id && (!projectId || memberProjectIds(m, projectDivisions).includes(projectId)))
  const toggle = (list, set, id) => set(list.includes(id) ? list.filter((x) => x !== id) : [...list, id])
  const pending = (live?.requests || []).filter((r) => r.status === 'pending')
  const { createChannel, updateChannel, decideJoinRequest } = useProto.getState()

  // Against a server the change is asynchronous and can be refused for reasons the form should
  // show (a taken name, a rule that does not allow it): those arrive as a rejection.
  const save = async () => {
    const rule = { access, divisions, memberIds, blockedIds, listed }
    if (access === 'divisions' && !divisions.length) return setError(t('Tick at least one division.'))
    try {
      if (channel) {
        if (!(await updateChannel(channel.id, { name, topic, ...rule }))) return setError(t('Could not save. Check the name.'))
        onSaved?.(channel.id)
      } else {
        const id = await createChannel({ projectId, kind, name, topic, ...rule })
        if (!id) return setError(t('Could not create it. Use a name that is not taken yet.'))
        onSaved?.(id)
      }
      onClose()
    } catch (err) {
      setError(err?.message || t('Could not save.'))
    }
  }

  const footer = (
    <div className="flex items-center justify-end gap-2">
      {error && <span className="mr-auto text-xs text-rose-300" role="alert">{error}</span>}
      <button className="btn-ghost" onClick={onClose}>{t('Cancel')}</button>
      <button className="btn-gold" onClick={save}>{t(channel ? 'Save changes' : 'Create channel')}</button>
    </div>
  )

  const box = 'w-full rounded-lg border border-white/10 bg-navy-950 px-2.5 py-2 text-sm text-white/85 outline-none focus:border-gold/50'
  const label = 'mb-1 block text-[11px] font-semibold uppercase tracking-wide text-white/45'

  return (
    <Modal title={channel ? 'Channel settings' : 'Create channel'} subtitle={channel ? (channel.kind === 'voice' ? channel.name : `#${channel.name}`) : null} onClose={onClose} footer={footer}>
      {!channel && !onServer && (
        <div role="radiogroup" aria-label={t('Channel type')} className="grid grid-cols-2 gap-2">
          {[['text', Hash, 'Text'], ['voice', Volume2, 'Voice']].map(([k, Icon, l]) => (
            <button key={k} role="radio" aria-checked={kind === k} onClick={() => setKind(k)}
              className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-sm ${kind === k ? 'border-gold/60 bg-gold/10 text-gold-light' : 'border-white/10 text-white/70 hover:bg-white/5'}`}>
              <Icon size={16} />{t(l)}
            </button>
          ))}
        </div>
      )}
      <label className="block">
        <span className={label}>{t('Name')}</span>
        <input value={name} onChange={(e) => setName(e.target.value)} className={box} maxLength={40}
          placeholder={kind === 'voice' ? t('e.g. Client call') : t('e.g. venue-logistics')} autoFocus={!channel} />
      </label>
      <label className="block">
        <span className={label}>{t('Topic')}</span>
        <input value={topic} onChange={(e) => setTopic(e.target.value)} className={box} maxLength={120} />
      </label>

      <fieldset>
        <legend className={label}>{t('Who can join')}</legend>
        <div className="space-y-1.5">
          {Object.entries(rules).map(([k, [title, hint]]) => (
            <label key={k} className={`flex cursor-pointer items-start gap-2 rounded-lg border px-3 py-2 ${access === k ? 'border-gold/50 bg-gold/[0.06]' : 'border-white/10'}`}>
              <input type="radio" name="access" checked={access === k} onChange={() => setAccess(k)} className="mt-1 accent-[#c6a15b]" />
              <span><span className="block text-sm text-white">{t(title)}</span><span className="block text-xs text-white/45">{t(hint)}</span></span>
            </label>
          ))}
        </div>
        {access === 'divisions' && (
          <div className="mt-2 flex flex-wrap gap-2">
            {divisionChoices.map((d) => (
              <label key={d} className="flex items-center gap-1.5 rounded-full border border-white/10 px-3 py-1 text-sm text-white/80">
                <input type="checkbox" checked={divisions.includes(d)} onChange={() => toggle(divisions, setDivisions, d)} className="accent-[#c6a15b]" />{t(d)}
              </label>
            ))}
          </div>
        )}
      </fieldset>

      <PeoplePicker title={access === 'invite' ? 'Members' : 'Also let in'} people={people.filter((m) => !blockedIds.includes(m.id))}
        picked={memberIds} onToggle={(id) => toggle(memberIds, setMemberIds, id)} />
      <PeoplePicker title="Blocked" hint="Kept out whatever the rule says. The PM can’t be blocked." danger
        people={people.filter((m) => m.workspaceRole !== 'pm')} picked={blockedIds}
        onToggle={(id) => { toggle(blockedIds, setBlockedIds, id); setMemberIds((l) => l.filter((x) => x !== id)) }} />

      <label className="flex items-start gap-2 text-sm text-white/80">
        <input type="checkbox" checked={listed} onChange={(e) => setListed(e.target.checked)} className="mt-1 accent-[#c6a15b]" />
        <span>{t('Show it locked to people who can’t open it, so they can ask to join')}
          <span className="block text-xs text-white/40">{t('Untick to keep the channel out of sight (like #leaders).')}</span></span>
      </label>

      {channel && (
        <section aria-label={t('Join requests')}>
          <div className={label}>{t('Join requests')} — {pending.length}</div>
          {pending.length === 0 && <div className="text-xs text-white/35">{t('No requests waiting.')}</div>}
          {pending.map((r) => {
            const m = members.find((x) => x.id === r.memberId)
            return (
              <div key={r.memberId} className="mb-1.5 flex items-start gap-2 rounded-lg border border-white/10 p-2">
                <Avatar member={m} size="sm" />
                <div className="min-w-0 flex-1">
                  <div className="text-sm text-white">{m?.name} <span className="text-[10px] text-white/35">{t(m?.division)} · {t(WORKSPACE_ROLES[m?.workspaceRole])}</span></div>
                  {r.note && <div className="text-xs text-white/55">“{r.note}”</div>}
                </div>
                <button className="rounded-md bg-emerald-600/80 p-1.5 text-white hover:bg-emerald-500" onClick={() => {
                  decideJoinRequest(channel.id, r.memberId, true)
                  setMemberIds((l) => [...new Set([...l, r.memberId])]); setBlockedIds((l) => l.filter((x) => x !== r.memberId))
                }} title={t('Approve')} aria-label={`${t('Approve')} ${m?.name}`}><Check size={14} /></button>
                <button className="rounded-md bg-white/10 p-1.5 text-white/70 hover:bg-white/20" onClick={() => decideJoinRequest(channel.id, r.memberId, false)}
                  title={t('Decline')} aria-label={`${t('Decline')} ${m?.name}`}><X size={14} /></button>
              </div>
            )
          })}
        </section>
      )}
    </Modal>
  )
}

function PeoplePicker({ title, hint, people, picked, onToggle, danger = false }) {
  const t = useT()
  const [q, setQ] = useState('')
  const shown = people.filter((m) => m.name.toLowerCase().includes(q.trim().toLowerCase()))
  return (
    <fieldset>
      <legend className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-white/45">{t(title)} — {picked.filter((id) => people.some((m) => m.id === id)).length}</legend>
      {hint && <p className="mb-1 text-xs text-white/40">{t(hint)}</p>}
      {people.length > 6 && (
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('Find a teammate')} aria-label={`${t(title)}: ${t('Find a teammate')}`}
          className="mb-1 w-full rounded-lg border border-white/10 bg-navy-950 px-2.5 py-1.5 text-sm text-white/85 outline-none focus:border-gold/50" />
      )}
      <div className="max-h-36 space-y-0.5 overflow-y-auto rounded-lg border border-white/10 p-1">
        {shown.map((m) => (
          <label key={m.id} className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-sm text-white/80 hover:bg-white/5">
            <input type="checkbox" checked={picked.includes(m.id)} onChange={() => onToggle(m.id)} className={danger ? 'accent-rose-500' : 'accent-[#c6a15b]'} />
            <Avatar member={m} size="sm" /><span className="truncate">{m.name}</span>
            <span className="ml-auto text-[10px] text-white/35">{t(m.division)}</span>
          </label>
        ))}
        {shown.length === 0 && <div className="px-1.5 py-1 text-xs text-white/30">{t('Nobody to show.')}</div>}
      </div>
    </fieldset>
  )
}
