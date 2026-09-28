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
// Brand names stay as-is in both languages and stand in until logo files exist:
// drop a file in /public and set `logo` to swap a name for a mark. No logo
// files were supplied with the brand pack, so every entry is currently a name
// set in the brand serif.
export const CLIENTS = [
  { name: 'Bentley', logo: '' },
  { name: 'Ferrari', logo: '' },
  { name: 'Emporio Armani', logo: '' },
  { name: 'Chanel', logo: '' },
  { name: 'Mercedes-Benz', logo: '' },
  { name: 'Louis Vuitton', logo: '' },
  { name: 'Rolex', logo: '' },
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

// Portfolio tiles — titles come from the dictionary, aligned by index with
// dict[lang].services.portfolio.
//
// `type` indexes dict[lang].contact.eventTypes, so the event-type badge the
// client asked for ("so clients can use it as reference") translates for free.
// `gallery` holds the six in-event images shown when a tile is opened; drop
// files in /public and list their paths here.
//
// `logo` is the client's mark, shown bottom-right on the tile. Until logo files
// are supplied the tile falls back to setting `client` as a small type mark, so
// every card is still identifiable.
// PLACEHOLDERS, not real work. `img` points at crops of the stock event photo
// from the logo-screen storyboard, purely so the greyscale-to-colour hover can
// be demonstrated before real photography exists. `logo` is Oscenia's own mark
// standing in for each client's — swap both per project when assets arrive.
const G = () => ['', '', '', '', '', '']
const MARK = '/brand/monogram-light.svg'
const SHOT = (n) => `/portfolio/placeholder-${n}.jpg`
export const PORTFOLIO = [
  { client: 'Lamborghini', logo: MARK, img: SHOT(1), featured: true, type: 1, gallery: G() },
  { client: 'Oscenia', logo: MARK, img: SHOT(2), type: 0, gallery: G() },
  { client: 'Coca-Cola', logo: MARK, img: SHOT(3), type: 1, gallery: G() },
  { client: 'Meta', logo: MARK, img: SHOT(4), type: 1, gallery: G() },
  { client: 'Netflix', logo: MARK, img: SHOT(5), type: 1, gallery: G() },
  { client: 'Unilever', logo: MARK, img: SHOT(6), type: 4, gallery: G() },
  { client: 'TikTok', logo: MARK, img: SHOT(7), type: 1, gallery: G() },
  { client: 'Google', logo: MARK, img: SHOT(8), type: 4, gallery: G() },
  { client: 'H&M', logo: MARK, img: SHOT(9), type: 1, gallery: G() },
]

// "Explore More" was linking to Contact Us, which the client flagged as wrong.
// It now only renders once there are genuinely more projects than the grid
// shows AND there is somewhere for it to go — set EXPLORE_MORE_TO to that
// destination when a full portfolio page exists.
export const EXPLORE_MORE_TO = ''
export const EXPLORE_MORE_MIN_PROJECTS = 12

// Featured case-study gallery images (swap for real photos)
export const FEATURED_GALLERY = ['', '', '', '', '', '']
