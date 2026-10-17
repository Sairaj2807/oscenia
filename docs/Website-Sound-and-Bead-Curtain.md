# Website: Bead Curtain and Site Sound

Covers two features of `oscenia-web`. The existing docs in this folder are ERP-only.

## 1. Services page bead curtain

**Component:** `oscenia-web/src/components/BeadCurtain.jsx`, used by `src/pages/Services.jsx` inside the pinned stage. It replaces the old `LetterCurtain` (columns of the letters of "Oscenia"), which has been removed.

**What it does**
- Each column is a hanging chain pinned at the top and pulled by gravity. The beads repeat in the order logo, big, small, big.
- Verlet points joined by distance constraints. The pointer or a finger pushes the strands, and each bead turns with its strand.
- The canvas sizes to its container, only animates while on screen, and does not animate under `prefers-reduced-motion`.
- The scroll-driven rise and fade is applied by `Stage` in `Services.jsx`, and the photographed drapes (`Curtains.jsx`) are unchanged.

**Assets:** `public/services/bead-logo.png`, `bead-big.png` and `bead-small.png`.

**Tuning:** the constants at the top of `BeadCurtain.jsx`: `COL_SPACING`, `WIDTH_SHARE`, `HEIGHT_SHARE`, `GAP`, `TYPE_SCALE`, `GRAVITY`, `DAMPING`, `MOUSE_RADIUS` and `MOUSE_FORCE`.

## 2. Site sound

**Component:** `oscenia-web/src/components/Sound.jsx`, mounted once in `Layout.jsx`. The ERP under `public/erp` is not affected.

**Assets:** `public/sound/ambience.mp3` and `public/sound/pop.wav`. The originals are in `brand-assets/Sound - Ambience - SFX/`.

**Behaviour**
- Nothing plays on load, because browsers block audio before interaction. The first click, tap or key press starts the ambience, which is on by default from then on.
- Ambience loops at low volume with a 1.5 s fade. It pauses when the tab is hidden and resumes when it is visible again.
- Pop on click: one delegated `pointerdown` listener covers `button`, `a[href]`, `[role=button]` and `[data-sound]`. It has a slight random pitch variation. Add `data-sound="off"` to an element to keep it silent.
- Mute button: bottom-left glass speaker button. The choice is saved in `localStorage` under `oscenia-sound-muted`.

**Tuning:** `AMBIENCE_VOLUME`, `POP_VOLUME` and `FADE_MS` at the top of `Sound.jsx`.

**Not done yet**
- Services-specific touches: raising the ambience as the curtains part, and a pop when the tiles settle into the grid.
- A `prefers-reduced-motion` rule for sound. Ambience currently plays for those visitors too.
- Converting the WAV to a smaller format.
