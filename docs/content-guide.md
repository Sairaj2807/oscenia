# Content Guide

How to change what the site says and shows: copy in both languages, contact details, images and films. Then the list of placeholders that still need real content before launch.

Content lives in exactly two files:

| File | Holds | Language-dependent? |
|---|---|---|
| [`src/i18n/dict.js`](../src/i18n/dict.js) | **All visible text**: headings, paragraphs, button labels, form labels, testimonials, project titles | Yes: an `en` block and an `id` block |
| [`src/data/site.js`](../src/data/site.js) | Contact details, social links, client names/logos, image paths, portfolio data | No: the same in every language |

Almost every content change is an edit to one of these two files. You rarely need to touch a component.

---

## 1. Changing text

### 1.1 Where each page's copy lives

`dict.en` and `dict.id` have **the same shape**. Every key in one must exist in the other.

| Key | Page / area |
|---|---|
| `nav` | Header and footer link labels (`service` is the header's "Service", `services` the footer's "Services") |
| `common` | Shared button labels: "Start your event", "Send Inquiry", "Close", "Chat with us", "Let's Talk Further" |
| `intro` | Intro overlay: "click logo to start", "Skip" |
| `hero` | Home hero: `headline` (the sentence as fragments), `tagline` (the same sentence as plain text), `subline` |
| `direct` | Home "What we direct": eyebrow, heading, the four format `items` (title + hover description) |
| `testimonials` | Home carousel: heading and `items` (quote + author) |
| `about` | Everything on About |
| `services` | Services header, the nine `portfolio` titles, `featured`, `caseStudy` labels |
| `contact` | Contact page, form labels, `eventTypes`, the email template (`mailSubject`, `mailFields`), `office` |
| `footer` | Footer column titles, "Whatsapp"/"Email" prefixes, copyright |
| `notFound` | 404 page |

### 1.2 Editing a string

Change the value in **both** `en` and `id`:

```js
// dict.js, en block
common: { startEvent: 'Start your event', … }
// dict.js, id block
common: { startEvent: 'Mulai Acara Anda', … }
```

Use typographic punctuation: `’` rather than `'` inside words, `—` for dashes, `…` for ellipses.

### 1.3 Lists that line up by position

Some lists in `dict.js` pair **by index** with data in `site.js`. Keep them the same length and order:

| `dict.js` | pairs with `site.js` | Rule |
|---|---|---|
| `services.portfolio[i]` (titles) | `PORTFOLIO[i]` | Title *i* belongs to project *i* |
| `direct.items[i]` | `FORMAT_IMAGES[i]` | Card *i* uses image *i* |
| `contact.eventTypes[n]` | `PORTFOLIO[i].type` | `type: 1` means `eventTypes[1]` ("Brand Experience / Product Launch") |

`eventTypes` is also the Contact form's dropdown, so reordering it changes both the form and every portfolio badge. **Add new types at the end.**

### 1.4 The hero sentence

`hero.headline` is an array of lines, each an array of fragments:

```js
headline: [
  ['Strategic events', '&', 'immersive'],
  ['experiences that', 'transform', 'business'],
  ['objectives', 'into', 'memorable human', 'moments.'],
],
tagline: 'Strategic events and immersive experiences that transform business objectives into memorable human moments.',
```

- Each fragment gets its own size and style **by position**, from `data/headline.js`. Changing a word keeps the styling of its slot. Adding fragments is safe: extra ones use a fallback size.
- Keep `tagline` in sync. It's what screen readers read.

### 1.5 Testimonials

`testimonials.items` is a list of `{ quote, author }`. Any number works. The carousel rotates through all of them every 4 seconds; with only one, it stays still.

### 1.6 Adding a language

1. Copy the whole `en` block in `dict.js` to a new key (for example `zh`) and translate every value, keeping the shape.
2. Add it to `LANGS` at the bottom of `dict.js`: `{ code: 'zh', short: 'ZH' }`.
3. The header toggle shows it automatically. The site remembers the visitor's choice. Only `id` is auto-detected from the browser, in `LanguageContext.jsx`.

---

## 2. Contact details and links

All in `CONTACT`, `SOCIALS` and `FOLLOW` in `site.js`.

| Field | Current value | Shown in |
|---|---|---|
| `CONTACT.phone` | `+62 821-3330-2776` | Footer, Contact page |
| `CONTACT.whatsapp` | `https://wa.me/6282133302776` | Header drawer, floating bead |
| `CONTACT.email` | `osceniaevents@gmail.com` | Footer, Contact page, form destination |
| `CONTACT.address` / `mapUrl` / `mapEmbedUrl` | Jl. Jenderal Sudirman No.45–46, Jakarta Selatan | Contact "Our Office" |
| `CONTACT.locations` | `Jakarta · Bali · Singapore` | Footer legal line |
| `SOCIALS` | Instagram, TikTok, LinkedIn, WhatsApp | Contact page circles |
| `FOLLOW` | Instagram, Tiktok, LinkedIn | Footer "Follow Along" |

**Changing the WhatsApp number:** update `phone` (the display format) **and** every `wa.me` link. A `wa.me` link takes the country code and number as digits only: `+62 821-3330-2776` → `https://wa.me/6282133302776`. It appears in `CONTACT.whatsapp` and in the WhatsApp entry of `SOCIALS`.

**Changing the map:** update `address`, `mapUrl` (opened by the "Location" button) and `mapEmbedUrl` (the embedded map, which must end in `output=embed`; no API key needed).

---

## 3. Images and films

### 3.1 Where files go

Everything the site serves lives in **`public/`** and is referenced by a path starting with `/`: `public/formats/corporate-events.webp` is used as `/formats/corporate-events.webp`.

| Folder | Contains |
|---|---|
| `public/brand/` | Logo SVGs |
| `public/media/` | Films (`.mp4`), their posters (`.jpg`), the hero still |
| `public/formats/` | The four "What we direct" card photos |
| `public/portfolio/` | Portfolio tile photos (currently placeholders) |

`brand-assets/` (next to `public/`) is the **original brand pack**: source files, fonts and raw footage. It's *not* served. Nothing there reaches the website unless you export it into `public/`. Its own README maps each served file back to its source.

### 3.2 What each slot expects

| Slot | Set in | Format | Aspect / size |
|---|---|---|---|
| Client logos (hero strip) | `CLIENTS[i].logo` | SVG, or PNG with transparency; **dark** artwork (it sits on paper) | Any width; rendered 32–40px tall |
| Format cards | `FORMAT_IMAGES` | WebP | **3:2**, ~1600px wide |
| Portfolio tile | `PORTFOLIO[i].img` | JPG / WebP | **4:3** |
| Portfolio client mark | `PORTFOLIO[i].logo` | SVG, **light/white** artwork (it sits on the photo) | Rendered 24–28px tall |
| Case-study gallery | `PORTFOLIO[i].gallery` (six paths) | JPG / WebP | 4:3 |
| Featured project gallery | `FEATURED_GALLERY` (six paths) | JPG / WebP | 4:3 |
| Hero still | `Home.jsx` → `/media/hero-table.webp` | WebP | 16:9, ≥ 1920px wide |
| About Vision / Services Featured backgrounds | `<Media src="">` in `About.jsx` / `Services.jsx` | JPG / WebP | Wide, landscape |

**Empty slots are safe.** Anything rendered through `Media` with an empty `src` shows the navy placeholder with its label, and any client without a `logo` shows its name.

**Adding a portfolio project:** append to `PORTFOLIO` in `site.js` *and* append its title to `services.portfolio` in both languages in `dict.js`.

```js
{ client: 'Lamborghini', logo: '/portfolio/logos/lamborghini.svg', img: '/portfolio/lamborghini.jpg',
  featured: true, type: 1, gallery: ['/portfolio/lambo-1.jpg', /* …six in total */] },
```

### 3.3 Films

| Rule | Why |
|---|---|
| **H.264 MP4 with "faststart"** (`ffmpeg … -c:v libx264 -movflags +faststart`) | HEVC/H.265 doesn't play in Chrome or Firefox; faststart lets playback begin before the whole file downloads |
| Include a **poster JPEG** of the first frame, same name | Shown until the film loads, and permanently for reduced-motion visitors |
| Keep background loops short and small (~1 MB or less) | They're muted, looped atmosphere |
| Background films must be **silent-safe** | They're always muted |

- **The showreel** (`/media/showreel.mp4`) plays **with sound**, once, in the intro. It's landscape; on portrait phones it's letterboxed automatically, with bars matched to its own edge colours. A 9:16 vertical cut would read better on phones: if one is supplied, it can be served to portrait screens.
- To swap a background film, replace the file (keeping the name) or change the `src`/`poster` pair in the page. The films are `velvet` (intro splash), `champagne` (What we direct), `celebration` (closing) and `showreel` (intro).

---

## 4. The contact form

The form has no backend. Submitting opens the visitor's own mail app with a pre-filled message to `CONTACT.email`: subject `contact.mailSubject`, one line per field, labels from `contact.mailFields`, all in the current language.

**Before launch** this should post to a real endpoint (a form service such as Formspree or Resend, or an API), so enquiries don't depend on the visitor having a mail app configured. The change is limited to `handleSubmit` in `pages/Contact.jsx`.

---

## Launch checklist

Content that is still placeholder or unconfirmed:

| # | Item | Where | Status |
|---|---|---|---|
| 1 | Testimonial authors all read "Company Name" ("Nama Perusahaan"); two of three quotes are the same | `dict.js` → `testimonials` | Placeholder |
| 2 | Portfolio photos are stock crops; client marks are Oscenia's monogram | `site.js` → `PORTFOLIO` | Placeholder |
| 3 | Case-study galleries and the featured gallery are empty | `PORTFOLIO[i].gallery`, `FEATURED_GALLERY` | Empty |
| 4 | Case-study and featured descriptions are placeholder text | `dict.js` → `services.caseStudy.desc`, `services.featured.desc` | Placeholder |
| 5 | About "Vision" and Services "Featured" background images are empty | `About.jsx`, `Services.jsx` | Empty |
| 6 | Client strip shows names, not logos | `site.js` → `CLIENTS[i].logo` | Awaiting logo files |
| 7 | Social links point at the platforms' home pages, not Oscenia's profiles | `SOCIALS`, `FOLLOW` | Placeholder |
| 8 | Office floor not confirmed; the map pin is building-level | `CONTACT.address` | Awaiting client |
| 9 | Contact form uses `mailto:` | `pages/Contact.jsx` | Needs a backend |
| 10 | Intro plays on every page load, with no "seen it" memory | `components/Intro.jsx` | Decide: every visit or once per session |
| 11 | "Explore More" is hidden until there are 12+ projects and a destination | `EXPLORE_MORE_TO`, `EXPLORE_MORE_MIN_PROJECTS` | By design |
| 12 | Indonesian copy should be proofread by a native speaker | `dict.js` → `id` | Review |
| 13 | Copyright year is fixed text | `footer.copyright` | Update yearly, or compute |
