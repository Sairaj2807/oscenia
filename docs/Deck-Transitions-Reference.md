# Deck Transitions Reference

Derived from **`HOME - ABOUT US.pptx`** (15 slides). This is the source of truth
for the website's motion: every direction, duration and stagger on the site
should trace back to a row in this document rather than being chosen by eye.

---

## 1. How the deck encodes motion

A `.pptx` is a zip. Two separate things control movement, and they live in
different places:

| Layer | Where | What it controls |
|---|---|---|
| **Between slides** | `<p:transition>` in `ppt/slides/slideN.xml` | How slide N-1 becomes slide N |
| **Within a slide** | `<p:timing>` in the same file | Elements animating while a slide is on screen |

Geometry lives in each shape's `<a:xfrm>`: `<a:off x y>` (top-left) and
`<a:ext cx cy>` (size), in **EMU** — 914,400 per inch. The canvas is
**13.33 × 7.50 in**.

A transition declared on a slide describes **arriving at** that slide. So
slide 2's transition *is* the slide 1 → slide 2 motion.

### Morph
Slides 2–15 all use:

```xml
<p:transition spd="slow" p14:dur="2000">
  <p159:morph option="byObject"/>
</p:transition>
```

**Morph, matched by object, 2000ms.** PowerPoint pairs shapes across the two
slides and tweens position, size and rotation between them. Nothing fades in
place — elements are parked off-canvas and *travel*. This is why the deck feels
continuous, and why a plain fade-up on the website does not resemble it.

Two consequences worth knowing:
- Shapes present on both slides **slide**; shapes that exist on only one
  **fade**. Renaming a shape breaks the pairing and silently turns a slide into
  a fade.
- Because the deck was authored by duplicating a slide and moving things,
  consecutive slides often share identical text (3≡4, 5≡6, 7–9, 10–15).

---

## 2. Slide-by-slide

Directions below are **entrances** (where an element comes *from*) unless marked
as an exit. Distances are in inches on the 13.33 × 7.50 canvas.

### Slide 1 — Hero · `fade`, 700ms
On stage: `OSCENIA`, `E V E N T S`, tagline, and the wave image.
Parked off-canvas ready for the next move: the heading (left), the 3×3 grid (right).

### Slide 2 — Company / clients · `morph`, 2000ms
| Element | Motion |
|---|---|
| Wave (`Picture 8`) | `7.50×13.33 @ (2.92, −0.70)` → `12.25×21.78 @ (1.30, −9.52)` = **scale ×1.6333**, shift `−1.62 / −8.82` |
| `OSCENIA` | exits **TOP**, Δy **−4.11** |
| `E V E N T S` | exits **TOP**, Δy **−4.11** |
| tagline | exits **TOP**, Δy **−4.11** |
| "The Company Behind our Success" | enters **from LEFT**, `x −4.98 → 1.17` (**+6.15**), y unchanged |
| 9 ovals (`1.17 × 1.13` each) | enter **from RIGHT**, cols `14.29/16.25/18.21 → 7.08/9.04/11.00` (**−7.21**), rows `2.14/3.69/5.23` unchanged |

The three hero texts travel **exactly the same distance with x unchanged** — they
move as one locked block. That is what makes it read as the hero panning away
rather than three things animating separately.

**Layout of slide 2: heading on the LEFT, 3×3 grid of circular marks on the RIGHT.**

### Slide 3 — What we Direct · `morph`
The four format panels arrive from the sides (parked on slide 2 at):

| Panel | Parked at | Enters from |
|---|---|---|
| Corporate Event | `x −4.44, y 2.25` | **LEFT** (upper) |
| Executive Gatherings | `x −4.44, y 4.88` | **LEFT** (lower) |
| Brand Experiences | `x 14.42, y 2.25` | **RIGHT** (upper) |
| Experience Systems | `x 14.42, y 4.88` | **RIGHT** (lower) |

"What we Direct" enters from **TOP**. The 9 ovals exit to **TOP-RIGHT**.

> On slide 3 → 4 these four panels *exit* to the four corners (top-left,
> bottom-left, top-right, bottom-right). The corners are the **exit**, not the
> entrance — a distinction worth keeping, since the entrance is horizontal.

### Slide 4 — Client Testimonials · `morph`
"Client Testimonials" and three rounded cards are **new objects**, so Morph
**fades** them in. They exit to **TOP**.
Within-slide: the About intro paragraph **fades** (see §3).

### Slide 5 — About Us · `morph`
`OSCENIA` enters **from LEFT**. "ABOUT US" exits **LEFT**; the intro paragraph
exits **TOP**. `OSCENIA` scales **×0.77**.

### Slide 6 — The name · `morph`
"The name combines the sense of the ocean…" exits **TOP**.
`OSCENIA` scales **×0.52** and shifts `+4.0 / −1.5` — the brand word shrinking
down as it hands over to the next section.

### Slides 7–9 — What OSCENIA Stands For · `morph`
On stage: heading, description, and `SCALE` / `FLOW` / `MEMORY`.
"Built for brands, teams, and experiences…" (the SCALE description) is present on
slide 8 and exits **BOTTOM** on 8 → 9 — i.e. it **enters from BOTTOM**.

On 9 → 10 the three circles disperse: `SCALE` exits **LEFT**, `FLOW` exits
**TOP**, `MEMORY` exits **RIGHT**.

### Slide 10 — Our Vision · `morph`
| Element | Motion |
|---|---|
| "Our Vision" | enters **from TOP** |
| "We exist to create experiences…" | enters **from BOTTOM** |

They converge on each other. This is the clearest single motion in the deck.

### Slide 11 — Why Oscenia · `morph`
"Why Oscenia" and its body are **new objects** → **fade**.
Within-slide: the body is explicitly **ON CLICK** (see §3).
On 11 → 12: heading exits **LEFT**, body exits **TOP**.

### Slides 12–15 — Our Value · `morph`
The three labels enter **from LEFT**, one per slide:

| Slide | Label arriving | From |
|---|---|---|
| 12 | Integrated Event Management, Narrative-Driven Approach | `x −4.47 / −4.63` |
| 13 | Strategic Experience Design | `x −4.86 → 1.09` |
| 14 | Integrated Event Management lands | Δx **+5.6** |
| 15 | Narrative-Driven Approach lands | Δx **+5.8** |

Each right-hand explanatory text arrives from **TOP** and **fades on click**.

---

## 3. Within-slide animations

Eight slides carry a `<p:timing>` entrance. **Every one is the same effect:**

```
presetID = 10   presetClass = entr   filter = fade
```

`presetID 10` is **Fade**. There are no flies, wipes or zooms anywhere in the deck.

| Slide | Target | Trigger |
|---|---|---|
| 4 | "OSCENIA was created from the belief…" | fade |
| 5 | same paragraph | fade |
| 6 | same paragraph | fade |
| 11 | "Why Oscenia" | fade |
| 11 | "Oscenia transforms business objectives…" | **ON CLICK** |
| 12 | "Instead of starting with: 'What event do you want?'…" | fade |
| 13 | same paragraph | fade |
| 14 | "We become a single strategic partner managing…" | fade |
| 15 | "Every event has a story…" | fade |

**The pattern: the body paragraph is always the animated element, and it is
click-revealed.** Headings and structure are already on stage; the explanation
appears when asked for. This matches the client's written feedback — *"it should
be interactive, so that when we tryna click it, the description shows up"*.

---

## 4. Slide → website section

| Slide | Website section | File |
|---|---|---|
| 1 | Hero | `src/pages/Home.jsx` |
| 2 | Client strip ("The Company Behind our Success") | `src/pages/Home.jsx` |
| 3 | What we Direct | `src/pages/Home.jsx` |
| 4 | Client Testimonials | `src/pages/Home.jsx` |
| 5 | About intro | `src/pages/About.jsx` |
| 6 | The name (OS·CEN·IA) | `src/pages/About.jsx` |
| 7–9 | What Oscenia Stands For (Scale / Flow / Memory) | `src/pages/About.jsx` |
| 10 | Our Vision | `src/pages/About.jsx` |
| 11 | Why Oscenia | `src/pages/About.jsx` |
| 12–15 | Our Value | `src/pages/About.jsx` |

The machine-readable version of this lives in **`src/data/deckMotion.js`**, which
the components read from. Change motion there, not in the components.

### Where a page differs from a slide
On a slide, one composition *replaces* another. On a page, sections sit below one
another and scroll. So:
- A **slide transition** becomes a **scroll-triggered entrance** for that section,
  and it **replays every time** the section is scrolled back to — a slide can be
  revisited, so the motion should not be a one-shot.
- The deck reveals body copy **ON CLICK** because a presenter advances it. A page
  has no presenter, so that copy **opens itself** a beat after the section is
  reached (`AUTO_REVEAL_MS`), staggered between siblings. The toggle remains, but
  it is no longer required; once a visitor uses it, the automatic behaviour stops
  so nothing moves behind their back.
- The **slide 1 → 2 morph** is the exception: it is played automatically once on
  entering the site, because it is the deck's signature move. `Home.jsx` scrolls
  from the hero to the section below over the deck's 2000ms, which carries the
  wave, lifts the wordmark and brings the grid in from the right.

---

## 5. Re-deriving this

The deck is a zip; no PowerPoint needed.

```python
import zipfile, re
z = zipfile.ZipFile('HOME - ABOUT US.pptx')

# transition for slide N (describes arriving AT slide N)
x = z.read('ppt/slides/slide2.xml').decode('utf-8', 'replace')
re.search(r'<p:transition.*?</p:transition>', x, re.S).group(0)

# within-slide animations
re.search(r'<p:timing>.*?</p:timing>', x, re.S)

# geometry: every shape's <a:xfrm>, EMU / 914400 = inches
```

To find what moves between two slides, read every shape's `name`, `<a:off>` and
`<a:ext>` on both, pair them by name (or by text when names differ), and compare.
A shape whose centre is outside `0..13.33 / 0..7.50` on one slide and inside on
the next has *entered from* that side.

**Caveat found in this deck:** in row 1 of the client grid the ovals are renamed
between slides 1 and 2, so PowerPoint cannot pair two of them — those fade while
rows 2 and 3 slide. An authoring artefact, not a design intent; do not reproduce it.
