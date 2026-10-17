// The template gallery (Invitations v2, D5): six designs in two families, each with a live
// preview filled with sample content. Choosing one keeps whatever has been written already.
// The design team's templates (round 3, Template Studio) join once added to the gallery,
// marked "Design team"; the client's link uses this same gallery, so they see them too.
import { useMemo, useState } from 'react'
import { Eye, Check, ArrowLeft } from 'lucide-react'
import Modal from '../Modal'
import { FilterPill } from '../ui'
import InviteRenderer, { sampleInvite } from './InviteRenderer'
import { DeviceToggle, PreviewFrame } from './preview'
import { allTemplates, templateById, inGallery, FAMILIES } from '../../lib/templates'
import { useProto } from '../../store/chatProto'
import { useT } from '../../i18n'

export default function TemplateGallery({ current = null, onUse, onBack }) {
  const t = useT()
  const [family, setFamily] = useState('all')
  const [previewing, setPreviewing] = useState(null)
  // Re-read when the studio changes (lib/templates.js holds them; the store announces changes).
  const custom = useProto((s) => s.customTemplates)
  // The invitation's own template stays listed even if the studio has since withdrawn it.
  const list = useMemo(
    () => allTemplates().filter((tpl) => (inGallery(tpl) || tpl.id === current) && (family === 'all' || tpl.family === family)),
    [custom, current, family], // eslint-disable-line react-hooks/exhaustive-deps
  )

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        {onBack && <button className="btn-ghost !py-1.5 text-xs" onClick={onBack}><ArrowLeft size={14} />{t('Back to the editor')}</button>}
        <div>
          <div className="font-display text-xl text-white">{t(current ? 'Change template' : 'Choose a template')}</div>
          <div className="text-xs text-white/45">{t(current ? 'Everything you have written and uploaded is kept.' : 'Pick a design to start from — you can change it later without losing anything.')}</div>
        </div>
        <div className="flex flex-wrap gap-2 sm:ml-auto">
          <FilterPill active={family === 'all'} onClick={() => setFamily('all')}>{t('All')}</FilterPill>
          {Object.entries(FAMILIES).map(([k, label]) => (
            <FilterPill key={k} active={family === k} onClick={() => setFamily(k)}>{t(label)}</FilterPill>
          ))}
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {list.map((tpl) => (
          <TemplateCard key={tpl.id} tpl={tpl} isCurrent={tpl.id === current} onPreview={() => setPreviewing(tpl.id)} onUse={() => onUse(tpl.id)} />
        ))}
      </div>

      {previewing && (
        <PreviewModal templateId={previewing} isCurrent={previewing === current} onClose={() => setPreviewing(null)}
          onUse={() => { setPreviewing(null); onUse(previewing) }} />
      )}
    </div>
  )
}

function TemplateCard({ tpl, isCurrent, onPreview, onUse }) {
  const t = useT()
  const sample = useMemo(() => sampleInvite(tpl.id), [tpl])
  return (
    <div className={`card overflow-hidden ${isCurrent ? 'border-gold/50' : ''}`}>
      {/* The real cover at half size: twice the card's width, scaled to fit. */}
      <button type="button" onClick={onPreview} className="block h-[280px] w-full overflow-hidden text-left" aria-label={`${t('Live preview')}: ${tpl.name}`}>
        <div style={{ width: '200%', transform: 'scale(0.5)', transformOrigin: 'top left' }} aria-hidden>
          <InviteRenderer invite={sample} mode="sample" compact only={['cover']} />
        </div>
      </button>
      <div className="p-4">
        <div className="flex items-center gap-2">
          <div className="text-white">{t(tpl.name)}</div>
          <span className="text-[10px] uppercase tracking-wider text-white/40">{t(FAMILIES[tpl.family])}</span>
          {tpl.custom && <span className="rounded-full border border-gold/30 bg-gold/10 px-2 py-0.5 text-[10px] text-gold-light">{t('Design team')}</span>}
          {isCurrent && <span className="ml-auto inline-flex items-center gap-1 text-[11px] text-gold-light"><Check size={13} />{t('In use')}</span>}
        </div>
        <p className="mt-1 text-xs text-white/50">{t(tpl.tagline)}</p>
        <div className="mt-3 flex gap-2">
          <button className="btn-ghost !py-1.5 text-xs" onClick={onPreview}><Eye size={14} />{t('Live preview')}</button>
          {!isCurrent && <button className="btn-gold !py-1.5 text-xs" onClick={onUse}>{t('Use this template')}</button>}
        </div>
      </div>
    </div>
  )
}

function PreviewModal({ templateId, isCurrent, onClose, onUse }) {
  const t = useT()
  const [device, setDevice] = useState('phone')
  const sample = useMemo(() => sampleInvite(templateId), [templateId])
  const name = templateById(templateId)?.name || ''
  return (
    <Modal title={`${t('Live preview')} · ${t(name)}`} subtitle={t('Sample content — yours replaces it.')} size="2xl" onClose={onClose}
      footer={<>
        <button className="btn-ghost" onClick={onClose}>{t('Close')}</button>
        {!isCurrent && <button className="btn-gold" onClick={onUse}>{t('Use this template')}</button>}
      </>}>
      <div className="mb-2 flex justify-end"><DeviceToggle device={device} setDevice={setDevice} /></div>
      <PreviewFrame device={device} tall="max-h-[60vh]">
        <InviteRenderer invite={sample} mode="sample" compact={device === 'phone'} />
      </PreviewFrame>
    </Modal>
  )
}
