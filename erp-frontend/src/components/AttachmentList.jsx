// A list of attached files with a drop zone: used by tasks (W2) and meetings (CH4).
// PDF, JPG, PNG or Word, up to 10 MB each. The browser reads each file — a small preview for
// images, the whole file only when small — and the store decides what the prototype can keep
// (lib/attachments.js). `viewOnly` shows name and size only: no opening, no download.
import { useState } from 'react'
import { FileText, Download, Trash2, Upload, Image as ImageIcon, X } from 'lucide-react'
import { useProto } from '../store/chatProto'
import { useStore } from '../store/useStore'
import { stamp } from './workspace/parts'
import { shrinkImage, readAsDataUrl } from '../lib/images'
import { ACCEPT, checkFile, fileKind, humanSize, KEEP_WHOLE_BYTES, MAX_FILE_BYTES } from '../lib/attachments'
import { useT } from '../i18n'

/** Reads a picked file into what the store may keep: details, plus a preview or the file itself. */
export async function readForStore(f) {
  let preview
  let data
  try {
    if (fileKind(f.name) === 'image') preview = await shrinkImage(f, { maxSide: 480, maxBytes: 120_000, quality: 0.7 })
    else if (f.size <= KEEP_WHOLE_BYTES) data = await readAsDataUrl(f)
  } catch { /* keep just the details */ }
  return { name: f.name, type: f.type, size: f.size, preview, data }
}

export default function AttachmentList({ list, canAdd, onAdd, onOpen, mayRemove = () => false, onRemove, viewOnly = false, compact = false }) {
  const t = useT()
  const members = useProto((s) => s.members)
  const pushToast = useStore((s) => s.pushToast)
  const [viewing, setViewing] = useState(null)
  const [busy, setBusy] = useState(false)
  const [over, setOver] = useState(false)
  const who = (id) => members.find((m) => m.id === id)?.name || id

  const add = async (files) => {
    setBusy(true)
    for (const f of files) {
      const problem = checkFile({ name: f.name, type: f.type, size: f.size })
      if (problem) { pushToast({ title: t('Not attached'), body: problem, kind: 'redflag' }); continue }
      // `file` is the browser's own File, for a server that keeps the bytes; the demo ignores it.
      const r = await onAdd({ ...(await readForStore(f)), file: f })
      if (r?.error) pushToast({ title: t('Not attached'), body: r.error, kind: 'redflag' })
      else pushToast({ title: t('File attached'), body: `${f.name} · ${humanSize(f.size)}`, kind: 'project' })
    }
    setBusy(false)
  }

  const openFile = (a) => {
    if (a.stored && onOpen) return onOpen(a) // the server holds it: open by a fresh link
    if (a.kind === 'image' && a.preview) return setViewing(a)
    if (a.data) {
      // A data URL cannot be opened in a new tab directly any more; a blob URL can.
      fetch(a.data).then((r) => r.blob()).then((b) => window.open(URL.createObjectURL(b), '_blank', 'noopener'))
    }
  }

  return (
    <>
      {list.length > 0 && (
        <ul className="mb-3 space-y-1.5">
          {list.map((a) => {
            const kept = Boolean(a.preview || a.data || a.stored)
            return (
              <li key={a.id} className="flex items-center gap-3 rounded-lg border border-white/10 bg-white/[0.02] p-2">
                {viewOnly ? (
                  <span className="grid h-10 w-10 shrink-0 place-items-center rounded-md bg-white/5">
                    {a.kind === 'image' ? <ImageIcon size={18} className="text-white/40" /> : <FileText size={18} className={a.kind === 'pdf' ? 'text-rose-300' : 'text-sky-300'} />}
                  </span>
                ) : (
                  <button onClick={() => openFile(a)} disabled={!kept} className="grid h-10 w-10 shrink-0 place-items-center overflow-hidden rounded-md bg-white/5 disabled:cursor-default" aria-label={`${t('Open')} ${a.name}`}>
                    {a.preview ? <img src={a.preview} alt="" className="h-full w-full object-cover" />
                      : a.kind === 'image' ? <ImageIcon size={18} className="text-white/40" /> : <FileText size={18} className={a.kind === 'pdf' ? 'text-rose-300' : 'text-sky-300'} />}
                  </button>
                )}
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm text-white/85" title={a.name}>{a.name}</div>
                  <div className="text-[11px] text-white/40">
                    {humanSize(a.size)} · {who(a.by)} · {stamp(a.at)}
                    {viewOnly ? <span className="text-white/30"> · {t('view only')}</span>
                      : !kept && <span className="text-white/30"> · {t('details only (prototype)')}</span>}
                  </div>
                </div>
                {!viewOnly && a.data && (
                  <a href={a.data} download={a.name} className="text-white/45 hover:text-gold-light" title={t('Download')} aria-label={`${t('Download')} ${a.name}`}><Download size={15} /></a>
                )}
                {mayRemove(a) && (
                  <button onClick={() => { if (window.confirm(`${t('Remove')} ${a.name}?`)) onRemove(a) }}
                    className="text-white/35 hover:text-rose-300" title={t('Remove')} aria-label={`${t('Remove')} ${a.name}`}><Trash2 size={15} /></button>
                )}
              </li>
            )
          })}
        </ul>
      )}
      {canAdd ? (
        <label
          onDragOver={(e) => { e.preventDefault(); setOver(true) }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => { e.preventDefault(); setOver(false); add([...e.dataTransfer.files]) }}
          className={`flex cursor-pointer flex-col items-center gap-1 rounded-lg border border-dashed px-3 ${compact ? 'py-2' : 'py-4'} text-center text-xs ${over ? 'border-gold/60 bg-gold/5' : 'border-white/15 hover:border-white/30'}`}
        >
          <Upload size={16} className="text-white/40" />
          <span className="text-white/70">{busy ? t('Attaching…') : t('Drop files here or click to attach')}</span>
          <span className="text-white/35">{t('PDF, JPG, PNG or Word (.docx)')} · {t('up to')} {humanSize(MAX_FILE_BYTES)} {t('each')}</span>
          <input type="file" multiple accept={ACCEPT} className="hidden" disabled={busy} aria-label={t('Attach files')}
            onChange={(e) => { const files = [...e.target.files]; e.target.value = ''; add(files) }} />
        </label>
      ) : list.length === 0 && (
        <div className="text-xs text-white/35">{t('No files.')}</div>
      )}
      {!viewOnly && list.some((a) => !a.preview && !a.data && !a.stored) && (
        <p className="mt-2 text-[11px] text-white/30">{t('Prototype: large files keep only their details here; with the backend every file is stored in full.')}</p>
      )}

      {viewing && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/80 p-4" onClick={() => setViewing(null)} role="dialog" aria-label={viewing.name}>
          <div className="max-h-full max-w-full" onClick={(e) => e.stopPropagation()}>
            <img src={viewing.preview} alt={viewing.name} className="max-h-[80vh] max-w-full rounded-lg" />
            <div className="mt-2 flex items-center justify-between gap-3 text-sm text-white/80">
              <span className="truncate">{viewing.name}</span>
              <button onClick={() => setViewing(null)} className="text-white/60 hover:text-white" aria-label={t('Close')}><X size={18} /></button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
