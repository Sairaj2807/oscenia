// The event's own RSVP questions (R7), moved from the old invitation builder for Invitations
// v2. Staff only: the client's link cannot change what guests are asked.
import { useEffect, useState } from 'react'
import { Trash2, Plus, ArrowUp, ArrowDown } from 'lucide-react'
import { useProto } from '../../store/chatProto'
import { QUESTION_TYPES, MAX_QUESTIONS } from '../../lib/events'
import { useT } from '../../i18n'

const INPUT = 'w-full rounded-lg border border-white/10 bg-navy-950 px-2.5 py-2 text-sm text-white/85 outline-none focus:border-gold/50'

/**
 * The event's own RSVP questions (R7): short text, multiple choice or a dropdown. Staff only —
 * the client's edit link cannot change what guests are asked (decision 6).
 */
export default function QuestionEditor({ event }) {
  const t = useT()
  const { addQuestion, updateQuestion, moveQuestion, removeQuestion } = useProto.getState()
  const guests = useProto((s) => s.guests)
  const qs = event.customFields || []
  const answered = (q) => guests.filter((g) => g.eventId === event.id && g.answers?.[q.id] !== undefined).length

  const remove = (q) => {
    const n = answered(q)
    if (n && !window.confirm(`${n} ${t('guests answered this question. Remove it? Their answers will no longer be shown.')}`)) return
    removeQuestion(event.id, q.id)
  }

  return (
    <div className="mt-2 border-t border-white/10 pt-3">
      <div className="text-sm text-white/80">{t('Your questions')}</div>
      <p className="mb-2 text-[11px] text-white/40">{t('Add your own questions — e.g. meal choice, shuttle, a song request. Answers show in the guest list and the export.')}</p>
      <div className="space-y-2">
        {qs.map((q, i) => (
          <div key={q.id} className="rounded-lg border border-white/10 p-2.5 space-y-2">
            {/* The question gets the full width: the builder column is narrow, and a question
                is often a sentence. */}
            <input value={q.label} onChange={(e) => updateQuestion(event.id, q.id, { label: e.target.value })} placeholder={t('Question')}
              aria-label={t('Question')} className={INPUT} />
            <select value={q.type} onChange={(e) => updateQuestion(event.id, q.id, { type: e.target.value })} aria-label={t('Answer type')}
              className="w-full rounded-lg border border-white/10 bg-navy-950 px-2 py-2 text-sm text-white/85">
              {Object.entries(QUESTION_TYPES).map(([k, v]) => <option key={k} value={k}>{t(v)}</option>)}
            </select>
            {q.type !== 'text' && <OptionsField event={event} q={q} />}
            {!q.label.trim() && <p className="text-[11px] text-amber-300">{t('Write the question — until then guests do not see it.')}</p>}
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-white/65">
              <Toggle checked={q.required} onChange={(v) => updateQuestion(event.id, q.id, { required: v })}>{t('Required')}</Toggle>
              {q.type === 'choice' && <Toggle checked={q.multi} onChange={(v) => updateQuestion(event.id, q.id, { multi: v })}>{t('Allow several answers')}</Toggle>}
              <Toggle checked={q.attendingOnly} onChange={(v) => updateQuestion(event.id, q.id, { attendingOnly: v })}>{t('Only guests who accept')}</Toggle>
              <span className="ml-auto flex gap-1">
                <IconBtn label={t('Move up')} disabled={i === 0} onClick={() => moveQuestion(event.id, q.id, -1)}><ArrowUp size={14} /></IconBtn>
                <IconBtn label={t('Move down')} disabled={i === qs.length - 1} onClick={() => moveQuestion(event.id, q.id, 1)}><ArrowDown size={14} /></IconBtn>
                <IconBtn label={t('Remove question')} onClick={() => remove(q)}><Trash2 size={14} /></IconBtn>
              </span>
            </div>
          </div>
        ))}
      </div>
      {qs.length < MAX_QUESTIONS ? (
        <button onClick={() => addQuestion(event.id, 'dropdown')} className="mt-2 inline-flex items-center gap-1 text-xs text-gold/80 hover:text-gold-light">
          <Plus size={13} />{t('Add question')}
        </button>
      ) : (
        <p className="mt-2 text-[11px] text-white/40">{t('Up to')} {MAX_QUESTIONS} {t('questions per event.')}</p>
      )}
    </div>
  )
}

/**
 * One option per line. Kept as local text while typing — the store drops blank lines, so
 * saving every keystroke would swallow the Enter for a new option — and saved on blur.
 */
function OptionsField({ event, q }) {
  const t = useT()
  const [text, setText] = useState(q.options.join('\n'))
  useEffect(() => { setText(q.options.join('\n')) }, [q.options])
  const save = () => useProto.getState().updateQuestion(event.id, q.id, { options: text.split('\n') })
  return (
    <div>
      <textarea rows={Math.min(6, Math.max(2, q.options.length + 1))} value={text} onChange={(e) => setText(e.target.value)} onBlur={save}
        aria-label={`${t('Options')} — ${q.label || t('Question')}`} placeholder={t('One option per line')} className={INPUT} />
      {q.options.length < 2 && <p className="text-[11px] text-amber-300">{t('Add at least two options — until then guests do not see this question.')}</p>}
    </div>
  )
}

function Toggle({ checked, onChange, children }) {
  return (
    <label className="flex items-center gap-1.5">
      <input type="checkbox" className="accent-[#c6a15b]" checked={checked} onChange={(e) => onChange(e.target.checked)} />{children}
    </label>
  )
}

function IconBtn({ label, disabled, onClick, children }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} aria-label={label} title={label}
      className="rounded p-1 text-white/45 hover:text-white disabled:opacity-25">{children}</button>
  )
}
