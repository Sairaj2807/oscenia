import { useMemo, useState } from 'react'
import { Plus, X, Tag as TagIcon, Trash2, Check } from 'lucide-react'
import { useStore } from '../store/useStore'
import Modal from './Modal'
import { useT } from '../i18n'

// A tag chip. `onRemove` turns it into a removable chip; `onClick` into a toggle.
export function TagChip({ label, active, onClick, onRemove, size = 'sm' }) {
  const base = size === 'sm'
    ? 'px-2 py-0.5 text-[10px]'
    : 'px-2.5 py-1 text-xs'
  const tone = active
    ? 'border-gold/45 bg-gold/15 text-gold-light'
    : 'border-white/12 bg-white/5 text-white/60'
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border ${base} ${tone} ${
        onClick ? 'cursor-pointer hover:border-gold/40 hover:text-white transition-colors' : ''
      }`}
      onClick={onClick}
    >
      {label}
      {onRemove && (
        <button
          onClick={(e) => { e.stopPropagation(); onRemove() }}
          className="text-white/35 hover:text-rose-300"
          aria-label={`Remove ${label}`}
        >
          <X size={10} />
        </button>
      )}
    </span>
  )
}

// Multi-select tag input with inline creation. Typing a label that does not
// exist yet offers to create it, which is the whole point — the vocabulary is
// the user's, not a list hardcoded in the source.
export function TagPicker({ selected = [], onToggle, onCreate, placeholder }) {
  const tags = useStore((s) => s.tags)
  const addTag = useStore((s) => s.addTag)
  const t = useT()
  const [query, setQuery] = useState('')

  const q = query.trim().toLowerCase()
  const matches = useMemo(
    () => tags.filter((tag) => !q || tag.label.toLowerCase().includes(q)),
    [tags, q]
  )
  // Only offer creation when nothing already carries that exact label.
  const exact = tags.some((tag) => tag.label.toLowerCase() === q)
  const canCreate = q.length > 1 && !exact

  const create = async () => {
    const tag = await addTag(query)
    if (tag) {
      if (!selected.includes(tag.id)) onToggle(tag.id)
      onCreate?.(tag)
    }
    setQuery('')
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 rounded-lg border border-white/10 bg-navy-900 px-3 py-2 focus-within:border-gold/50">
        <TagIcon size={14} className="text-white/40 shrink-0" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              if (canCreate) create()
              else if (matches.length === 1) { onToggle(matches[0].id); setQuery('') }
            }
          }}
          placeholder={placeholder || t('Filter or create a tag…')}
          className="w-full bg-transparent text-sm text-white/85 placeholder:text-white/30 outline-none"
        />
        {canCreate && (
          <button
            onClick={create}
            className="inline-flex shrink-0 items-center gap-1 rounded-md border border-gold/40 bg-gold/10 px-2 py-0.5 text-[10px] text-gold-light hover:bg-gold/20"
          >
            <Plus size={10} /> {t('Create')} “{query.trim()}”
          </button>
        )}
      </div>

      <div className="flex flex-wrap gap-1.5">
        {matches.map((tag) => (
          <TagChip
            key={tag.id}
            label={tag.label}
            active={selected.includes(tag.id)}
            onClick={() => onToggle(tag.id)}
            size="md"
          />
        ))}
        {!matches.length && !canCreate && (
          <span className="text-xs text-white/30">{t('No tags match.')}</span>
        )}
      </div>
    </div>
  )
}

// Vocabulary manager: rename or delete tags. Deleting cascades, so it says so.
export function TagManagerModal({ onClose }) {
  const tags = useStore((s) => s.tags)
  const vendors = useStore((s) => s.vendors)
  const catalogue = useStore((s) => s.vendorCatalogue)
  const addTag = useStore((s) => s.addTag)
  const renameTag = useStore((s) => s.renameTag)
  const deleteTag = useStore((s) => s.deleteTag)
  const t = useT()
  const [fresh, setFresh] = useState('')
  const [editing, setEditing] = useState(null)
  const [draft, setDraft] = useState('')

  const usage = (id) => ({
    vendors: vendors.filter((v) => (v.tags || []).includes(id)).length,
    items: catalogue.filter((i) => (i.tags || []).includes(id)).length,
  })

  return (
    <Modal
      title="Manage Tags"
      subtitle={t('Tags apply to vendors and catalogue items. Deleting one removes it everywhere.')}
      size="xl"
      onClose={onClose}
      footer={<button onClick={onClose} className="btn-gold">{t('Done')}</button>}
    >
      <div className="flex items-center gap-2">
        <input
          value={fresh}
          onChange={(e) => setFresh(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && fresh.trim()) { addTag(fresh); setFresh('') } }}
          placeholder={t('New tag name')}
          className="flex-1 rounded-lg border border-white/10 bg-navy-900 p-2.5 text-sm text-white/85 placeholder:text-white/30 focus:border-gold/50 outline-none"
        />
        <button
          onClick={() => { if (fresh.trim()) { addTag(fresh); setFresh('') } }}
          disabled={!fresh.trim()}
          className="btn-gold"
        >
          <Plus size={14} /> {t('Add')}
        </button>
      </div>

      <div className="space-y-1.5">
        {tags.map((tag) => {
          const u = usage(tag.id)
          const inUse = u.vendors + u.items
          return (
            <div key={tag.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-white/5 bg-white/[0.02] px-3 py-2">
              {editing === tag.id ? (
                <>
                  <input
                    autoFocus
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') { renameTag(tag.id, draft); setEditing(null) }
                      if (e.key === 'Escape') setEditing(null)
                    }}
                    className="flex-1 min-w-[140px] rounded border border-gold/40 bg-navy-900 px-2 py-1 text-sm text-white/85 outline-none"
                  />
                  <button onClick={() => { renameTag(tag.id, draft); setEditing(null) }} className="text-emerald-400 hover:text-emerald-300">
                    <Check size={14} />
                  </button>
                  <button onClick={() => setEditing(null)} className="text-white/30 hover:text-white">
                    <X size={14} />
                  </button>
                </>
              ) : (
                <>
                  <button
                    onClick={() => { setEditing(tag.id); setDraft(tag.label) }}
                    className="flex-1 min-w-[140px] text-left text-sm text-white/85 hover:text-gold-light"
                    title={t('Click to rename')}
                  >
                    {tag.label}
                  </button>
                  <span className="font-mono text-[10px] text-white/25">{tag.id}</span>
                  <span className="text-[11px] text-white/40 tabular-nums w-28 text-right">
                    {u.vendors} {t('vendors')} · {u.items} {t('items')}
                  </span>
                  <button
                    onClick={() => deleteTag(tag.id)}
                    className="text-white/30 hover:text-rose-300"
                    title={inUse ? `${t('Applied to')} ${inUse} ${t('records')}` : t('Not in use')}
                  >
                    <Trash2 size={14} />
                  </button>
                </>
              )}
            </div>
          )
        })}
      </div>
    </Modal>
  )
}
