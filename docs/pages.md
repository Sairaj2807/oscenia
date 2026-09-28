# Pages

Every route on the site, section by section: what it shows, where its content comes from, how it's laid out and how it behaves. Styling tokens are in [design-system.md](design-system.md), animation detail in [animation.md](../animation.md), and the components named here in [components.md](components.md).

| Route | File | Sections |
|---|---|---|
| (every route, first load) | `components/Intro.jsx` | Intro overlay: splash → logo zoom → showreel |
| `/` | `src/pages/Home.jsx` | Hero film + client strip · What we direct · Testimonials · Closing film + footer |
| `/about` | `src/pages/About.jsx` | About intro · Name meaning · What Oscenia stands for · Vision · Why Oscenia · Our Value |
| `/services` | `src/pages/Services.jsx` | Header · Portfolio grid (+ case-study dialog) · Featured project |
| `/contact` | `src/pages/Contact.jsx` | Inquiry form · Our Office (map) |
| any other path | `src/pages/NotFound.jsx` | 404 |

Every route shares the shell from `Layout.jsx`: the navy background, the cursor ripple, the fixed header, the floating WhatsApp bead and the footer. Home places its footer itself, on top of the closing film.

---

## Intro overlay (first load, any route)

**File:** `components/Intro.jsx` · **Full sequence and timings:** [animation.md §2](../animation.md)

A full-screen overlay (`z-[100]`) shown on every fresh page load, over whichever route was opened. The page underneath mounts and loads behind it.

1. **Splash.** The gold stacked logo, centred on a looping navy-velvet film with a 45% navy scrim. Under it, "click logo to start" pulses gently. The logo is the only control and receives keyboard focus.
2. **Logo zoom (1.45s).** On click, the logo brightens from gold to white, holds still for a moment, then zooms toward the viewer until one of its strokes fills the screen with the showreel's opening cream.
3. **Showreel.** `showreel.mp4` plays **with sound** (about 59s). A **Skip** button (bottom-right, focused) and a thin gold progress line along the bottom edge ride on top.
   - **Portrait phones:** the film is letterboxed so no sentence is cut off. The bars above and below are painted live in the colours of the film's own top and bottom edges, and the film's edges fade into them.
4. **Done.** When the film ends, or on Skip or Escape, the overlay unmounts and announces `oscenia:intro-done`. Home's headline and CTA wait for this before they animate.

**Reduced motion:** clicking the logo skips the zoom and the film and goes straight to the site.

> The intro plays on every page load. There is no "seen it already" memory yet. See [content-guide.md](content-guide.md#launch-checklist).

---

## Home (`/`)

The home page is a sequence of full-screen scenes rather than a document: film, black, film.

### 1. Hero film and client strip (`HeroFilm`)

**Content:** `t.hero` (dictionary) · `CLIENTS` (site data) · **Image:** `media/hero-table.webp`

- **Backdrop:** a photograph of a laid table, sticky to the viewport for the whole section and slowly zooming (Ken Burns, 26s, alternating). It's lifted to 1.18× brightness and 1.08× saturation, with a 22% navy veil and a 30vh gradient foot into navy.
- **Headline:** the brand sentence *"Strategic events & immersive experiences that transform business objectives into memorable human moments."* is set as ten differently sized fragments across three lines (`KineticHeadline`). Fragments land one at a time, 380ms apart, **starting only when the intro has finished**. Screen readers get the sentence once, as plain text.
- **Call to action:** "Start your event" in liquid glass (`GlassCTA` → `/contact`), fading in 500ms before the last headline word lands.
- **Subline:** *"The Company Behind Our Success"*, italic serif, `white/80`.
- **Client strip:** a band of warm paper crossing the film, with client names (Bentley, Ferrari, Emporio Armani, Chanel, Mercedes-Benz, Louis Vuitton, Rolex) scrolling continuously every 38s. Names render in the brand serif until logo files are supplied.
- A 45vh spacer after the strip gives the film a long fade before the page turns black.

### 2. What we direct (`Formats`)

**Content:** `t.direct` · **Images:** `FORMAT_IMAGES` (`public/formats/*.webp`) · **Film:** `champagne.mp4`

- **Film band:** 62svh tall on phones, 78svh from 640px, with the champagne film (lazy-loaded) under a 25% black veil. The eyebrow *"What we direct"* and heading *"Formats we shape, end to end."* sit bottom-left and slide up.
- **Four format cards** in a 2×2 grid (max 1312px, 48px gutter), with the right column 28px lower:
  1. Corporate Events · 2. Brand Experiences · 3. Executive Gatherings · 4. Experience Systems

  Each is a 3:2 photo with a large serif caption beneath. The left cards title from the left; the right cards title from the right.
  - **Entrance, the "toss":** each photo is thrown onto the table from just off its own side of the screen, tilted, and lands flat after 2.27s. The caption slides in separately and rises into place. On phones it's a shorter, gentler toss.
  - **Scrolling back up** plays the toss in reverse: once a card's top drops below 60% of the screen, the photo lifts off and flies back up and out to its own side, tilting, as the caption drops away. Scrolling down again throws it back in.
  - **Hover (mouse/trackpad only):** the card swells to 1.08× from its foot, then floats ±5px about once a second. A gold halo blooms behind it, the photo zooms 1.05×, and a one-line description fades in under the title.
- **The golden thread:** one hairline of pale champagne drawn by scrolling. It writes itself as you scroll down and un-writes if you scroll back. Its path, all tangent-continuous:
  1. out of the film's left edge, diagonally through the heading;
  2. a wide shallow U, up the right side and a loop over the top;
  3. down through "end." and across the gutter, in under the **Brand Experiences** photo;
  4. out below its caption at 45°, across the gap between rows, in under the **Experience Systems** photo;
  5. out below "Experience Systems", round a teardrop loop, and off the right edge above the testimonials.

  It's hidden below 640px. Geometry and timing are in `data/formatsMotion.js`; the full description is in [animation.md §5](../animation.md).

### 3. Client Testimonials (`Testimonials`)

**Content:** `t.testimonials` · **Background:** `.bg-abyss`

- **Layout:** centred heading, then a near-black lozenge card (max 656px) between two small white dots, which are the previous and next controls (44px hit areas).
- **Card:** the quote in sans, `white/95`, then *— Company Name* in spaced uppercase. A blurred band of gold light drifts slowly back and forth across it (9s each way).
- **Carousel:** advances **every 4 seconds**. The new quote fades in over 1.2s. It pauses while the pointer is over it or a control has focus, and doesn't auto-advance under reduced motion.
- The thread's tail crosses the top-right of this section.

### 4. Closing film and footer (`Closing`)

**Film:** `celebration.mp4` (sticky, lazy) under a 25% black veil and a two-thirds-height gradient to black.

- "Start your event" again in liquid glass, centred, scaling in.
- The **footer is laid over the film** (`<Footer overlay />`): no panel of its own, just a hairline above the legal line.

---

## About (`/about`)

**Content:** `t.about`. Directions and timings mirror the PowerPoint deck "HOME - ABOUT US.pptx" via `data/deckMotion.js` (see `docs/Deck-Transitions-Reference.md` in the repository root).

| # | Section | What it shows | Behaviour |
|---|---|---|---|
| 1 | **Intro** | Eyebrow, `gold-light` title "About Us", serif intro paragraph | Title slides in from the left; the paragraph rises 320ms later |
| 2 | **Name meaning** | Hairline + italic "OS · CEN · IA" (left); two paragraphs on the ocean and the name (right, with a gold rule) | Heading from the left; paragraphs drop in from above, 180ms apart |
| 3 | **What Oscenia stands for** | Heading with an italic "Oscenia", intro line, **three glowing circles**: Scale · Flow · Memory | Circles open themselves in turn (900ms, then 650ms apart) once 35% of the section is visible, and reset when it leaves. An open circle shows its description *inside* the circle, rising into place. Any circle can be clicked to toggle, after which auto-opening stops. Under reduced motion all three start open |
| 4 | **Vision** | A 70vh band (a placeholder image under a 75% navy veil) with *"Our Vision"*, a hairline, the italic `gold-light` vision statement and a second hairline, all centred | Pieces arrive in sequence: label, rule, statement, rule |
| 5 | **Why Oscenia** | Large "*Why* Oscenia" (italic `white/60` + `gold-light`) beside two paragraphs | Heading scales in over 1.6s; paragraphs follow 220ms apart |
| 6 | **Our Value** | Italic heading, then three rows split by rules: *Strategic Experience Design* (two "Instead of / We start with" statements), *Integrated Event Management* (six-item gold-bullet list), *Narrative-Driven Approach* (the formula "Purpose → Experience → Emotion → Memory" plus a note) | Each row is a `Disclosure` that opens itself 650ms after the one above; the `+` rotates to × when open. Ends with a "Start your event" pill |

---

## Services (`/services`)

**Content:** `t.services` · **Data:** `PORTFOLIO`, `FEATURED_GALLERY`, `EXPLORE_MORE_*`

### 1. Header
Eyebrow *"Portfolio & Clients"* and the heading *"Corporate events and product launches we've directed."* in `gold-light`.

### 2. Portfolio grid
Nine project tiles, two columns on phones and three from 768px:

- **Tile:** a 4:3 photo, **greyscale under a 45% navy veil at rest**, with the client mark bottom-right. Below it, reserved space holds the project title and an event-type tag in `gold-light` uppercase.
- **Hover or focus:** colour returns, the veil lifts, the photo zooms 1.04×, the border warms to gold and the title and tag rise in.
- **Touch devices** (no hover): tiles are always in colour with titles shown.
- **Click:** opens the **case-study dialog** (`CaseStudy`). It's a full-screen navy overlay with the project's hero image and title, its event type as a gold pill, a description, a six-image "From the event" gallery and a "Start your event" pill. It closes on "Close", a click on the backdrop, or Escape, and locks page scrolling while open.
- **"Explore More"** only appears once `PORTFOLIO` holds at least 12 projects **and** `EXPLORE_MORE_TO` names a destination. Both are unset today, so it's hidden.

> The nine projects (Lamborghini, Coca-Cola, Meta, Netflix, Unilever, TikTok, Google, H&M and one Oscenia team shoot) are **placeholders**: stock crops and Oscenia's own monogram standing in for client logos.

### 3. Featured project
A 60vh image with its title bottom-left (*Lamborghini Car Launch*), an italic centred description, a six-image gallery and a "Start your event" pill. Images are placeholders until `FEATURED_GALLERY` is filled.

---

## Contact (`/contact`)

**Content:** `t.contact` · **Data:** `CONTACT`, `SOCIALS`

The floating WhatsApp bead is hidden on this page, since the page already is the way to get in touch.

### 1. Inquiry
- **Heading:** *"Tell us what you're building."* (`gold-light`, up to `text-7xl`).
- **Left column:** intro paragraph, four social circles (Instagram, TikTok, LinkedIn, WhatsApp; gold on hover), the WhatsApp number and a mailto link.
- **Right column: the form.**

  | Field | Name | Type |
  |---|---|---|
  | Your Name | `name` | text |
  | Company | `company` | text |
  | Phone Number | `phone` | tel |
  | Event Type | `eventType` | select: Corporate Event · Brand Experience / Product Launch · Executive Gathering · Gala / Award Night · Conference / Summit · Other |
  | Estimated Guests | `guests` | number |
  | Estimated Date | `date` | date |
  | Tell Us More | `details` | textarea |

- **Submit ("Send Inquiry"):** there's no backend yet. It builds a plain-text email of all the fields, in the current language, and opens the visitor's mail app addressed to `CONTACT.email`. The button then reads "Opening your email…".

### 2. Our Office
A 380px Google Maps embed, recoloured dark to match the site, then the full address and a "Location" button that opens Google Maps in a new tab.

> The map pin is building-level only; the client hasn't confirmed the floor yet.

---

## 404 (any unknown path)

Centred in a 70vh block: an eyebrow "404", *"Page not found"* in `gold-light`, one line of explanation, and a "Back Home" pill.

---

## Present on every page

| Element | Component | Behaviour |
|---|---|---|
| Header | `Nav` | Transparent at all times (no bar appears on scroll). Logo left; Home / About Us / Service centred on the viewport from 1024px; "Let's Talk Further" from 768px; EN/ID toggle always. Below 1024px a hamburger opens an opaque full-height drawer with the links, a gold "Contact Us" and "Chat with us" (WhatsApp); it closes on navigation and locks page scroll while open |
| Cursor ripple | `Ripple` | A water-like wake follows the mouse in gold and navy behind all content. Mouse and pen only; off under reduced motion |
| WhatsApp bead | `QuickContact` | A round liquid-glass button with a gold WhatsApp glyph. It appears after scrolling 45% of a screen, hides within 420px of the page end and never shows on Contact. Mid-right on desktop, bottom-right on phones |
| Footer | `Footer` | Logo · *See More* (Home, About Us, Services) · *Follow Along* (Instagram, Tiktok, LinkedIn) · *Contact Us* (WhatsApp number, email) · legal line with © and "Jakarta · Bali · Singapore" |
| Scroll reset | `Layout` | Every route change snaps straight to the top of the page |
