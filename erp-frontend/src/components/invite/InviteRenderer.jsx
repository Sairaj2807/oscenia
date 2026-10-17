// Draws an invitation: the template's sections in order, in its colours and fonts. The guest
// page, the editor's live preview and the gallery's sample preview all use it, so what the
// client designs is exactly what guests get.
//
// mode: 'live' (guest page) · 'preview' (editor: empty sections still hidden, like live) ·
//       'sample' (gallery: the template's own demo content, stand-in photos).
// `template` draws with a template object instead of the invitation's (Template Studio: the
// unsaved design being edited), each section at its default.
//
// The lightbox, copy buttons and Add to calendar are built in, so the editor's preview works
// like the guest page; `slots` can add or replace pieces (the guest page's RSVP and wish form).
import { useState } from 'react'
import { themeOf } from '../../lib/templates'
import { visibleSections, blankContent, hasContent } from '../../lib/invites'
import { SECTION_COMPONENTS } from './sections'
import { Lightbox, CopyButton, AddToCalendar } from './guest'
import { useMediaUrl } from './media'

/** The template's colours and fonts as the CSS variables the sections read. */
export function themeVars(invite, template = null) {
  const { palette, fonts } = template || themeOf(invite)
  return {
    '--inv-bg': palette.bg,
    '--inv-surface': palette.surface,
    '--inv-accent': palette.accent,
    '--inv-text': palette.text,
    '--inv-heading': fonts.heading,
    '--inv-body': fonts.body,
    '--inv-script': fonts.script || fonts.heading,
    background: palette.bg,
    color: palette.text,
    fontFamily: fonts.body,
  }
}

/** The template's demo content laid over empty content, for gallery previews. */
export function sampleInvite(templateId, tpl = themeOf({ templateId }).tpl) {
  const base = blankContent()
  const content = Object.fromEntries(Object.entries(base).map(([k, v]) => [k, structuredClone(tpl.sample[k] ?? v)]))
  // Stand-ins so the gallery section shows; in sample mode it draws ArtTiles, not these.
  content.gallery.photos = ['sample-1', 'sample-2', 'sample-3', 'sample-4', 'sample-5', 'sample-6']
  return { templateId, accent: null, on: {}, content }
}

export default function InviteRenderer({ event, invite, guest = null, mode = 'live', compact = false, slots = {}, only = null, template = null }) {
  const { tpl, palette } = template ? { tpl: template, palette: template.palette } : themeOf(invite)
  const [photo, setPhoto] = useState(null)
  // A studio template's page artwork: a texture over the whole invitation, on its colour.
  const { url: page } = useMediaUrl(tpl.art?.pageBg)
  // Sample previews draw stand-in tiles (numbers) instead of the placeholder references.
  const photos = mode === 'sample' ? [0, 1, 2, 3, 4, 5] : invite.content.gallery?.photos || []
  const all = {
    openPhoto: setPhoto,
    copy: (number) => <CopyButton text={number} />,
    copyText: (text) => <CopyButton text={text} digits={false} />,
    calendar: <AddToCalendar event={event} invite={invite} guest={guest} />,
    ...slots,
  }
  const ctx = { tpl, event, eventName: event?.name || '', guest, mode, compact, slots: all }
  // `only` draws a subset (the gallery card shows just the cover).
  const shown = template ? template.sections.filter((s) => !template.off.includes(s) && hasContent(s, invite.content)) : visibleSections(invite)
  const ids = (only || shown).filter((s) => SECTION_COMPONENTS[s])

  return (
    <div style={{ ...themeVars(invite, template), ...(page ? { background: `url("${page}") center top / 100% auto repeat-y ${palette.bg}` } : {}) }} className="min-h-full">
      {ids.map((id) => {
        const S = SECTION_COMPONENTS[id]
        return <S key={id} c={invite.content} ctx={ctx} />
      })}
      {!only && <footer className="pb-10 pt-4 text-center text-[10px] uppercase tracking-[0.3em] opacity-40">Invitation by Oscenia Events</footer>}
      {photo !== null && photos[photo] !== undefined && (
        <Lightbox photos={photos} index={photo} onIndex={setPhoto} onClose={() => setPhoto(null)} />
      )}
    </div>
  )
}
