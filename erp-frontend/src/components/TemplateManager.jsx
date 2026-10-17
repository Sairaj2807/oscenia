import { useEffect, useState } from 'react'
import {
  Plus, Trash2, Copy, ChevronUp, ChevronDown, FileText, Lock, ChevronRight,
} from 'lucide-react'
import { useStore } from '../store/useStore'
import Modal from './Modal'
import { Field, TextInput } from './ui'
import { useT } from '../i18n'

// Proposal / MoU template editor.
//
// The deck asked for "dynamic templates". A switcher over three presets baked
// into the source was only half of it — the heading, the clause text, the
// validity wording and the signature line are all things a business changes
// without wanting a developer involved.
export default function TemplateManager({ onClose }) {
  const templates = useStore((s) => s.mouTemplates)
  const quotations = useStore((s) => s.quotations)
  const live = useStore((s) => s.hydrated)
  const saveMouTemplate = useStore((s) => s.saveMouTemplate)
  const addMouTemplate = useStore((s) => s.addMouTemplate)
  const updateMouTemplate = useStore((s) => s.updateMouTemplate)
  const duplicateMouTemplate = useStore((s) => s.duplicateMouTemplate)
  const deleteMouTemplate = useStore((s) => s.deleteMouTemplate)
  const setTemplateClause = useStore((s) => s.setTemplateClause)
  const addTemplateClause = useStore((s) => s.addTemplateClause)
  const removeTemplateClause = useStore((s) => s.removeTemplateClause)
  const moveTemplateClause = useStore((s) => s.moveTemplateClause)
  const t = useT()

  const [selectedId, setSelectedId] = useState(templates[0]?.id)
  const [newLabel, setNewLabel] = useState('')

  const stored = templates.find((x) => x.id === selectedId) || templates[0]

  // Signed in, edits go into a draft and are saved whole with one button (one request, clauses
  // replaced together); in the demo they apply at once, as they always did.
  const [draft, setDraft] = useState(stored)
  useEffect(() => { setDraft(stored) }, [stored])
  const selected = live ? draft : stored
  const dirty = live && stored && JSON.stringify(draft) !== JSON.stringify(stored)
  const patch = (p) => (live ? setDraft((d) => ({ ...d, ...p })) : updateMouTemplate(selected.id, p))
  const setClause = (i, text) => (live
    ? setDraft((d) => ({ ...d, clauses: d.clauses.map((c, k) => (k === i ? text : c)) }))
    : setTemplateClause(selected.id, i, text))
  const addClause = () => (live
    ? setDraft((d) => ({ ...d, clauses: [...d.clauses, ''] }))
    : addTemplateClause(selected.id, ''))
  const removeClause = (i) => (live
    ? setDraft((d) => ({ ...d, clauses: d.clauses.filter((_, k) => k !== i) }))
    : removeTemplateClause(selected.id, i))
  const moveClause = (i, delta) => {
    if (!live) return moveTemplateClause(selected.id, i, delta)
    return setDraft((d) => {
      const to = i + delta
      if (to < 0 || to >= d.clauses.length) return d
      const next = [...d.clauses]
      const [row] = next.splice(i, 1)
      next.splice(to, 0, row)
      return { ...d, clauses: next }
    })
  }

  // Quotations already committed against this template's clauses.
  const lockedBy = selected
    ? quotations.filter((q) => q.template === selected.id && q.status === 'Accepted')
    : []
  const usedBy = selected ? quotations.filter((q) => q.template === selected.id) : []

  const create = async () => {
    const tpl = await addMouTemplate({ label: newLabel, clauses: ['Scope as itemised in the attached quotation.'] })
    if (tpl) { setSelectedId(tpl.id); setNewLabel('') }
  }

  return (
    <Modal
      title="Proposal / MoU Templates"
      subtitle={t('Headings, clauses, validity and signature wording are all editable.')}
      size="2xl"
      onClose={onClose}
      footer={(
        <>
          {live && (
            <button
              onClick={() => saveMouTemplate(stored.id, draft)}
              disabled={!dirty || !draft.label?.trim() || !draft.heading?.trim() || draft.clauses.some((c) => !c.trim())}
              title={draft.clauses?.some((c) => !c.trim()) ? t('A clause cannot be blank') : undefined}
              className="btn-gold mr-auto disabled:opacity-40"
            >
              {dirty ? t('Save changes') : t('Saved')}
            </button>
          )}
          <button onClick={onClose} className="btn-gold">{t('Done')}</button>
        </>
      )}
    >
      <div className="grid sm:grid-cols-[190px_1fr] gap-4">
        {/* Template list */}
        <div className="space-y-2">
          <div className="space-y-1">
            {templates.map((tpl) => {
              const active = tpl.id === selected?.id
              const signed = quotations.some((q) => q.template === tpl.id && q.status === 'Accepted')
              return (
                <button
                  key={tpl.id}
                  onClick={() => setSelectedId(tpl.id)}
                  className={`flex w-full items-center gap-2 rounded-lg border px-2.5 py-2 text-left transition-colors ${
                    active
                      ? 'border-gold/45 bg-gold/10 text-white'
                      : 'border-white/8 bg-white/[0.02] text-white/65 hover:text-white'
                  }`}
                >
                  <FileText size={13} className={active ? 'text-gold-light shrink-0' : 'text-white/35 shrink-0'} />
                  <span className="min-w-0 flex-1 truncate text-xs">{tpl.label}</span>
                  {signed && <Lock size={11} className="text-white/30 shrink-0" title={t('Used on a signed MoU')} />}
                  {active && <ChevronRight size={12} className="text-gold/60 shrink-0" />}
                </button>
              )
            })}
          </div>

          <div className="flex gap-1.5 pt-1">
            <input
              value={newLabel}
              onChange={(e) => setNewLabel(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && newLabel.trim()) create() }}
              placeholder={t('New template')}
              className="min-w-0 flex-1 rounded-lg border border-white/10 bg-navy-900 px-2 py-1.5 text-xs text-white/85 placeholder:text-white/30 focus:border-gold/50 outline-none"
            />
            <button onClick={create} disabled={!newLabel.trim()} className="btn-gold px-2 py-1.5">
              <Plus size={13} />
            </button>
          </div>
        </div>

        {/* Editor */}
        {selected && (
          <div className="space-y-3 min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-[10px] text-white/25">{selected.id}</span>
              <span className="text-[10px] text-white/35">
                {usedBy.length} {t('quotation(s)')}
              </span>
              <div className="ml-auto flex gap-1.5">
                <button
                  onClick={async () => { const d = await duplicateMouTemplate(stored.id); if (d) setSelectedId(d.id) }}
                  className="btn-ghost text-[11px] py-1"
                >
                  <Copy size={12} /> {t('Duplicate')}
                </button>
                <button
                  onClick={async () => { if (await deleteMouTemplate(stored.id)) setSelectedId(templates.find((x) => x.id !== stored.id)?.id) }}
                  disabled={templates.length <= 1 || lockedBy.length > 0}
                  title={lockedBy.length ? `${t('Used on a signed MoU')}: ${lockedBy.map((q) => q.id).join(', ')}` : undefined}
                  className="btn-ghost text-[11px] py-1 border-rose-500/40 text-rose-300 disabled:opacity-30 disabled:cursor-not-allowed"
                >
                  <Trash2 size={12} /> {t('Delete')}
                </button>
              </div>
            </div>

            {lockedBy.length > 0 && (
              <div className="rounded-lg border border-amber-500/30 bg-amber-500/[0.06] px-3 py-2 text-[11px] text-amber-200">
                {t('Signed against')} {lockedBy.map((q) => q.id).join(', ')} —{' '}
                {t('edits here change future documents, not the ones already issued.')}
              </div>
            )}

            <Field label="Template name">
              <TextInput
                value={selected.label}
                onChange={(e) => patch({ label: e.target.value })}
              />
            </Field>
            <Field label="Document heading" hint={t('Printed at the top of the generated PDF')}>
              <TextInput
                value={selected.heading}
                onChange={(e) => patch({ heading: e.target.value })}
              />
            </Field>
            <div className="grid sm:grid-cols-2 gap-3">
              <Field label="Validity line">
                <TextInput
                  value={selected.validity}
                  onChange={(e) => patch({ validity: e.target.value })}
                />
              </Field>
              <Field label="Client signature line">
                <TextInput
                  value={selected.signatory}
                  onChange={(e) => patch({ signatory: e.target.value })}
                />
              </Field>
            </div>

            <div className="flex items-center justify-between pt-1">
              <div className="text-[11px] uppercase tracking-wider text-white/35">
                {t('Clauses')} ({selected.clauses.length})
              </div>
              <button
                onClick={addClause}
                className="text-xs text-gold/80 hover:text-gold-light inline-flex items-center gap-1"
              >
                <Plus size={12} /> {t('Add clause')}
              </button>
            </div>

            <div className="space-y-1.5">
              {selected.clauses.map((clause, i) => (
                <div key={i} className="flex items-start gap-1.5">
                  <span className="mt-2 w-4 shrink-0 text-right text-[10px] text-gold/50">{i + 1}.</span>
                  <textarea
                    value={clause}
                    onChange={(e) => setClause(i, e.target.value)}
                    rows={2}
                    placeholder={t('Clause text…')}
                    className="min-w-0 flex-1 rounded-lg border border-white/10 bg-navy-900 p-2 text-[11px] text-white/85 placeholder:text-white/25 focus:border-gold/50 outline-none resize-y"
                  />
                  {/* Order matters: clause order is contract order. */}
                  <div className="flex shrink-0 flex-col gap-0.5 pt-1">
                    <button
                      onClick={() => moveClause(i, -1)}
                      disabled={i === 0}
                      className="text-white/30 hover:text-white disabled:opacity-20"
                    >
                      <ChevronUp size={12} />
                    </button>
                    <button
                      onClick={() => moveClause(i, 1)}
                      disabled={i === selected.clauses.length - 1}
                      className="text-white/30 hover:text-white disabled:opacity-20"
                    >
                      <ChevronDown size={12} />
                    </button>
                  </div>
                  <button
                    onClick={() => removeClause(i)}
                    className="mt-1.5 shrink-0 text-white/25 hover:text-rose-300"
                    aria-label="Remove clause"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              ))}
              {!selected.clauses.length && (
                <div className="text-xs text-white/30">{t('No clauses yet — add the terms this template should carry.')}</div>
              )}
            </div>
          </div>
        )}
      </div>
    </Modal>
  )
}
