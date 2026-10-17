// The editor's form for each invitation section (Invitations v2). Every form gets the
// section's content and `save(next)`, which replaces it (the store cleans and caps it).
// Uploads go to the server when signed in or on the client's link, and to this browser's IndexedDB
// in the signed-out demo (the store's `uploadMedia`); the content keeps a reference.
import { useEffect, useRef, useState } from 'react'
import { Upload, Trash2, Plus, Loader2, Film, Play, Pause, Check, Eye, EyeOff, X } from 'lucide-react'
import { shrinkImage } from '../../lib/images'
import { dataUrlToBlob, checkMedia, MEDIA_RULES } from '../../lib/mediaStore'
import { LIMITS, MUSIC_TRACKS, videoEmbed, wishState } from '../../lib/invites'
import { useProto } from '../../store/chatProto'
import { useMusic } from './guest'
import { safeLink } from '../../lib/events'
import { humanSize } from '../../lib/attachments'
import { Img, useMediaScope } from './media'
import { useT } from '../../i18n'

export const INPUT = 'w-full rounded-lg border border-white/10 bg-navy-950 px-2.5 py-2 text-sm text-white/85 outline-none focus:border-gold/50'
const HINT = 'text-[11px] text-white/40'
const WARN = 'text-[11px] text-amber-300'

// Photos are shrunk before they are kept, so the page stays quick on a phone.
const PHOTO = {
  cover: { maxWidth: 1600, maxBytes: 900_000, quality: 0.82 },
  gallery: { maxSide: 1400, maxBytes: 700_000, quality: 0.8 },
  face: { maxSide: 600, maxBytes: 250_000, quality: 0.82 },
}

// --- building blocks -------------------------------------------------------------

export function Text({ label, value, onChange, type = 'text', placeholder, long = false }) {
  const t = useT()
  return (
    <label className="block">
      <span className="text-[11px] text-white/45">{t(label)}</span>
      {long
        ? <textarea rows={4} value={value || ''} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} className={`${INPUT} mt-1`} />
        : <input type={type} value={value || ''} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} className={`${INPUT} mt-1`} />}
    </label>
  )
}

/** Where the copy about a file's home is told apart: the demo keeps it in this browser, the rest on the server. */
function Where({ demo, live: onServer, className = HINT }) {
  const t = useT()
  const live = useProto((s) => s.live)
  const text = live ? onServer : demo
  return text ? <p className={className}>{t(text)}</p> : null
}

// What a person can read when an upload fails (the server's own refusals are already sentences).
const uploadProblem = (err, t) => {
  if (err instanceof TypeError) return t('Could not reach the server. Please try again.')
  if (err?.status === 429) return t('The server is busy. Please try again in a moment.')
  if (err?.status === 413) return t('That file is too large.')
  return err?.message || t('The upload failed.')
}

/**
 * Pick a file → check it → store it → hand back the reference. `kind` is photo | video | music
 * | logo | art (a logo or a studio template's artwork is kept as uploaded, so a transparent PNG
 * stays transparent). `templateId` is for a studio template's artwork; otherwise the file belongs to
 * the event the editor is open on (`MediaScope`). A video or song shows its progress and can be cancelled.
 */
export function UploadButton({ kind, size = 'gallery', multiple = false, label = 'Upload', onDone, disabled: off, templateId }) {
  const t = useT()
  const upload = useProto((s) => s.uploadMedia)
  const { eventId } = useMediaScope()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [progress, setProgress] = useState(null) // { name, fraction } while a file goes out
  const abort = useRef(null)
  // Closing the editor mid-upload stops it.
  useEffect(() => () => abort.current?.abort(), [])
  const rule = kind === 'logo' || kind === 'art' ? 'photo' : kind
  const slow = rule === 'video' || rule === 'music'
  const onPick = async (e) => {
    const files = [...(e.target.files || [])]
    e.target.value = ''
    if (!files.length) return
    setBusy(true)
    setError('')
    const control = new AbortController()
    abort.current = control
    const refs = []
    for (const file of files) {
      if (control.signal.aborted) break
      const problem = checkMedia(file, rule)
      if (problem) { setError(`${file.name}: ${t(problem)}`); continue }
      if (kind === 'logo' && file.size > 2 * 1024 * 1024) { setError(`${file.name}: ${t('Logos must be under 2 MB.')}`); continue }
      if (kind === 'art' && file.size > 5 * 1024 * 1024) { setError(`${file.name}: ${t('Artwork must be under 5 MB.')}`); continue }
      try {
        // A photo is shrunk first so the page stays quick on a phone; the rest go as picked.
        const body = kind === 'photo' ? await dataUrlToBlob(await shrinkImage(file, PHOTO[size])) : file
        const type = kind === 'photo' ? 'image/jpeg' : file.type
        // A shrunk photo is a JPEG whatever it was picked as; the server checks the name against the type.
        const name = kind === 'photo' ? `${file.name.replace(/\.[^.]+$/, '')}.jpg` : file.name
        setProgress({ name: file.name, fraction: 0 })
        refs.push(await upload(body, {
          name, type, kind: rule, eventId, templateId, signal: control.signal,
          onProgress: (fraction) => setProgress({ name: file.name, fraction }),
        }))
      } catch (err) {
        if (err?.name === 'AbortError') break
        setError(`${file.name}: ${uploadProblem(err, t)}`)
      }
    }
    abort.current = null
    setProgress(null)
    setBusy(false)
    if (refs.length && !control.signal.aborted) onDone(multiple ? refs : refs[0])
  }
  return (
    <div>
      <div className="flex items-center gap-2">
        <label className={`btn-ghost !py-1.5 text-xs ${disabled(off, busy) ? 'pointer-events-none opacity-40' : 'cursor-pointer'}`}>
          {busy ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}{t(label)}
          <input type="file" accept={MEDIA_RULES[rule].accept} multiple={multiple} onChange={onPick} className="hidden" disabled={disabled(off, busy)} />
        </label>
        {busy && slow && (
          <button type="button" className="btn-ghost !py-1.5 text-xs" onClick={() => abort.current?.abort()}><X size={14} />{t('Cancel')}</button>
        )}
      </div>
      {busy && progress && slow && (
        <p className="mt-1 truncate text-[11px] text-white/50" role="status">{progress.name} {Math.round(progress.fraction * 100)}%</p>
      )}
      {error && <p role="alert" className="mt-1 text-[11px] text-rose-300">{error}</p>}
    </div>
  )
}

const disabled = (off, busy) => Boolean(off || busy)

/** One photo field: thumbnail, replace, remove. */
function PhotoField({ label, value, size = 'face', onChange }) {
  const t = useT()
  return (
    <div>
      <div className="mb-1 text-[11px] text-white/45">{t(label)}</div>
      <div className="flex items-center gap-2">
        <div className="h-12 w-12 shrink-0 overflow-hidden rounded-lg border border-white/10 bg-navy-950">
          <Img src={value} className="h-full w-full object-cover" />
        </div>
        <UploadButton kind="photo" size={size} label={value ? 'Replace' : 'Upload photo'} onDone={onChange} />
        {value && <button type="button" className="btn-ghost !py-1.5 text-xs" onClick={() => onChange(null)}><Trash2 size={14} />{t('Remove')}</button>}
      </div>
    </div>
  )
}

/** A list of rows with add / remove, up to `max`. */
function Rows({ items, max, blank, addLabel, onChange, children }) {
  const t = useT()
  const set = (i, patch) => onChange(items.map((x, j) => (j === i ? { ...x, ...patch } : x)))
  return (
    <div className="space-y-2">
      {items.map((item, i) => (
        <div key={i} className="relative rounded-lg border border-white/10 p-2.5 pr-9">
          {children(item, (patch) => set(i, patch))}
          <button type="button" onClick={() => onChange(items.filter((_, j) => j !== i))} className="absolute right-2 top-2 text-white/35 hover:text-rose-300" aria-label={t('Remove')}>
            <Trash2 size={15} />
          </button>
        </div>
      ))}
      {items.length < max
        ? <button type="button" onClick={() => onChange([...items, blank()])} className="inline-flex items-center gap-1 text-xs text-gold/80 hover:text-gold-light"><Plus size={13} />{t(addLabel)}</button>
        : <p className={HINT}>{t('Up to')} {max}.</p>}
    </div>
  )
}

// --- the forms ---------------------------------------------------------------------

function CoverForm({ v, save }) {
  return (
    <>
      <Text label="Small line above the title" value={v.eyebrow} onChange={(x) => save({ ...v, eyebrow: x })} />
      <Text label="Title" value={v.title} onChange={(x) => save({ ...v, title: x })} />
      <Text label="Subtitle" value={v.subtitle} onChange={(x) => save({ ...v, subtitle: x })} />
      <PhotoField label="Cover photo" size="cover" value={v.image} onChange={(x) => save({ ...v, image: x })} />
    </>
  )
}

function MessageForm({ v, save }) {
  return <Text long label="Message to guests" value={v.body} onChange={(x) => save({ ...v, body: x })} />
}

function CoupleForm({ v, save }) {
  const t = useT()
  const person = (k, title) => (
    <div className="space-y-2 rounded-lg border border-white/10 p-2.5">
      <div className="text-xs text-white/60">{t(title)}</div>
      <Text label="Name" value={v[k].name} onChange={(x) => save({ ...v, [k]: { ...v[k], name: x } })} />
      <Text label="Parents (optional)" value={v[k].parents} placeholder="Son of Mr. … & Mrs. …" onChange={(x) => save({ ...v, [k]: { ...v[k], parents: x } })} />
      <Text label="Instagram (optional)" value={v[k].ig} placeholder="@name" onChange={(x) => save({ ...v, [k]: { ...v[k], ig: x } })} />
      <PhotoField label="Photo" value={v[k].photo} onChange={(x) => save({ ...v, [k]: { ...v[k], photo: x } })} />
    </div>
  )
  return <>{person('a', 'First person')}{person('b', 'Second person')}</>
}

function HostsForm({ v, save }) {
  const t = useT()
  return (
    <>
      <Text label="Hosted by" value={v.names} placeholder="Hosted by … · with …" onChange={(x) => save({ ...v, names: x })} />
      <div>
        <div className="mb-1 text-[11px] text-white/45">{t('Logos')} ({v.logos.length}/{LIMITS.logos})</div>
        <div className="flex flex-wrap gap-2">
          {v.logos.map((l, i) => (
            <div key={l.key || i} className="group relative h-12 w-20 rounded-lg border border-white/10 bg-white p-1">
              <Img src={l} className="h-full w-full object-contain" />
              <button type="button" onClick={() => save({ ...v, logos: v.logos.filter((_, j) => j !== i) })} className="absolute -right-1.5 -top-1.5 rounded-full bg-navy-900 p-0.5 text-white/60 hover:text-rose-300" aria-label={t('Remove')}><Trash2 size={12} /></button>
            </div>
          ))}
        </div>
        <div className="mt-2"><UploadButton kind="logo" multiple label="Add logos" disabled={v.logos.length >= LIMITS.logos} onDone={(refs) => save({ ...v, logos: [...v.logos, ...refs].slice(0, LIMITS.logos) })} /></div>
        <p className={`${HINT} mt-1`}>{t('PNG with a transparent background looks best.')}</p>
      </div>
    </>
  )
}

function SessionFields({ s, set }) {
  const t = useT()
  return (
    <>
      <div className="grid grid-cols-2 gap-2">
        <Text label="Date" type="date" value={s.date} onChange={(x) => set({ date: x })} />
        <Text label="Time" type="time" value={s.time} onChange={(x) => set({ time: x })} />
      </div>
      <Text label="Venue" value={s.venue} onChange={(x) => set({ venue: x })} />
      <Text label="Map link" value={s.mapUrl} placeholder="https://maps.google.com/…" onChange={(x) => set({ mapUrl: x })} />
      {s.mapUrl && !safeLink(s.mapUrl) && <p className={WARN}>{t('Use a full link starting with https:// — otherwise guests see no map button.')}</p>}
    </>
  )
}

function DetailsForm({ v, save, event }) {
  const t = useT()
  const set = (patch) => save({ ...v, ...patch })
  return (
    <>
      {v.sessions.length > 0 && <Text label="Name of the main event" value={v.name} placeholder="e.g. Holy Matrimony" onChange={(x) => set({ name: x })} />}
      <SessionFields s={v} set={set} />
      {event.published && <p className={HINT}>{t('A new date or venue reaches guests, reminders and check-in when Oscenia publishes the change.')}</p>}
      <div className="border-t border-white/10 pt-3">
        <div className="mb-1 text-sm text-white/80">{t('More sessions')}</div>
        <p className={`${HINT} mb-2`}>{t('e.g. a ceremony in the morning and a reception in the evening.')}</p>
        <Rows items={v.sessions} max={LIMITS.sessions} addLabel="Add a session"
          blank={() => ({ id: `S-${Date.now().toString(36)}`, name: '', date: v.date, time: '', venue: '', mapUrl: '' })}
          onChange={(sessions) => set({ sessions })}>
          {(s, setS) => (<div className="space-y-2"><Text label="Session name" value={s.name} placeholder="Reception" onChange={(x) => setS({ name: x })} /><SessionFields s={s} set={setS} /></div>)}
        </Rows>
      </div>
    </>
  )
}

function AgendaForm({ v, save }) {
  const t = useT()
  return (
    <Rows items={v.rows} max={LIMITS.rows} addLabel="Add programme item" blank={() => ({ time: '', label: '' })} onChange={(rows) => save({ ...v, rows })}>
      {(r, set) => (
        <div className="flex gap-2">
          <input value={r.time} onChange={(e) => set({ time: e.target.value })} className={`${INPUT} !w-20`} aria-label={t('Time')} placeholder="19:00" />
          <input value={r.label} onChange={(e) => set({ label: e.target.value })} className={INPUT} aria-label={t('What happens')} placeholder={t('What happens')} />
        </div>
      )}
    </Rows>
  )
}

function SpeakersForm({ v, save }) {
  return (
    <Rows items={v.people} max={LIMITS.people} addLabel="Add a speaker" blank={() => ({ name: '', role: '', photo: null })} onChange={(people) => save({ ...v, people })}>
      {(p, set) => (
        <div className="space-y-2">
          <Text label="Name" value={p.name} onChange={(x) => set({ name: x })} />
          <Text label="Role" value={p.role} placeholder="CEO, Company" onChange={(x) => set({ role: x })} />
          <PhotoField label="Photo" value={p.photo} onChange={(x) => set({ photo: x })} />
        </div>
      )}
    </Rows>
  )
}

function StoryForm({ v, save }) {
  return (
    <Rows items={v.items} max={LIMITS.items} addLabel="Add a moment" blank={() => ({ date: '', title: '', text: '' })} onChange={(items) => save({ ...v, items })}>
      {(s, set) => (
        <div className="space-y-2">
          <div className="grid grid-cols-[5rem_1fr] gap-2">
            <Text label="When" value={s.date} placeholder="2019" onChange={(x) => set({ date: x })} />
            <Text label="Title" value={s.title} placeholder="First meeting" onChange={(x) => set({ title: x })} />
          </div>
          <Text long label="What happened" value={s.text} onChange={(x) => set({ text: x })} />
        </div>
      )}
    </Rows>
  )
}

function DressCodeForm({ v, save }) {
  return <Text label="Dress code" value={v.text} placeholder="Black tie" onChange={(x) => save({ ...v, text: x })} />
}

function GalleryForm({ v, save }) {
  const t = useT()
  const left = LIMITS.photos - v.photos.length
  return (
    <div>
      <div className="grid grid-cols-4 gap-2">
        {v.photos.map((p, i) => (
          <div key={p.key || i} className="relative aspect-square overflow-hidden rounded-lg border border-white/10 bg-navy-950">
            <Img src={p} className="h-full w-full object-cover" />
            <button type="button" onClick={() => save({ ...v, photos: v.photos.filter((_, j) => j !== i) })} className="absolute right-1 top-1 rounded-full bg-navy-900/80 p-1 text-white/70 hover:text-rose-300" aria-label={t('Remove')}><Trash2 size={12} /></button>
          </div>
        ))}
      </div>
      <div className="mt-2 flex items-center gap-3">
        <UploadButton kind="photo" multiple label="Add photos" disabled={left <= 0} onDone={(refs) => save({ ...v, photos: [...v.photos, ...refs].slice(0, LIMITS.photos) })} />
        <span className={HINT}>{v.photos.length}/{LIMITS.photos}</span>
      </div>
      <Where className={`${HINT} mt-1`} demo="Saved in this browser only (prototype) — with the backend, photos are stored for every guest." live="Photos are stored for every guest." />
    </div>
  )
}

function VideoForm({ v, save }) {
  const t = useT()
  const tab = (kind, label) => (
    <button type="button" onClick={() => save({ ...v, kind })} className={`flex-1 rounded-md px-2 py-1.5 text-xs ${v.kind === kind ? 'bg-gold/20 text-gold-light' : 'text-white/55'}`}>{t(label)}</button>
  )
  return (
    <>
      <div className="flex rounded-lg border border-white/10 p-0.5">{tab('link', 'YouTube / Vimeo link')}{tab('upload', 'Upload a video')}</div>
      {v.kind === 'link' ? (
        <>
          <Text label="Video link" value={v.url} placeholder="https://www.youtube.com/watch?v=…" onChange={(x) => save({ ...v, url: x })} />
          {v.url && !videoEmbed(v.url) && <p className={WARN}>{t('Paste a YouTube or Vimeo link — other links cannot be played on the invitation.')}</p>}
        </>
      ) : (
        <>
          {v.file && (
            <div className="flex items-center gap-2 rounded-lg border border-white/10 p-2 text-xs text-white/70">
              <Film size={15} className="shrink-0 text-gold/80" />
              <span className="min-w-0 flex-1 truncate">{v.file.name}</span>
              <span className="text-white/40">{humanSize(v.file.size)}</span>
              <button type="button" onClick={() => save({ ...v, file: null })} className="text-white/40 hover:text-rose-300" aria-label={t('Remove')}><Trash2 size={14} /></button>
            </div>
          )}
          <UploadButton kind="video" label={v.file ? 'Replace video' : 'Upload video'} onDone={(ref) => save({ ...v, file: ref })} />
          <Where demo="MP4, MOV or WebM, up to 200 MB. Saved in this browser only (prototype): other phones see it once the backend is live — a YouTube link works everywhere today." live="MP4, MOV or WebM, up to 200 MB. Large videos take a while to upload; a YouTube link is quicker." />
        </>
      )}
    </>
  )
}

function GiftForm({ v, save }) {
  return (
    <>
      <Rows items={v.accounts} max={LIMITS.accounts} addLabel="Add an account" blank={() => ({ bank: '', number: '', holder: '' })} onChange={(accounts) => save({ ...v, accounts })}>
        {(a, set) => (
          <div className="space-y-2">
            <Text label="Bank or e-wallet" value={a.bank} placeholder="BCA, Mandiri, GoPay…" onChange={(x) => set({ bank: x })} />
            <Text label="Account number" value={a.number} onChange={(x) => set({ number: x })} />
            <Text label="Account holder" value={a.holder} onChange={(x) => set({ holder: x })} />
          </div>
        )}
      </Rows>
      <Text long label="Gift delivery address (optional)" value={v.address} onChange={(x) => save({ ...v, address: x })} />
    </>
  )
}

function Note({ children }) {
  const t = useT()
  return <p className={HINT}>{t(children)}</p>
}

export function MusicForm({ v, save }) {
  const t = useT()
  // Closing this form (or the editor) stops the preview: useMusic stops on unmount.
  const listen = useMusic(v)
  return (
    <>
      <div className="flex items-center justify-between">
        <span className="text-[11px] text-white/45">{t('Choose a track or upload your own')}</span>
        {listen.available && (
          <button type="button" onClick={listen.toggle} aria-pressed={listen.playing} className="btn-ghost !py-1 text-xs">
            {listen.playing ? <Pause size={13} /> : <Play size={13} />}{t(listen.playing ? 'Stop' : 'Listen')}
          </button>
        )}
      </div>
      <div className="grid grid-cols-3 gap-2">
        {MUSIC_TRACKS.map((tr) => (
          <button key={tr.id} type="button" onClick={() => save({ ...v, kind: 'builtin', trackId: tr.id })}
            className={`rounded-lg border px-2 py-2 text-xs ${v.kind === 'builtin' && v.trackId === tr.id ? 'border-gold/60 bg-gold/10 text-gold-light' : 'border-white/10 text-white/65 hover:border-white/25'}`}>
            {t(tr.name)}
          </button>
        ))}
      </div>
      <div className="flex items-center gap-2">
        <UploadButton kind="music" label={v.kind === 'upload' && v.file ? 'Replace song' : 'Upload your song'} onDone={(ref) => save({ ...v, kind: 'upload', file: ref })} />
        {v.kind === 'upload' && v.file && <span className="min-w-0 truncate text-xs text-white/55">{v.file.name}</span>}
      </div>
      <Where demo="Plays when the guest opens the invitation, with a pause button. MP3 or M4A up to 20 MB, saved in this browser only (prototype). Built-in tracks are placeholders." live="Plays when the guest opens the invitation, with a pause button. MP3 or M4A up to 20 MB. Built-in tracks are placeholders." />
    </>
  )
}

const WISH_BADGE = {
  shown: ['Shown', 'text-emerald-300/80'],
  waiting: ['Waiting for approval', 'text-amber-300'],
  hidden: ['Hidden', 'text-white/35'],
}

/**
 * The wishes guests have left (D13), for staff and the client alike: hold new ones for
 * approval, approve, hide or show again. Unlike the rest of the editor this is live — it
 * applies straight away, with no need to publish.
 */
function WishesForm({ event }) {
  const t = useT()
  const { setHoldWishes, setWishHidden, approveWish } = useProto.getState()
  const wishes = [...(event.wishes || [])].reverse()
  const waiting = wishes.filter((w) => wishState(event, w) === 'waiting').length
  return (
    <>
      <label className="flex items-start gap-2 text-sm text-white/80">
        <input type="checkbox" className="mt-0.5 accent-[#c6a15b]" checked={Boolean(event.holdWishes)} onChange={(e) => setHoldWishes(event.id, e.target.checked)} />
        <span>
          {t('Hold wishes for approval')}
          <span className="block text-[11px] text-white/40">{t('New wishes wait here until you approve them. Turning this off shows any that are waiting.')}</span>
        </span>
      </label>
      <p className={HINT}>
        {wishes.length ? `${wishes.length} ${t(wishes.length === 1 ? 'wish' : 'wishes')}${waiting ? ` · ${waiting} ${t('waiting')}` : ''} · ` : ''}
        {t('Changes here apply straight away — no need to publish.')}
      </p>
      <ul className="max-h-80 space-y-2 overflow-y-auto">
        {wishes.map((w) => {
          const state = wishState(event, w)
          const [badge, tone] = WISH_BADGE[state]
          return (
            <li key={w.id} className={`rounded-lg border border-white/10 p-2.5 ${state === 'hidden' ? 'opacity-60' : ''}`}>
              <div className="flex items-center gap-2 text-xs">
                <span className="min-w-0 truncate text-white/85">{w.name}</span>
                <span className={`shrink-0 text-[10px] ${tone}`}>{t(badge)}</span>
                <span className="ml-auto shrink-0 text-[10px] text-white/30">{w.at?.replace('T', ' ')}</span>
              </div>
              <p className="mt-1 whitespace-pre-line text-xs text-white/65">{w.text}</p>
              <div className="mt-2 flex gap-2">
                {state === 'waiting' && <button type="button" className="btn-ghost !py-1 text-[11px]" onClick={() => approveWish(event.id, w.id)}><Check size={12} />{t('Approve')}</button>}
                {state === 'hidden'
                  ? <button type="button" className="btn-ghost !py-1 text-[11px]" onClick={() => setWishHidden(event.id, w.id, false)}><Eye size={12} />{t('Show again')}</button>
                  : <button type="button" className="btn-ghost !py-1 text-[11px]" onClick={() => setWishHidden(event.id, w.id, true)}><EyeOff size={12} />{t('Hide')}</button>}
              </div>
            </li>
          )
        })}
        {!wishes.length && <li className={HINT}>{t('No wishes yet. Guests write them on the invitation once it is published.')}</li>}
      </ul>
    </>
  )
}

/** Section id → form. Sections without settings explain where their content comes from. */
export const SECTION_FORMS = {
  cover: CoverForm,
  message: MessageForm,
  couple: CoupleForm,
  hosts: HostsForm,
  countdown: () => <Note>Counts down to the date in “Date & venue”, and hides itself once the event begins.</Note>,
  details: DetailsForm,
  agenda: AgendaForm,
  speakers: SpeakersForm,
  story: StoryForm,
  dresscode: DressCodeForm,
  gallery: GalleryForm,
  video: VideoForm,
  rsvp: ({ clientMode }) => <Note>{clientMode ? 'Guests reply here and get their QR access card. Oscenia sets the questions — ask your coordinator to change them.' : 'Guests reply here and get their QR access card. The form’s questions are under “RSVP settings” below.'}</Note>,
  wishes: WishesForm,
  gift: GiftForm,
}
