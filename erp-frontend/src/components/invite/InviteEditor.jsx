// The invitation editor (Invitations v2): the template's sections down the left — a switch
// and a form each — and the live preview on the right. Used by Oscenia staff and, without the
// RSVP settings, by the client's link (clientMode).
import { useState } from 'react'
import { ChevronDown, Palette, LayoutTemplate, Music } from 'lucide-react'
import InviteRenderer from './InviteRenderer'
import { DeviceToggle, PreviewFrame } from './preview'
import { SECTION_FORMS, MusicForm, Text, INPUT } from './SectionForms'
import QuestionEditor from './QuestionEditor'
import { useProto } from '../../store/chatProto'
import { MediaScope } from './media'
import { SECTIONS, FAMILIES, MUSIC, templateOf, sectionOn, musicOn, themeOf } from '../../lib/templates'
import { hasContent } from '../../lib/invites'
import { MAX_PAX_LIMIT, safeLink } from '../../lib/events'
import { useT } from '../../i18n'

export default function InviteEditor({ event, clientMode = false, onChangeTemplate }) {
  const t = useT()
  const [device, setDevice] = useState('phone')
  const [open, setOpen] = useState('cover')
  const { setSection, updateContent, setAccent } = useProto.getState()
  const invite = event.invite
  const tpl = templateOf(invite)
  const { palette } = themeOf(invite)
  // Content written for sections this template does not use is kept, and comes back with a
  // template that has them (D4): say so, rather than let it look lost.
  const parked = Object.keys(SECTIONS).filter((s) => !tpl.sections.includes(s) && s !== 'countdown' && SECTIONS[s].family !== 'both' && hasContent(s, invite.content))

  return (
    <MediaScope.Provider value={{ eventId: event.id }}>
    <div className="grid gap-5 lg:grid-cols-[380px_1fr]">
      <div className="space-y-3 lg:max-h-[calc(100vh-12rem)] lg:overflow-y-auto lg:pr-2">
        <div className="rounded-xl border border-white/10 p-4">
          <div className="flex items-center gap-2">
            <LayoutTemplate size={16} className="text-gold/80" />
            <div className="min-w-0">
              <div className="text-sm text-white">{t(tpl.name)}</div>
              <div className="text-[11px] text-white/40">{t(FAMILIES[tpl.family])}</div>
            </div>
            <button className="btn-ghost ml-auto !py-1.5 text-xs" onClick={onChangeTemplate}>{t('Change template')}</button>
          </div>
          <label className="mt-3 flex items-center gap-3 text-xs text-white/60">
            <Palette size={14} />{t('Accent colour')}
            <input type="color" value={palette.accent} onChange={(e) => setAccent(event.id, e.target.value)} className="h-7 w-12 cursor-pointer rounded border border-white/10 bg-transparent" />
            {invite.accent && <button className="text-white/40 hover:text-white" onClick={() => setAccent(event.id, null)}>{t('Reset')}</button>}
          </label>
          {parked.length > 0 && (
            <p className="mt-2 text-[11px] text-white/40">{t('Kept but not shown in this template')}: {parked.map((s) => t(SECTIONS[s].label)).join(', ')}.</p>
          )}
        </div>

        {tpl.sections.map((sid) => (
          <SectionRow key={sid} label={SECTIONS[sid].label} required={SECTIONS[sid].required}
            on={sectionOn(invite, sid)} empty={sectionOn(invite, sid) && !hasContent(sid, invite.content)}
            open={open === sid} onOpen={() => setOpen(open === sid ? null : sid)} onToggle={(v) => setSection(event.id, sid, v)}>
            {(() => {
              const Form = SECTION_FORMS[sid]
              return <Form v={invite.content[sid]} save={(next) => updateContent(event.id, sid, next)} event={event} clientMode={clientMode} />
            })()}
          </SectionRow>
        ))}

        <SectionRow label="Background music" icon={Music} on={musicOn(invite)} open={open === MUSIC}
          onOpen={() => setOpen(open === MUSIC ? null : MUSIC)} onToggle={(v) => setSection(event.id, MUSIC, v)}>
          <MusicForm v={invite.content.music} save={(next) => updateContent(event.id, 'music', next)} />
        </SectionRow>

        {!clientMode && <RsvpSettings event={event} />}

        {clientMode && (
          <p className="px-1 text-[11px] text-white/35">{t('Changes save as you type. Guests see them once Oscenia publishes your invitation.')}</p>
        )}
      </div>

      <div className="lg:sticky lg:top-4 lg:self-start">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-[11px] uppercase tracking-wider text-white/35">{t('Live preview')}{event.published ? ` · ${t('draft')}` : ''}</span>
          <DeviceToggle device={device} setDevice={setDevice} />
        </div>
        <PreviewFrame device={device}>
          <InviteRenderer event={event} invite={invite} mode="preview" compact={device === 'phone'} />
        </PreviewFrame>
      </div>
    </div>
    </MediaScope.Provider>
  )
}

function SectionRow({ label, icon: Icon, required, on, empty, open, onOpen, onToggle, children }) {
  const t = useT()
  return (
    <div className={`rounded-xl border ${open ? 'border-gold/30' : 'border-white/10'}`}>
      <div className="flex items-center gap-2 px-3 py-2.5">
        <button type="button" onClick={onOpen} className="flex min-w-0 flex-1 items-center gap-2 text-left" aria-expanded={open}>
          <ChevronDown size={15} className={`shrink-0 text-white/40 transition-transform ${open ? '' : '-rotate-90'}`} />
          {Icon && <Icon size={14} className="shrink-0 text-gold/70" />}
          <span className={`truncate text-sm ${on ? 'text-white/90' : 'text-white/40'}`}>{t(label)}</span>
          {empty && <span className="shrink-0 text-[10px] text-amber-300/80">{t('empty — hidden from guests')}</span>}
        </button>
        {required
          ? <span className="text-[10px] uppercase tracking-wider text-white/30">{t('Always on')}</span>
          : <Switch on={on} onChange={onToggle} label={label} />}
      </div>
      {open && <div className="space-y-3 border-t border-white/10 px-3 py-3">{children}</div>}
    </div>
  )
}

function Switch({ on, onChange, label }) {
  const t = useT()
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={`${t('Show')} ${t(label)}`} onClick={() => onChange(!on)}
      className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${on ? 'bg-gold/70' : 'bg-white/15'}`}>
      <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${on ? 'left-[18px]' : 'left-0.5'}`} />
    </button>
  )
}

/**
 * Staff only, and live (not part of the draft): the event's ERP name and how RSVPs work. They
 * drive reminders, the guest list and the check-in desk, so the client's link leaves them be.
 */
function RsvpSettings({ event }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const setE = (patch) => useProto.getState().updateEvent(event.id, patch)
  return (
    <div className="rounded-xl border border-white/10">
      <button type="button" onClick={() => setOpen(!open)} className="flex w-full items-center gap-2 px-3 py-2.5 text-left" aria-expanded={open}>
        <ChevronDown size={15} className={`text-white/40 transition-transform ${open ? '' : '-rotate-90'}`} />
        <span className="text-sm text-white/90">{t('RSVP settings')}</span>
        <span className="ml-auto text-[10px] uppercase tracking-wider text-white/30">{t('Staff only')}</span>
      </button>
      {open && (
        <div className="space-y-3 border-t border-white/10 px-3 py-3">
          <p className="text-[11px] text-white/40">{t('These apply straight away and are not shown to the client’s link.')}</p>
          <Text label="Event name (in the ERP)" value={event.name} onChange={(v) => setE({ name: v })} />
          <Text label="RSVP closes on" type="date" value={event.rsvpDeadline} onChange={(v) => setE({ rsvpDeadline: v })} />
          {event.rsvpDeadline > event.date && <p className="text-[11px] text-amber-300">{t('RSVPs close after the event date — guests can only reply until the event itself.')}</p>}
          <Text label="Feedback form link (for follow-ups)" value={event.feedbackUrl} placeholder="https://forms.gle/…" onChange={(v) => setE({ feedbackUrl: v })} />
          {event.feedbackUrl && !safeLink(event.feedbackUrl) && <p className="text-[11px] text-amber-300">{t('Use a full link starting with https:// — otherwise {feedback} stays empty in messages.')}</p>}
          <p className="text-[11px] text-white/40">{t('Name and phone number are always asked. Choose what else guests fill in:')}</p>
          {[['email', 'Email'], ['allergies', 'Food allergies / dietary needs'], ['pax', 'Number of people coming']].map(([key, label]) => (
            <label key={key} className="flex items-center gap-2 text-sm text-white/75">
              <input type="checkbox" className="accent-[#c6a15b]" checked={event.rsvpFields[key]} onChange={() => setE({ rsvpFields: { ...event.rsvpFields, [key]: !event.rsvpFields[key] } })} />
              {t(label)}
            </label>
          ))}
          {event.rsvpFields.pax && (
            <label className="flex items-center gap-2 text-sm text-white/60">
              {t('Up to')}
              <input type="number" min={1} max={MAX_PAX_LIMIT} value={event.maxPax} onChange={(e) => setE({ maxPax: e.target.value })} className={`${INPUT} !w-16`} />
              {t('people per invitation')}
            </label>
          )}
          <p className="text-[11px] text-white/40">{t('A marketing-consent box is always shown, unticked, so the CRM only keeps people who agreed.')}</p>
          <QuestionEditor event={event} />
        </div>
      )}
    </div>
  )
}
