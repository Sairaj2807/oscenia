// Language-INDEPENDENT data for the Oscenia Events site.
// All display copy lives in src/i18n/dict.js (en + id). The arrays here
// (routes, client logos, portfolio images) align by index with the dict.

export const CONTACT = {
  phone: '+62 821-3330-2776',
  email: 'osceniaevents@gmail.com',
  whatsapp: 'https://wa.me/6282133302776',
  address:
    'Jl. Jenderal Sudirman No.45 - 46, RT.3/RW.4, Karet Semanggi, Kecamatan Setiabudi, Kota Jakarta Selatan, Daerah Khusus Ibukota Jakarta 12930',
  mapUrl:
    'https://www.google.com/maps/search/?api=1&query=Jl.+Jenderal+Sudirman+No.45-46+Jakarta+Selatan+12930',
  // Embeddable map for the Office section. `output=embed` needs no API key.
  // NOTE: the pin is building-level only — the client hasn't confirmed the floor
  // yet ("aku gatau untuk lantai pastinya"), so the address is still incomplete.
  mapEmbedUrl:
    'https://www.google.com/maps?q=Jl.+Jenderal+Sudirman+No.45-46+Karet+Semanggi+Setiabudi+Jakarta+Selatan+12930&output=embed',
  locations: 'Jakarta · Bali · Singapore',
}

export const SOCIALS = [
  { name: 'Instagram', href: 'https://instagram.com', icon: 'instagram' },
  { name: 'TikTok', href: 'https://tiktok.com', icon: 'tiktok' },
  { name: 'LinkedIn', href: 'https://linkedin.com', icon: 'linkedin' },
  { name: 'WhatsApp', href: 'https://wa.me/6282133302776', icon: 'whatsapp' },
]

// Footer "Follow Along" list (brand names are language-independent)
export const FOLLOW = [
  { href: 'https://instagram.com', label: 'Instagram' },
  { href: 'https://tiktok.com', label: 'Tiktok' },
  { href: 'https://linkedin.com', label: 'LinkedIn' },
]

// Route paths only — labels come from the dictionary (dict[lang].nav)
export const NAV = [
  { to: '/', key: 'home' },
  { to: '/about', key: 'about' },
  { to: '/services', key: 'services' },
  { to: '/contact', key: 'contact' },
]

// Client marks for the paper strip that crosses the hero film — see
// components/LogoMarquee.jsx, which runs the list twice so it can loop.
//
// TODO: CLIENT NAMES PENDING CONFIRMATION.
// Names are intentionally left blank until the client confirms which companies
// may be shown. Once confirmed, add the company name and logo per client with
// the same styling and animation: set `name` (rendered in the brand serif,
// text-xl/sm:text-2xl, tracking-[0.08em], #1a1c20 at 80%) and, when a logo
// file is supplied, drop it in /public and set `logo` (rendered h-8/sm:h-10,
// 80% opacity). The marquee loop, speed and spacing need no changes.
export const CLIENTS = [
  { name: '', logo: '' },
  { name: '', logo: '' },
  { name: '', logo: '' },
  { name: '', logo: '' },
  { name: '', logo: '' },
  { name: '', logo: '' },
  { name: '', logo: '' },
]

// "What we direct" card images. Aligns by index with dict[lang].direct.items —
// Corporate Events / Brand Experiences / Executive Gatherings / Experience
// Systems.
//
// These are frames from the brand's own reel, brand-assets/Photo Assets to
// Use/Aesthetic Assets (for social media)/story 5 - reels 2.mp4, which is the
// footage the reference site cuts these four cards from: the white wall and
// dark hardware, the laid navy table, the martini against the drapes, and the
// arched ceiling. Each is cropped out of the reel's portrait frame to the 3:2
// the cards are drawn at, so nothing is thrown away at render time.
//
// The reel ships as HEVC, which Chrome and Firefox will not decode, which is
// the other reason these are stills rather than four <video> elements.
const FORMAT = (n) => `/formats/${n}.webp`
export const FORMAT_IMAGES = [
  FORMAT('corporate-events'),
  FORMAT('brand-experiences'),
  FORMAT('executive-gatherings'),
  FORMAT('experience-systems'),
]

// Portfolio — the six projects on the Services grid, each opening its own case
// page at /services/:slug.
//
// TODO: CLIENT NAMES AND LOGOS PENDING CONFIRMATION.
// As with CLIENTS above, no real brand is named until the client confirms
// which projects may be shown: every entry is "Brand A"-style placeholder, as
// the reference recording has it. Once confirmed, set per project:
//   - `client`: the brand name (shown on the tile and as the case page title)
//   - `logo`: a file in /public for the gold badge (it shows "Logo" until then)
//   - `img` and `gallery`: real event photography
//   - the matching write-up in dict[lang].services.cases[slug]
// Styling and animation need no changes.
//
// `type` indexes dict[lang].contact.eventTypes, so the event-type line
// translates for free. `img` is the designer's thumbnail for each slot
// (brand-assets/3. Services Page/Photo Assets/Service_thumbnail_1-6.png);
// until each event has its own photographs, every case page's gallery strip
// runs through all six.
const SHOT = (n) => `/services/event-${n}.webp`
// Those photographs come cut with rounded corners (46px on 783x498), so tiles
// take their exact proportions and the same radius rather than cropping them.
export const EVENT_RADIUS = { borderRadius: '5.87% / 9.24%' }
const GALLERY = [1, 2, 3, 4, 5, 6].map(SHOT)
export const PORTFOLIO = [
  { slug: 'brand-a', client: 'Brand A', logo: '', img: SHOT(1), type: 1, gallery: GALLERY },
  { slug: 'brand-b', client: 'Brand B', logo: '', img: SHOT(2), type: 1, gallery: GALLERY },
  { slug: 'brand-c', client: 'Brand C', logo: '', img: SHOT(3), type: 0, gallery: GALLERY },
  { slug: 'brand-d', client: 'Brand D', logo: '', img: SHOT(4), type: 4, gallery: GALLERY },
  { slug: 'brand-e', client: 'Brand E', logo: '', img: SHOT(5), type: 3, gallery: GALLERY },
  { slug: 'brand-f', client: 'Brand F', logo: '', img: SHOT(6), type: 1, gallery: GALLERY },
]
