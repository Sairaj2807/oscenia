// Invitation templates (Invitations v2, D2/D4/D5). A template is a skin over shared sections:
// its colours, fonts, cover layout, ornament and the fixed order of its sections. Content
// lives on the event, keyed by section, so switching template never loses anything.
//
// Plain data, no JSX: scripts/verify-proto.mjs imports it under Node.

/** Every section a template can place. `family` limits where it is offered. */
export const SECTIONS = {
  cover: { label: 'Cover', family: 'both', required: true },
  message: { label: 'Welcome message', family: 'both' },
  couple: { label: 'Couple', family: 'private' },
  hosts: { label: 'Hosts & sponsors', family: 'corporate' },
  countdown: { label: 'Countdown', family: 'both' },
  details: { label: 'Date & venue', family: 'both', required: true },
  agenda: { label: 'Agenda', family: 'corporate' },
  speakers: { label: 'Speakers', family: 'corporate' },
  story: { label: 'Our story', family: 'private' },
  dresscode: { label: 'Dress code', family: 'both' },
  gallery: { label: 'Gallery', family: 'both' },
  video: { label: 'Video', family: 'both' },
  rsvp: { label: 'RSVP & QR access card', family: 'both', required: true },
  wishes: { label: 'Wishes', family: 'both' },
  gift: { label: 'Gifts', family: 'private' },
}

/** Not a page section: a play/pause control over the whole invitation. */
export const MUSIC = 'music'

export const FAMILIES = { corporate: 'Corporate', private: 'Wedding & private' }

/** The Google Fonts index.html loads. A studio template names fonts by these keys. */
export const FONTS = {
  cinzel: "'Cinzel', serif",
  cormorant: "'Cormorant Garamond', serif",
  inter: "'Inter', sans-serif",
  playfair: "'Playfair Display', serif",
  montserrat: "'Montserrat', sans-serif",
  vibes: "'Great Vibes', cursive",
}

const CORPORATE_SAMPLE = {
  cover: { eyebrow: 'You are cordially invited', title: 'Nusantara Leaders Night', subtitle: 'An evening with the people shaping 2027' },
  message: { body: 'Join our board and partners for an evening of dinner, ideas and celebration.' },
  hosts: { names: 'Hosted by Nusantara Group · with Bank Aurora and TechNusa' },
  details: { date: '2026-11-20', time: '18:30', venue: 'The Langham Jakarta, Ballroom', sessions: [] },
  agenda: { rows: [{ time: '18:30', label: 'Arrival & cocktails' }, { time: '19:15', label: 'Opening keynote' }, { time: '20:00', label: 'Dinner & awards' }] },
  speakers: { people: [{ name: 'Ratna Wijaya', role: 'CEO, Nusantara Group' }, { name: 'Dimas Pratama', role: 'Founder, TechNusa' }] },
  dresscode: { text: 'Black tie' },
}

const PRIVATE_SAMPLE = {
  cover: { eyebrow: 'The wedding of', title: 'Rama & Sinta', subtitle: 'Saturday, 12 December 2026' },
  message: { body: 'With joy in our hearts, we invite you to celebrate our marriage with us.' },
  couple: {
    a: { name: 'Rama Pratama', parents: 'Son of Mr. Budi Pratama & Mrs. Sari Lestari', ig: '' },
    b: { name: 'Sinta Halim', parents: 'Daughter of Mr. Joko Halim & Mrs. Dewi Kusuma', ig: '' },
  },
  details: {
    date: '2026-12-12', time: '10:00', venue: 'Gereja Katedral Jakarta',
    sessions: [{ id: 'S-1', name: 'Reception', date: '2026-12-12', time: '18:30', venue: 'Hotel Mulia Senayan, Grand Ballroom', mapUrl: '' }],
  },
  story: { items: [{ date: '2019', title: 'First meeting', text: 'A rainy afternoon at a bookshop in Kemang.' }, { date: '2025', title: 'The proposal', text: 'On the beach in Lombok, at sunrise.' }] },
  gift: { accounts: [{ bank: 'BCA', number: '1234567890', holder: 'Rama Pratama' }], address: '' },
  dresscode: { text: 'Pastel formal' },
}

/**
 * The six templates. `sections` is the fixed order (D4); `off` lists sections that start
 * switched off. `coverBg` is drawn when the client has not uploaded a cover photo.
 */
export const TEMPLATES = [
  {
    id: 'gala', family: 'corporate', name: 'Gala', tagline: 'Midnight and gold, framed like an engraved card.',
    palette: { bg: '#0b1426', surface: '#132038', accent: '#c6a15b', text: '#f5f0e6' },
    fonts: { heading: FONTS.cinzel, body: FONTS.cormorant, script: FONTS.cinzel },
    cover: 'framed', ornament: 'gold-rule',
    coverBg: 'radial-gradient(1200px 600px at 20% 0%, rgba(198,161,91,.35), transparent 60%), radial-gradient(900px 500px at 90% 30%, rgba(79,124,255,.25), transparent 60%), linear-gradient(180deg,#0b1426,#060b16)',
    sections: ['cover', 'message', 'countdown', 'details', 'agenda', 'speakers', 'hosts', 'dresscode', 'gallery', 'video', 'rsvp', 'wishes'],
    off: ['speakers', 'hosts'],
    sample: CORPORATE_SAMPLE,
  },
  {
    id: 'launch', family: 'corporate', name: 'Launch', tagline: 'Bold, modern and video-first, for reveals and product nights.',
    palette: { bg: '#fbf1ef', surface: '#ffffff', accent: '#b76e79', text: '#3a2227' },
    fonts: { heading: FONTS.montserrat, body: FONTS.inter, script: FONTS.playfair },
    cover: 'fullbleed', ornament: 'none',
    coverBg: 'linear-gradient(135deg,#b76e79 0%,#e8b4a0 50%,#fbe3d6 100%)',
    sections: ['cover', 'message', 'video', 'countdown', 'details', 'agenda', 'speakers', 'gallery', 'hosts', 'dresscode', 'rsvp', 'wishes'],
    off: ['speakers', 'hosts'],
    sample: CORPORATE_SAMPLE,
  },
  {
    id: 'summit', family: 'corporate', name: 'Summit', tagline: 'Clean and structured, with room for an agenda and speakers.',
    palette: { bg: '#f4f6fb', surface: '#ffffff', accent: '#2f5bea', text: '#13203d' },
    fonts: { heading: FONTS.montserrat, body: FONTS.inter, script: FONTS.montserrat },
    cover: 'split', ornament: 'grid',
    coverBg: 'linear-gradient(160deg,#13203d 0%,#2f5bea 100%)',
    sections: ['cover', 'message', 'details', 'countdown', 'agenda', 'speakers', 'hosts', 'gallery', 'video', 'dresscode', 'rsvp', 'wishes'],
    off: [],
    sample: CORPORATE_SAMPLE,
  },
  {
    id: 'royal', family: 'private', name: 'Royal', tagline: 'Ornamental florals and script names, for a grand celebration.',
    palette: { bg: '#fbf7ef', surface: '#ffffff', accent: '#a8823c', text: '#3b2f1e' },
    fonts: { heading: FONTS.cormorant, body: FONTS.cormorant, script: FONTS.vibes },
    cover: 'centered', ornament: 'floral',
    coverBg: 'radial-gradient(800px 500px at 50% 0%, #f3e3c3, transparent 70%), linear-gradient(180deg,#fbf7ef,#f1e6d0)',
    sections: ['cover', 'message', 'couple', 'countdown', 'details', 'story', 'gallery', 'video', 'dresscode', 'rsvp', 'wishes', 'gift'],
    off: ['dresscode'],
    sample: PRIVATE_SAMPLE,
  },
  {
    id: 'minimal', family: 'private', name: 'Minimal', tagline: 'Quiet white space and a fine serif. Lets the photos speak.',
    palette: { bg: '#ffffff', surface: '#f6f6f4', accent: '#1f1f1f', text: '#1f1f1f' },
    fonts: { heading: FONTS.playfair, body: FONTS.inter, script: FONTS.playfair },
    cover: 'split', ornament: 'none',
    coverBg: 'linear-gradient(180deg,#e9e7e2,#cfcac0)',
    sections: ['cover', 'couple', 'message', 'details', 'countdown', 'gallery', 'story', 'video', 'dresscode', 'rsvp', 'gift', 'wishes'],
    off: ['dresscode'],
    sample: PRIVATE_SAMPLE,
  },
  {
    id: 'garden', family: 'private', name: 'Garden', tagline: 'Soft pastels and leaf sprigs, for garden and daytime events.',
    palette: { bg: '#f3f6ef', surface: '#ffffff', accent: '#6f8f5b', text: '#2c3a26' },
    fonts: { heading: FONTS.cormorant, body: FONTS.inter, script: FONTS.vibes },
    cover: 'centered', ornament: 'leaf',
    coverBg: 'radial-gradient(700px 400px at 15% 10%, #dfe9d3, transparent 70%), radial-gradient(700px 400px at 85% 90%, #f4dfe2, transparent 70%), #f3f6ef',
    sections: ['cover', 'message', 'couple', 'details', 'countdown', 'story', 'gallery', 'video', 'dresscode', 'rsvp', 'wishes', 'gift'],
    off: ['dresscode'],
    sample: PRIVATE_SAMPLE,
  },
]

// Samples are shared between templates of a family: frozen so a preview can never edit one.
const deepFreeze = (o) => { Object.values(o).forEach((v) => v && typeof v === 'object' && deepFreeze(v)); return Object.freeze(o) }
TEMPLATES.forEach((t) => deepFreeze(t))

// --- the design team's templates (client round 3, Template Studio) ----------------------
// Oscenia's designers build their own skins over the same sections: colours, fonts, one of
// the four cover layouts, an ornament, the section order — plus artwork files (art.*). They
// live in the prototype store (useProto `customTemplates`), which hands them here through
// registerTemplates on every change, so every reader below finds them by id like a built-in.
// New layouts or new sections still need a developer.

export const COVERS = ['centered', 'split', 'framed', 'fullbleed']
export const ORNAMENTS = ['gold-rule', 'floral', 'leaf', 'grid', 'none']
/** Artwork a studio template may carry: media references (lib/mediaStore.js), each optional. */
export const ART_SLOTS = ['coverBg', 'pageBg', 'frame', 'ornament']
export const TEMPLATE_STATUSES = ['draft', 'published', 'archived']

const SAMPLES = { corporate: CORPORATE_SAMPLE, private: PRIVATE_SAMPLE }
const HEX = /^#[0-9a-f]{6}$/i
const isRef = (v) => Boolean(v && typeof v === 'object' && typeof v.key === 'string')

/** null when a studio template (as stored) is usable; otherwise what is wrong with it. */
export function validateTemplate(t) {
  if (!t || typeof t !== 'object') return 'Not a template.'
  if (typeof t.id !== 'string' || !t.id || TEMPLATES.some((b) => b.id === t.id)) return 'The template needs its own id.'
  if (typeof t.name !== 'string' || !t.name.trim()) return 'Give the template a name.'
  if (typeof (t.tagline ?? '') !== 'string') return 'The tagline must be text.'
  if (t.name.length > 40 || (t.tagline || '').length > 120) return 'The name or tagline is too long.'
  if (!FAMILIES[t.family]) return 'Choose a family.'
  if (!t.palette || !['bg', 'surface', 'accent', 'text'].every((k) => HEX.test(t.palette[k] || ''))) return 'Every colour must be a hex colour like #c6a15b.'
  if (!t.fonts || !['heading', 'body', 'script'].every((k) => Object.hasOwn(FONTS, t.fonts[k]))) return 'Choose fonts from the list.'
  if (!COVERS.includes(t.cover)) return 'Choose a cover layout.'
  if (!ORNAMENTS.includes(t.ornament)) return 'Choose an ornament.'
  const s = t.sections
  if (!Array.isArray(s) || s[0] !== 'cover' || new Set(s).size !== s.length) return 'The cover comes first, and no section twice.'
  if (!s.every((id) => SECTIONS[id] && (SECTIONS[id].family === 'both' || SECTIONS[id].family === t.family))) return 'A section does not suit this family.'
  if (!Object.keys(SECTIONS).filter((id) => SECTIONS[id].required).every((id) => s.includes(id))) return 'Cover, date & venue and RSVP are required.'
  if (!Array.isArray(t.off) || !t.off.every((id) => s.includes(id) && !SECTIONS[id].required)) return 'Only optional sections can start switched off.'
  if (!t.art || typeof t.art !== 'object' || !Object.entries(t.art).every(([k, v]) => ART_SLOTS.includes(k) && (v === null || isRef(v)))) return 'Artwork must be uploaded files.'
  if (!TEMPLATE_STATUSES.includes(t.status)) return 'Unknown template status.'
  return null
}

// A gradient in the template's own colours, behind the cover until art or a photo is set.
const coverGradient = (p) =>
  `radial-gradient(900px 500px at 20% 0%, color-mix(in srgb, ${p.accent} 35%, transparent), transparent 60%), linear-gradient(180deg, ${p.surface}, ${p.bg})`

// Stored → the shape readers expect (font stacks, a cover gradient, the family's sample).
// Cached per stored object, so an unchanged template keeps its identity across registrations.
const compiled = new WeakMap()
function compile(raw) {
  if (!compiled.has(raw)) {
    const fonts = Object.fromEntries(Object.entries(raw.fonts).map(([k, v]) => [k, FONTS[v]]))
    compiled.set(raw, Object.freeze({ ...raw, custom: true, fonts, fontKeys: raw.fonts, coverBg: coverGradient(raw.palette), sample: SAMPLES[raw.family] }))
  }
  return compiled.get(raw)
}

/** A design still being edited, in the shape the renderer reads (the studio's live preview). */
export const previewTemplate = (raw) => compile(raw)

let custom = []
let customById = new Map()
let everything = TEMPLATES

/** Hands over the design team's templates. Anything that does not validate is left out. */
export function registerTemplates(list) {
  custom = (Array.isArray(list) ? list : []).filter((t) => !validateTemplate(t)).map(compile)
  customById = new Map(custom.map((t) => [t.id, t]))
  everything = [...TEMPLATES, ...custom]
}

/** The six built-ins, then the design team's (every status: filter for the gallery). */
export const allTemplates = () => everything

export const templateById = (id) => TEMPLATES.find((t) => t.id === id) || customById.get(id) || null

/** May this template be picked for an invitation now? Built-ins always; studio ones once in the gallery. */
export const inGallery = (tpl) => Boolean(tpl) && (!tpl.custom || tpl.status === 'published')

// An id this browser does not know (a studio template made in another browser) draws as the
// first built-in rather than as an empty page. No id at all is a draft with no template yet.
const resolve = (id) => templateById(id) || (id ? TEMPLATES[0] : null)

/** The invitation's template, or null when none has been chosen yet. */
export const templateOf = (invite) => resolve(invite?.templateId)

/** The font key behind a built-in's font stack, for duplicating it in the studio. */
export const fontKey = (stack) => Object.keys(FONTS).find((k) => FONTS[k] === stack) || 'inter'

/**
 * A new studio template, as stored: a copy of `from` (built-in or studio), or a blank in the
 * family's first built-in's section order.
 */
export function newTemplate({ id, from = null, family = 'private' }) {
  if (from) {
    return {
      id, family: from.family, name: `${from.name} copy`.slice(0, 40), tagline: from.tagline || '',
      palette: { ...from.palette },
      fonts: from.fontKeys ? { ...from.fontKeys } : { heading: fontKey(from.fonts.heading), body: fontKey(from.fonts.body), script: fontKey(from.fonts.script) },
      cover: from.cover, ornament: from.ornament,
      sections: [...from.sections], off: [...from.off],
      art: { coverBg: null, pageBg: null, frame: null, ornament: null, ...(from.art ? structuredClone(from.art) : {}) },
      status: 'draft',
    }
  }
  const first = TEMPLATES.find((t) => t.family === family) || TEMPLATES[0]
  return {
    id, family: first.family, name: 'Untitled design', tagline: '',
    palette: { bg: '#ffffff', surface: '#f6f4ef', accent: '#8a6d3b', text: '#2a2520' },
    fonts: first.family === 'private' ? { heading: 'playfair', body: 'inter', script: 'vibes' } : { heading: 'montserrat', body: 'inter', script: 'montserrat' },
    cover: first.family === 'private' ? 'centered' : 'split', ornament: 'none',
    sections: [...first.sections], off: [...first.off],
    art: { coverBg: null, pageBg: null, frame: null, ornament: null },
    status: 'draft',
  }
}

/** The look of an invitation: its template, with the client's accent colour if they set one. */
export function themeOf(invite) {
  const tpl = resolve(invite?.templateId) || TEMPLATES[0]
  const palette = invite?.accent ? { ...tpl.palette, accent: invite.accent } : tpl.palette
  return { tpl, palette, fonts: tpl.fonts }
}

/** Is this section switched on? Toggles the user never touched follow the template's default. */
export function sectionOn(invite, sectionId) {
  const tpl = resolve(invite?.templateId)
  if (!tpl || !tpl.sections.includes(sectionId)) return false
  if (SECTIONS[sectionId]?.required) return true
  const set = invite.on?.[sectionId]
  return set === undefined ? !tpl.off.includes(sectionId) : Boolean(set)
}

export const musicOn = (invite) => Boolean(invite?.on?.[MUSIC])
