// Staff review before guests see a change (Invitations v2, D7/D8): what publishing would
// change, what a new date moves (reminders, the RSVP deadline), and Publish or Send back.
import { useState } from 'react'
import { CalendarClock, MapPin, AlertTriangle, CheckCircle2 } from 'lucide-react'
import Modal from '../Modal'
import { useProto } from '../../store/chatProto'
import { useStore } from '../../store/useStore'
import { inviteChanges, longDate } from '../../lib/invites'
import { useT } from '../../i18n'

export default function ReviewPanel({ event, onClose }) {
  const t = useT()
  const ch = inviteChanges(event)
  const review = event.review
  const [clamp, setClamp] = useState(true)
  const [note, setNote] = useState('')
  const [sendingBack, setSendingBack] = useState(false)
  const toast = (title, body) => useStore.getState().pushToast({ title: t(title), body: t(body), kind: 'project' })
  const live = event.status === 'Published'
  // Nothing to publish only when guests already see this very version. An unpublished
  // invitation can always go back up, changed or not.
  const nothing = live && !ch.first && ch.changes.length === 0 && !ch.dateShift && !ch.venueChange

  const publish = async () => {
    if (!(await useProto.getState().publishInvite(event.id, { clampDeadline: ch.deadlineAfterDate && clamp }))) return
    toast(ch.first ? 'Invitation published' : 'Changes published', 'Guests with the link see it now.')
    onClose()
  }
  const sendBack = async () => {
    if (!(await useProto.getState().returnToClient(event.id, note))) return
    toast('Sent back to the client', 'They see your note on their link.')
    onClose()
  }

  return (
    <Modal title={ch.first ? 'Review & publish' : 'Review changes'} size="xl" onClose={onClose}
      subtitle={review.state === 'submitted' ? `${t(review.submittedBy === 'client' ? 'Submitted by the client' : 'Submitted')} · ${review.submittedAt?.replace('T', ' ')}` : t('Guests see nothing until you publish.')}
      footer={sendingBack ? (
        <>
          <button className="btn-ghost" onClick={() => setSendingBack(false)}>{t('Back')}</button>
          <button className="btn-gold" disabled={!note.trim()} onClick={sendBack}>{t('Send back with this note')}</button>
        </>
      ) : (
        <>
          <button className="btn-ghost" onClick={() => setSendingBack(true)}>{t('Send back to the client')}</button>
          <button className="btn-gold" disabled={nothing} onClick={publish}>{t(ch.first || !live ? 'Publish' : 'Publish changes')}</button>
        </>
      )}>
      {sendingBack ? (
        <label className="block">
          <span className="text-xs text-white/60">{t('What should the client change?')}</span>
          <textarea rows={4} autoFocus value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} className="mt-1 w-full rounded-lg border border-white/10 bg-navy-950 px-3 py-2 text-sm text-white/85 outline-none focus:border-gold/50"
            placeholder={t('e.g. Please use the formal names of the parents, and add the reception map link.')} />
        </label>
      ) : (
        <>
          {ch.first ? (
            <p className="text-sm text-white/70">{t('First publish: guests with the link can open the invitation and RSVP.')}</p>
          ) : !live && ch.changes.length === 0 ? (
            <p className="text-sm text-white/70">{t('The invitation is unpublished. Publishing puts the same version back up for guests.')}</p>
          ) : nothing ? (
            <p className="flex items-center gap-2 text-sm text-white/60"><CheckCircle2 size={16} className="text-emerald-300" />{t('Guests already see the latest version.')}</p>
          ) : ch.changes.length > 0 && (
            <div>
              <div className="eyebrow mb-2">{t('What guests will see change')}</div>
              <ul className="space-y-1 text-sm text-white/75">
                {ch.changes.map((c) => <li key={c}>• {c}</li>)}
              </ul>
            </div>
          )}

          {ch.dateShift && (
            <div className="rounded-lg border border-amber-300/30 bg-amber-300/5 p-3">
              <div className="flex items-center gap-2 text-sm text-amber-200"><CalendarClock size={16} />{t('New date')}: {longDate(ch.dateShift.from)} → {longDate(ch.dateShift.to)}</div>
              {ch.reminders.length > 0 && (
                <table className="mt-2 w-full text-xs text-white/65">
                  <tbody>
                    {ch.reminders.map((r) => (
                      <tr key={r.label + r.from}><td className="py-0.5 pr-3">{r.label}</td><td className="py-0.5">{r.from} → <span className="text-white/90">{r.to}</span></td></tr>
                    ))}
                  </tbody>
                </table>
              )}
              <p className="mt-2 text-[11px] text-white/45">{t('Reminders, the check-in day and the report all follow the new date once published.')}</p>
            </div>
          )}

          {ch.venueChange && (
            <div className="flex items-start gap-2 rounded-lg border border-white/10 p-3 text-sm text-white/70">
              <MapPin size={16} className="mt-0.5 shrink-0 text-gold/80" />
              <span>{t('Time / venue')}: {ch.venueChange.from} → <span className="text-white">{ch.venueChange.to}</span></span>
            </div>
          )}

          {ch.deadlineAfterDate && (
            <label className="flex items-start gap-2 rounded-lg border border-rose-300/30 bg-rose-300/5 p-3 text-sm text-rose-100">
              <AlertTriangle size={16} className="mt-0.5 shrink-0" />
              <span className="flex-1">{t('RSVPs would close after the event')} ({longDate(event.rsvpDeadline)}).
                <span className="mt-1 flex items-center gap-2 text-xs text-white/70">
                  <input type="checkbox" className="accent-[#c6a15b]" checked={clamp} onChange={(e) => setClamp(e.target.checked)} />{t('Move the RSVP deadline to the event date')}
                </span>
              </span>
            </label>
          )}

          {review.state === 'returned' && review.note && (
            <p className="text-xs text-white/45">{t('Last sent back with')}: “{review.note}”</p>
          )}
        </>
      )}
    </Modal>
  )
}
