// Template Studio (client round 3): where Oscenia's design team adds invitation templates of
// their own design. The list shows their templates and the six built-ins (each can be
// duplicated); the editor sets a template's colours, fonts, cover layout, ornament, artwork
// and section order beside a live preview with sample content. "Add to gallery" puts it in
// the Change template gallery for staff and the client's link.
//
// Settings save on Save (validated by lib/templates.js validateTemplate); artwork saves as it
// is uploaded. Templates and artwork are kept in this browser only — prototype.
import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  ArrowLeft, ArrowUp, ArrowDown, Copy, Plus, Archive, ArchiveRestore, Pencil, AlertTriangle, Info, Trash2,
} from 'lucide-react'
import InviteRenderer, { sampleInvite } from './InviteRenderer'
import { DeviceToggle, PreviewFrame } from './preview'
import { UploadButton } from './SectionForms'
import { Img } from './media'
import { useProto } from '../../store/chatProto'
import { useStore } from '../../store/useStore'
import {
  TEMPLATES, SECTIONS, FAMILIES, FONTS, COVERS, ORNAMENTS, templateById, previewTemplate,
} from '../../lib/templates'
import { templateUsage } from '../../lib/invites'
import { useT } from '../../i18n'

const STATUS = {
  draft: { label: 'Draft', cls: 'border-white/20 bg-white/10 text-white/70' },
  published: { label: 'In gallery', cls: 'border-emerald-400/30 bg-emerald-400/10 text-emerald-300' },
  archived: { label: 'Archived', cls: 'border-white/10 bg-white/5 text-white/40' },
}
const COVER_LABELS = { centered: 'Centered, arched photo', split: 'Split, photo beside the title', framed: 'Framed card', fullbleed: 'Full-bleed photo' }
const ORNAMENT_LABELS = { 'gold-rule': 'Gold rule', floral: 'Floral', leaf: 'Leaf sprigs', grid: 'Dotted grid', none: 'Simple line' }
const COLOURS = [['bg', 'Background'], ['surface', 'Cards'], ['accent', 'Accent'], ['text', 'Text']]
const FONT_ROLES = [['heading', 'Heading font'], ['body', 'Body font'], ['script', 'Script font (names)']]
const ART = [
  ['coverBg', 'Cover artwork', 'Behind the cover when the client has not uploaded a photo.', 'photo'],
  ['pageBg', 'Page texture', 'Repeats down the whole invitation, over the background colour.', 'art'],
  ['frame', 'Cover frame', 'A transparent PNG laid over the cover, stretched to fit.', 'art'],
  ['ornament', 'Ornament', 'Shown under each section title instead of the drawn ornament.', 'art'],
]
// The editor's settings: what Save sends (artwork saves on its own).
const FIELDS = ['name', 'tagline', 'family', 'palette', 'fonts', 'cover', 'ornament', 'sections', 'off']
const pick = (t) => Object.fromEntries(FIELDS.map((k) => [k, structuredClone(t[k])]))
const fontName = (key) => FONTS[key].match(/'([^']+)'/)?.[1] || key

export function StatusBadge({ status }) {
  const t = useT()
  const s = STATUS[status] || STATUS.draft
  return <span className={`inline-flex rounded-full border px-2 py-0.5 text-[10px] font-medium ${s.cls}`}>{t(s.label)}</span>
}

export default function TemplateStudio({ role }) {
  const [params, setParams] = useSearchParams()
  const editing = params.get('edit')
  const custom = useProto((s) => s.customTemplates)
  const open = (id) => setParams(id ? { edit: id } : {})
  // An archived template is not editable (Restore it first): its ?edit= link shows the list.
  const current = editing && custom.find((x) => x.id === editing && x.status !== 'archived')
  // Keyed by id: opening another template starts its editor afresh.
  return current
    ? <TemplateEditor key={current.id} saved={current} role={role} onBack={() => open(null)} />
    : <TemplateList custom={custom} role={role} onOpen={open} />
}

// --- the list ------------------------------------------------------------------------------

function TemplateList({ custom, role, onOpen }) {
  const t = useT()
  const events = useProto((s) => s.events)
  const [showArchived, setShowArchived] = useState(false)
  const { createTemplate } = useProto.getState()
  const create = async (opts) => {
    const id = await createTemplate(opts, role)
    if (id) onOpen(id)
  }
  const archived = custom.filter((x) => x.status === 'archived').length
  const mine = custom.filter((x) => showArchived || x.status !== 'archived')

  return (
    <div className="space-y-6">
      <BrowserOnlyNote />

      <section>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <h2 className="font-display text-lg text-white">{t('Design team templates')}</h2>
          <div className="flex flex-wrap gap-2 sm:ml-auto">
            {archived > 0 && (
              <button className="btn-ghost !py-1.5 text-xs" onClick={() => setShowArchived(!showArchived)}>
                {t(showArchived ? 'Hide archived' : 'Show archived')} ({archived})
              </button>
            )}
            <button className="btn-ghost !py-1.5 text-xs" onClick={() => create({ family: 'corporate' })}><Plus size={14} />{t('New corporate design')}</button>
            <button className="btn-gold !py-1.5 text-xs" onClick={() => create({ family: 'private' })}><Plus size={14} />{t('New wedding design')}</button>
          </div>
        </div>
        {mine.length === 0 ? (
          <div className="card p-6 text-center text-sm text-white/50">
            {t('No designs yet. Start a new one, or duplicate a built-in template below and make it your own.')}
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {mine.map((raw) => {
              const tpl = templateById(raw.id)
              const use = templateUsage(events, raw.id)
              return (
                <StudioCard key={raw.id} tpl={tpl} raw={raw} usage={use} role={role} onOpen={() => onOpen(raw.id)}
                  onDuplicate={() => create({ from: raw.id })} />
              )
            })}
          </div>
        )}
      </section>

      <section>
        <h2 className="mb-1 font-display text-lg text-white">{t('Built-in templates')}</h2>
        <p className="mb-3 text-xs text-white/45">{t('Duplicate one to start from its layout and colours.')}</p>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {TEMPLATES.map((tpl) => (
            <div key={tpl.id} className="card overflow-hidden">
              <CoverThumb tpl={tpl} />
              <div className="flex items-center gap-2 p-4">
                <div className="min-w-0">
                  <div className="text-white">{t(tpl.name)}</div>
                  <div className="text-[10px] uppercase tracking-wider text-white/40">{t(FAMILIES[tpl.family])}</div>
                </div>
                <button className="btn-ghost ml-auto !py-1.5 text-xs" onClick={() => create({ from: tpl.id })} aria-label={`${t('Duplicate')} ${tpl.name}`}>
                  <Copy size={14} />{t('Duplicate')}
                </button>
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}

function StudioCard({ tpl, raw, usage, role, onOpen, onDuplicate }) {
  const t = useT()
  const { publishTemplate, unpublishTemplate, archiveTemplate } = useProto.getState()
  return (
    <div className={`card overflow-hidden ${raw.status === 'archived' ? 'opacity-60' : ''}`}>
      {tpl ? <CoverThumb tpl={tpl} /> : <div className="h-[200px] bg-navy-950" />}
      <div className="p-4">
        <div className="flex items-center gap-2">
          <div className="min-w-0 truncate text-white">{raw.name}</div>
          <StatusBadge status={raw.status} />
        </div>
        <div className="mt-1 text-[11px] text-white/45">
          {t(FAMILIES[raw.family])} · {usage.events === 1 ? t('used by 1 event') : `${t('used by')} ${usage.events} ${t('events')}`}
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          {raw.status !== 'archived' && <button className="btn-ghost !py-1.5 text-xs" onClick={onOpen}><Pencil size={14} />{t('Edit')}</button>}
          {raw.status === 'draft' && <button className="btn-gold !py-1.5 text-xs" onClick={() => publishTemplate(raw.id, role)}>{t('Add to gallery')}</button>}
          {raw.status === 'published' && <button className="btn-ghost !py-1.5 text-xs" onClick={() => unpublishTemplate(raw.id, role)}>{t('Take out of gallery')}</button>}
          <button className="btn-ghost !py-1.5 text-xs" onClick={onDuplicate} aria-label={`${t('Duplicate')} ${raw.name}`}><Copy size={14} />{t('Duplicate')}</button>
          {raw.status === 'archived'
            ? <button className="btn-ghost !py-1.5 text-xs" onClick={() => unpublishTemplate(raw.id, role)}><ArchiveRestore size={14} />{t('Restore')}</button>
            : <ArchiveButton raw={raw} usage={usage} role={role} onArchive={archiveTemplate} />}
        </div>
      </div>
    </div>
  )
}

function ArchiveButton({ raw, usage, role, onArchive }) {
  const t = useT()
  const go = () => {
    const ask = usage.events
      ? `${t('Archive this template?')} ${t('It leaves the gallery, but the invitations already using it keep their design.')}`
      : t('Archive this template? It leaves the gallery; you can restore it later.')
    if (window.confirm(ask)) onArchive(raw.id, role)
  }
  return <button className="btn-ghost !py-1.5 text-xs" onClick={go}><Archive size={14} />{t('Archive')}</button>
}

/** A template's real cover at half size, like the gallery card. */
function CoverThumb({ tpl }) {
  const sample = useMemo(() => sampleInvite(tpl.id, tpl), [tpl])
  return (
    <div className="h-[200px] w-full overflow-hidden" aria-hidden>
      <div style={{ width: '200%', transform: 'scale(0.5)', transformOrigin: 'top left' }}>
        <InviteRenderer invite={sample} template={tpl} mode="sample" compact only={['cover']} />
      </div>
    </div>
  )
}

function BrowserOnlyNote() {
  const t = useT()
  const live = useProto((s) => s.live)
  if (live) {
    return (
      <div className="flex gap-2 rounded-xl border border-sky-400/20 bg-sky-400/[0.06] p-3 text-xs text-sky-100/80">
        <Info size={15} className="mt-0.5 shrink-0 text-sky-300" />
        <div>{t('Templates and their artwork are saved on the server for everyone. A new cover layout or kind of section still needs a developer.')}</div>
      </div>
    )
  }
  return (
    <div className="flex gap-2 rounded-xl border border-sky-400/20 bg-sky-400/[0.06] p-3 text-xs text-sky-100/80">
      <Info size={15} className="mt-0.5 shrink-0 text-sky-300" />
      <div>
        <div>{t('Templates and artwork are saved in this browser only (prototype). The designer, staff and the client need to use the same browser to see a studio template.')}</div>
        <div className="mt-1 text-sky-100/55">{t('A new cover layout or a new kind of section still needs a developer.')}</div>
      </div>
    </div>
  )
}

// --- the editor ----------------------------------------------------------------------------

function TemplateEditor({ saved, role, onBack }) {
  const t = useT()
  const events = useProto((s) => s.events)
  const [draft, setDraft] = useState(() => pick(saved))
  const [problem, setProblem] = useState('')
  const [device, setDevice] = useState('phone')
  const set = (patch) => { setDraft((d) => ({ ...d, ...patch })); setProblem('') }
  const dirty = JSON.stringify(draft) !== JSON.stringify(pick(saved))
  const usage = templateUsage(events, saved.id)
  const { updateTemplate, publishTemplate, unpublishTemplate, setTemplateArt } = useProto.getState()

  // The preview draws the unsaved design with the saved artwork.
  const preview = useMemo(() => previewTemplate({ ...saved, ...draft }), [saved, draft])
  const sample = useMemo(() => sampleInvite(saved.id, preview), [saved.id, preview])

  // Closing or reloading the tab with unsaved settings asks first. (The app uses a
  // BrowserRouter, not a data router, so in-app links cannot be blocked with useBlocker; the
  // "All templates" button asks on its own.)
  useEffect(() => {
    if (!dirty) return undefined
    const warn = (e) => { e.preventDefault(); e.returnValue = '' }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])

  const save = async (quiet = false) => {
    const why = await updateTemplate(saved.id, draft, role)
    if (why) { setProblem(t(why)); return false }
    // The store tidies what it saves (trimmed name and tagline): start again from that, so
    // "Unsaved changes" clears.
    const now = useProto.getState().customTemplates.find((x) => x.id === saved.id)
    if (now) setDraft(pick(now))
    if (!quiet) useStore.getState().pushToast({ title: t('Template saved'), body: usage.live ? t('Guests of the invitations using it see the change now.') : draft.name, kind: 'project' })
    return true
  }
  const publish = async () => {
    if (dirty && !(await save(true))) return
    if (await publishTemplate(saved.id, role)) {
      useStore.getState().pushToast({ title: t('Added to the gallery'), body: t('Staff and clients can now pick it under Change template.'), kind: 'project' })
    }
  }

  // A family offers different sections: keep the ones that still fit, add the new family's
  // own just before RSVP, so the required ones (cover, date & venue, RSVP) are always there.
  const setFamily = (family) => {
    const fits = (s) => SECTIONS[s].family === 'both' || SECTIONS[s].family === family
    const kept = draft.sections.filter(fits)
    const added = Object.keys(SECTIONS).filter((s) => fits(s) && !kept.includes(s))
    const at = kept.indexOf('rsvp')
    set({ family, sections: [...kept.slice(0, at), ...added, ...kept.slice(at)], off: draft.off.filter(fits) })
  }
  const move = (i, by) => {
    const next = [...draft.sections]
    ;[next[i], next[i + by]] = [next[i + by], next[i]]
    set({ sections: next })
  }
  const toggleOff = (sid) => set({ off: draft.off.includes(sid) ? draft.off.filter((s) => s !== sid) : [...draft.off, sid] })

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <button className="btn-ghost !py-1.5 text-xs" onClick={() => { if (!dirty || window.confirm(t('Leave without saving your changes?'))) onBack() }}>
          <ArrowLeft size={14} />{t('All templates')}
        </button>
        <div className="flex min-w-0 items-center gap-2">
          <div className="truncate font-display text-xl text-white">{saved.name}</div>
          <StatusBadge status={saved.status} />
          {dirty && <span className="text-[11px] text-amber-300">{t('Unsaved changes')}</span>}
        </div>
        <div className="flex flex-wrap gap-2 sm:ml-auto">
          <button className="btn-ghost !py-1.5 text-xs" disabled={!dirty} onClick={() => save()}>{t('Save')}</button>
          {saved.status === 'published'
            ? <button className="btn-ghost !py-1.5 text-xs" onClick={() => unpublishTemplate(saved.id, role)}>{t('Take out of gallery')}</button>
            : <button className="btn-gold !py-1.5 text-xs" onClick={publish}>{t('Add to gallery')}</button>}
        </div>
      </div>

      {usage.live > 0 && (
        <div role="alert" className="mb-4 flex gap-2 rounded-xl border border-amber-400/30 bg-amber-400/[0.07] p-3 text-xs text-amber-100/90">
          <AlertTriangle size={15} className="mt-0.5 shrink-0 text-amber-300" />
          <div>
            {usage.live === 1 ? t('Used by 1 published invitation') : `${t('Used by')} ${usage.live} ${t('published invitations')}`} — {t('changes show to their guests straight away once saved.')}
          </div>
        </div>
      )}
      {problem && <p role="alert" className="mb-3 text-xs text-rose-300">{problem}</p>}

      <div className="grid gap-5 lg:grid-cols-[400px_1fr]">
        <div className="space-y-4 lg:max-h-[calc(100vh-12rem)] lg:overflow-y-auto lg:pr-2">
          <Panel title="About">
            <LabeledInput label="Name" value={draft.name} maxLength={40} onChange={(v) => set({ name: v })} />
            <LabeledInput label="Tagline" value={draft.tagline} maxLength={120} onChange={(v) => set({ tagline: v })} />
            <LabeledSelect label="Family" value={draft.family} onChange={setFamily}
              options={Object.entries(FAMILIES).map(([k, label]) => [k, t(label)])} />
          </Panel>

          <Panel title="Colours">
            <div className="grid grid-cols-2 gap-3">
              {COLOURS.map(([k, label]) => (
                <label key={k} className="flex items-center gap-2 text-xs text-white/60">
                  <input type="color" value={draft.palette[k]} aria-label={t(label)}
                    onChange={(e) => set({ palette: { ...draft.palette, [k]: e.target.value } })}
                    className="h-8 w-10 shrink-0 cursor-pointer rounded border border-white/10 bg-transparent" />
                  <span className="min-w-0">{t(label)}<span className="block font-mono text-[10px] text-white/35">{draft.palette[k]}</span></span>
                </label>
              ))}
            </div>
          </Panel>

          <Panel title="Fonts">
            {FONT_ROLES.map(([k, label]) => (
              <LabeledSelect key={k} label={label} value={draft.fonts[k]} onChange={(v) => set({ fonts: { ...draft.fonts, [k]: v } })}
                options={Object.keys(FONTS).map((f) => [f, fontName(f)])} />
            ))}
          </Panel>

          <Panel title="Layout">
            <LabeledSelect label="Cover layout" value={draft.cover} onChange={(v) => set({ cover: v })}
              options={COVERS.map((c) => [c, t(COVER_LABELS[c])])} />
            <LabeledSelect label="Ornament" value={draft.ornament} onChange={(v) => set({ ornament: v })}
              options={ORNAMENTS.map((o) => [o, t(ORNAMENT_LABELS[o])])} />
          </Panel>

          <Panel title="Artwork" note="JPG, PNG or WEBP. Saved as soon as it is uploaded.">
            {ART.map(([slot, label, hint, kind]) => (
              <div key={slot} className="flex items-start gap-3">
                <div className="h-12 w-12 shrink-0 overflow-hidden rounded-lg border border-white/10 bg-navy-950">
                  <Img src={saved.art[slot]} className="h-full w-full object-cover" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-xs text-white/80">{t(label)}</div>
                  <div className="text-[11px] text-white/40">{t(hint)}</div>
                  <div className="mt-1.5 flex flex-wrap gap-2" data-art={slot}>
                    <UploadButton kind={kind} size="cover" templateId={saved.id} label={saved.art[slot] ? 'Replace' : 'Upload'} onDone={(ref) => setTemplateArt(saved.id, slot, ref, role)} />
                    {saved.art[slot] && (
                      <button type="button" className="btn-ghost !py-1.5 text-xs" onClick={() => setTemplateArt(saved.id, slot, null, role)}>
                        <Trash2 size={14} />{t('Remove')}
                      </button>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </Panel>

          <Panel title="Sections" note="Order on the page, and whether each starts switched on. Staff and the client can still switch optional ones.">
            <ol className="space-y-1.5">
              {draft.sections.map((sid, i) => {
                const required = SECTIONS[sid].required
                return (
                  <li key={sid} className="flex items-center gap-2 rounded-lg border border-white/10 px-2.5 py-1.5">
                    <span className="min-w-0 flex-1 truncate text-sm text-white/80">{t(SECTIONS[sid].label)}</span>
                    {required
                      ? <span className="text-[10px] uppercase tracking-wider text-white/30">{t('Always on')}</span>
                      : (
                        <label className="flex items-center gap-1.5 text-[11px] text-white/55">
                          <input type="checkbox" className="accent-[#c6a15b]" checked={!draft.off.includes(sid)} onChange={() => toggleOff(sid)} />
                          {t('On')}
                        </label>
                      )}
                    {/* The cover always opens the invitation. */}
                    <button type="button" className="rounded p-1 text-white/50 hover:bg-white/10 disabled:opacity-25" disabled={i <= 1}
                      onClick={() => move(i, -1)} aria-label={`${t('Move up')}: ${t(SECTIONS[sid].label)}`}><ArrowUp size={14} /></button>
                    <button type="button" className="rounded p-1 text-white/50 hover:bg-white/10 disabled:opacity-25" disabled={i === 0 || i === draft.sections.length - 1}
                      onClick={() => move(i, 1)} aria-label={`${t('Move down')}: ${t(SECTIONS[sid].label)}`}><ArrowDown size={14} /></button>
                  </li>
                )
              })}
            </ol>
          </Panel>
          <BrowserOnlyNote />
        </div>

        <div className="lg:sticky lg:top-4 lg:self-start">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[11px] uppercase tracking-wider text-white/35">{t('Live preview')} · {t('sample content')}</span>
            <DeviceToggle device={device} setDevice={setDevice} />
          </div>
          <PreviewFrame device={device}>
            <InviteRenderer invite={sample} template={preview} mode="sample" compact={device === 'phone'} />
          </PreviewFrame>
        </div>
      </div>
    </div>
  )
}

function Panel({ title, note, children }) {
  const t = useT()
  return (
    <div className="space-y-3 rounded-xl border border-white/10 p-4">
      <div>
        <div className="text-sm text-white">{t(title)}</div>
        {note && <div className="text-[11px] text-white/40">{t(note)}</div>}
      </div>
      {children}
    </div>
  )
}

const INPUT = 'mt-1 w-full rounded-lg border border-white/10 bg-navy-900 p-2 text-sm text-white/85 outline-none focus:border-gold/50'

function LabeledInput({ label, value, onChange, maxLength }) {
  const t = useT()
  return (
    <label className="block">
      <span className="text-[11px] text-white/45">{t(label)}</span>
      <input value={value || ''} maxLength={maxLength} onChange={(e) => onChange(e.target.value)} className={INPUT} />
    </label>
  )
}

function LabeledSelect({ label, value, onChange, options }) {
  const t = useT()
  return (
    <label className="block">
      <span className="text-[11px] text-white/45">{t(label)}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)} className={INPUT}>
        {options.map(([k, text]) => <option key={k} value={k}>{text}</option>)}
      </select>
    </label>
  )
}
