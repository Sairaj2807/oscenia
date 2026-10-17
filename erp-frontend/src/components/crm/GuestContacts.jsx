// CRM part 1 (BRD §5.1): every guest from every event, pooled into one list and
// de-duplicated, with the marketing consent they gave. A campaign goes to the contacts ticked
// here (C1) — and of those, only to people who agreed; the others are skipped, and the sender
// is told how many.
import { useEffect, useMemo, useRef, useState } from 'react'
import { Search, Send, Download, ShieldCheck, AlertTriangle, UserMinus } from 'lucide-react'
import { Card, FilterPill, TableWrap, StatCard, Field, TextInput, Select } from '../ui'
import Modal from '../Modal'
import { useProto } from '../../store/useProto'
import { useStore } from '../../store/useStore'
import { useCampaigns } from '../../store/useCampaigns'
import CampaignDetailModal from './CampaignDetailModal'
import { guestContacts, campaignAudience } from '../../lib/crm'
import { campaignSummary } from '../../lib/campaignsApi'
import { canDo } from '../../lib/roles'
import { exportCSV } from '../../lib/exports'
import { shortDate, stamp } from '../workspace/parts'
import { useT } from '../../i18n'

export default function GuestContacts() {
  const t = useT()
  const guests = useProto((s) => s.guests)
  const events = useProto((s) => s.events)
  // Signed in, the contact list and the campaigns are the server's; offline, the demo works them out here.
  const live = useStore((s) => s.hydrated)
  const role = useStore((s) => s.role)
  const may = live && canDo(role, 'manage_campaigns')
  const demoCampaigns = useProto((s) => s.campaigns)
  const servedContacts = useCampaigns((s) => s.contacts)
  const servedCampaigns = useCampaigns((s) => s.campaigns)
  useEffect(() => {
    if (!live) return
    useCampaigns.getState().loadContacts()
    useCampaigns.getState().loadCampaigns()
  }, [live])
  const demoContacts = useMemo(() => (live ? [] : guestContacts(guests, events)), [live, guests, events])
  const contacts = live ? servedContacts : demoContacts
  const campaigns = live ? servedCampaigns : demoCampaigns
  const [consentOnly, setConsentOnly] = useState(false)
  const [eventId, setEventId] = useState('all')
  const [attendedOnly, setAttendedOnly] = useState(false)
  const [q, setQ] = useState('')
  const [composing, setComposing] = useState(false)
  const [picked, setPicked] = useState(() => new Set())

  const matches = (c) =>
    (eventId === 'all' || c.events.some((e) => e.eventId === eventId && (!attendedOnly || e.came))) &&
    (eventId !== 'all' || !attendedOnly || c.events.some((e) => e.came))
  const needle = q.trim().toLowerCase()
  const shown = contacts.filter((c) =>
    matches(c) && (!consentOnly || c.consent) &&
    (!needle || c.name.toLowerCase().includes(needle) || c.phone.includes(needle) || c.email.toLowerCase().includes(needle))
  )
  // A campaign reaches the ticked contacts who agreed — whatever the filters show now.
  const { recipients, skipped } = campaignAudience(contacts, picked)
  const hiddenPicked = [...picked].filter((k) => !shown.some((c) => c.key === k)).length
  const allShown = shown.length > 0 && shown.every((c) => picked.has(c.key))
  const someShown = shown.some((c) => picked.has(c.key))
  const toggle = (key) => setPicked((p) => { const n = new Set(p); if (n.has(key)) n.delete(key); else n.add(key); return n })
  const toggleShown = () => setPicked((p) => {
    const n = new Set(p)
    for (const c of shown) { if (allShown) n.delete(c.key); else n.add(c.key) }
    return n
  })
  // The header box is "some" when only part of what is shown is ticked.
  const headerBox = useRef(null)
  useEffect(() => { if (headerBox.current) headerBox.current.indeterminate = someShown && !allShown }, [someShown, allShown])

  const exportList = () => exportCSV('oscenia-guest-contacts', [
    { key: 'name', label: 'Name' }, { key: 'phone', label: 'Phone' }, { key: 'email', label: 'Email' },
    { key: 'eventCount', label: 'Events' }, { key: 'consentText', label: 'Marketing consent' },
    { key: 'consentAt', label: 'Consent given' }, { key: 'consentSource', label: 'Consent source' },
  ], shown.map((c) => ({ ...c, eventCount: c.events.length, consentText: c.consent ? 'Yes' : 'No' })))

  return (
    <div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 mb-5">
        <StatCard label="Contacts" value={contacts.length} hint={live ? t('across every event') : `${t('from')} ${guests.length} ${t('guest records')}`} />
        <StatCard label="Marketing consent" value={contacts.filter((c) => c.consent).length} />
        <StatCard label="At 2+ events" value={contacts.filter((c) => c.events.length > 1).length} />
        <StatCard label={live ? 'Campaigns' : 'Campaigns sent'} value={campaigns.length} />
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <FilterPill active={consentOnly} onClick={() => setConsentOnly((v) => !v)}>{t('Consented only')}</FilterPill>
        <FilterPill active={attendedOnly} onClick={() => setAttendedOnly((v) => !v)}>{t('Attended')}</FilterPill>
        <Select value={eventId} onChange={(e) => setEventId(e.target.value)} className="!w-auto !py-1.5">
          <option value="all">{t('Any event')}</option>
          {events.map((ev) => <option key={ev.id} value={ev.id}>{ev.name}</option>)}
        </Select>
        <div className="relative ml-auto">
          <Search size={14} className="absolute left-2.5 top-2.5 text-white/30" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('Name, phone or email')}
            className="rounded-lg border border-white/10 bg-navy-900 py-1.5 pl-8 pr-3 text-sm text-white/85 outline-none focus:border-gold/50" />
        </div>
        <button className="btn-ghost !py-1.5" onClick={exportList}><Download size={14} />{t('Export')}</button>
        <button className="btn-gold !py-1.5" disabled={recipients.length === 0 || (live && !may)} onClick={() => setComposing(true)}
          title={recipients.length ? undefined : t('Tick the contacts to send to')}>
          <Send size={14} />{t('Compose campaign')}{recipients.length ? ` · ${recipients.length}` : ''}
        </button>
      </div>

      {picked.size > 0 ? (
        <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-gold/25 bg-gold/5 px-3 py-2 text-xs">
          <span className="text-white/85">{picked.size} {t('selected')}</span>
          {skipped.length > 0 && (
            <span className="inline-flex items-center gap-1 text-amber-300"><AlertTriangle size={12} />{skipped.length} {t('without marketing consent — they will be skipped')}</span>
          )}
          {hiddenPicked > 0 && <span className="text-white/45">{hiddenPicked} {t('not shown by the current filters')}</span>}
          <button className="ml-auto text-gold/80 hover:text-gold-light" onClick={() => setPicked(new Set())}>{t('Clear')}</button>
        </div>
      ) : (
        <p className="mb-3 text-[11px] text-white/40">{t('Tick the contacts a campaign should go to. Only those who gave marketing consent will receive it.')}</p>
      )}

      <TableWrap>
        <thead>
          <tr>
            <th className="th w-8">
              <input ref={headerBox} type="checkbox" className="accent-[#c6a15b]" checked={allShown} onChange={toggleShown}
                aria-label={t('Select all shown')} disabled={shown.length === 0} />
            </th>
            <th className="th text-left">{t('Contact')}</th>
            <th className="th text-left">{t('Events')}</th>
            <th className="th text-left">{t('Marketing consent')}</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((c) => (
            <tr key={c.key} className={`border-t border-white/5 ${picked.has(c.key) ? 'bg-gold/[0.04]' : ''}`}>
              <td className="td">
                <input type="checkbox" className="accent-[#c6a15b]" checked={picked.has(c.key)} onChange={() => toggle(c.key)}
                  aria-label={`${t('Select')} ${c.name}`} />
              </td>
              <td className="td">
                <div className="text-white/85">{c.name}</div>
                <div className="text-[11px] text-white/40">{c.phone}{c.email ? ` · ${c.email}` : ''}</div>
              </td>
              <td className="td">
                <div className="flex flex-wrap gap-1">
                  {c.events.map((e) => (
                    <span key={e.eventId} title={`${e.rsvp}${e.came ? ' · attended' : ''}`}
                      className={`rounded-full border px-2 py-0.5 text-[10px] ${e.came ? 'border-emerald-500/30 text-emerald-200' : 'border-white/10 text-white/50'}`}>
                      {e.name} · {shortDate(e.date)}{e.came ? ' ✓' : ''}
                    </span>
                  ))}
                </div>
              </td>
              <td className="td text-xs">
                {c.consent
                  ? (
                    <span className="inline-flex flex-wrap items-center gap-2">
                      <span className="inline-flex items-center gap-1 text-emerald-300"><ShieldCheck size={13} />{stamp(c.consentAt)} · {c.consentSource}</span>
                      {may && (
                        <button
                          onClick={() => { if (window.confirm(`${t('Withdraw marketing consent for')} ${c.name}?`)) useCampaigns.getState().unsubscribe(c.key, c.name) }}
                          className="inline-flex items-center gap-1 text-[11px] text-white/40 hover:text-rose-300"
                          aria-label={`${t('Unsubscribe')} ${c.name}`}
                        >
                          <UserMinus size={12} /> {t('Unsubscribe')}
                        </button>
                      )}
                    </span>
                  )
                  : <span className="text-white/30">{t('Not given')}</span>}
              </td>
            </tr>
          ))}
          {shown.length === 0 && <tr><td colSpan={4} className="td text-center text-sm text-white/35">{t('No contacts match.')}</td></tr>}
        </tbody>
      </TableWrap>

      {campaigns.length > 0 && (
        <Card className="mt-5">
          <div className="eyebrow mb-3">{live ? t('Campaigns') : t('Campaigns (simulated)')}</div>
          {(live ? campaigns : [...campaigns].reverse()).map((c) => (
            live ? (
              <button
                key={c.id}
                onClick={() => useCampaigns.getState().openCampaign(c.id)}
                data-testid="campaign-row"
                className="flex w-full justify-between gap-3 border-t border-white/5 py-2 text-left text-sm first:border-0 hover:bg-white/[0.03]"
              >
                <span className="text-white/80"><span className="font-mono text-xs text-gold/80">{c.no}</span> {c.name} <span className="text-xs text-white/40">· {c.channel}</span></span>
                <span className="text-xs text-white/50">{campaignSummary(c)} · {stamp(c.at)}</span>
              </button>
            ) : (
              <div key={c.id} className="flex justify-between border-t border-white/5 py-2 text-sm first:border-0">
                <span className="text-white/80">{c.name} <span className="text-xs text-white/40">· {c.channel}</span></span>
                <span className="text-xs text-white/50">
                  {c.count} {t('recipients')}{c.skipped ? ` · ${c.skipped} ${t('skipped (no consent)')}` : ''} · {stamp(c.at)}
                </span>
              </div>
            )
          ))}
        </Card>
      )}
      {live && <CampaignDetailModal />}

      {composing && (
        <CampaignModal live={live} keys={[...picked]} recipients={recipients} skipped={skipped}
          onClose={() => setComposing(false)} onSent={() => setPicked(new Set())} />
      )}
    </div>
  )
}

function CampaignModal({ live, keys, recipients, skipped, onClose, onSent }) {
  const t = useT()
  const pushToast = useStore((s) => s.pushToast)
  const [name, setName] = useState('')
  const [channel, setChannel] = useState(live ? 'whatsapp' : 'email')
  const [message, setMessage] = useState('Hi {name}, thank you for celebrating with us this year. Planning your next gathering? We would love to help.')

  const send = async () => {
    if (live) {
      // The server works the audience out from the keys alone, and says if nobody would receive it.
      const made = await useCampaigns.getState().create({ name, channel, message, keys })
      if (made) { onSent(); onClose() }
      return
    }
    const entry = useProto.getState().createCampaign({ name, channel, keys })
    if (!entry) {
      pushToast({ title: t('Not sent'), body: t('None of the ticked contacts gave marketing consent.'), kind: 'redflag' })
      return
    }
    pushToast({
      title: t('Campaign sent (simulated)'),
      body: `${entry.count} ${t('consented contacts')}${entry.skipped ? ` · ${entry.skipped} ${t('skipped (no consent)')}` : ''}`,
      kind: 'cron',
    })
    onSent()
    onClose()
  }

  return (
    <Modal
      title="Compose campaign"
      subtitle={`${recipients.length} ${t('recipients — only contacts who gave marketing consent')}`}
      onClose={onClose}
      footer={<><button className="btn-ghost" onClick={onClose}>{t('Cancel')}</button><button className="btn-gold" disabled={!name.trim()} onClick={send}>{live ? t('Prepare campaign') : t('Send (simulated)')}</button></>}
    >
      {skipped.length > 0 && (
        <div className="flex gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
          <AlertTriangle size={14} className="mt-px shrink-0" />
          <span>{skipped.length} {t('ticked contacts have no marketing consent and will not receive it')}: {skipped.slice(0, 5).map((c) => c.name).join(', ')}{skipped.length > 5 ? '…' : ''}</span>
        </div>
      )}
      <Field label="Campaign name"><TextInput autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={t('e.g. Year-end gathering offer')} /></Field>
      <Field label="Channel">
        <Select value={channel} onChange={(e) => setChannel(e.target.value)}>
          <option value="email">{t('Email')}</option>
          <option value="whatsapp">WhatsApp</option>
          {!live && <option value="both">{t('WhatsApp + email')}</option>}
        </Select>
      </Field>
      <Field label="Message">
        <textarea rows={4} value={message} onChange={(e) => setMessage(e.target.value)}
          className="w-full rounded-lg border border-white/10 bg-navy-900 p-2.5 text-sm text-white/85 outline-none focus:border-gold/50" />
      </Field>
      <p className="text-[11px] text-white/40">
        {live
          ? t('Nothing is sent from here. You get a link for each person who agreed and can be reached on this channel; send each message yourself, then mark it reached. {name} is filled in per person.')
          : t('Every message includes an unsubscribe link. Prototype: nothing is sent; the backend will send through Oscenia’s email service and WhatsApp Business account, and honour unsubscribes.')}
      </p>
    </Modal>
  )
}
