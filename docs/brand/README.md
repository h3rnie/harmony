# Harmony brand — direction A, "Mission control + patch"

Restraint in the instrument; a patch for the human moments. The full review is in `directions.html` (column A).
The app's tokens live in `web/src/app.css`; the brand components in `web/src/lib/brand/`.

## Assets (`assets/`)

| File | Use |
| --- | --- |
| `mark.svg` | Stepped H for light grounds (ink `#0D1015`, ember `#C2410C`). |
| `mark-ember.svg` | Stepped H on a dark tile (text `#ECEEF2`, ember `#FF8A4C`). |
| `favicon.svg` | Browser icon; follows the viewer's light/dark scheme. |
| `app-icon.svg`, `app-icon-512.png` | Square app icon (dark tile). |
| `patch.svg` | Line patch on dark (deck, video end card). |
| `patch-light.svg` | Line patch on light. |
| `og.png` | 1200 × 630 social card (also served as `web/public/og.png`). |

The patch SVGs use live text (Barlow 500, JetBrains Mono). Install Barlow and JetBrains Mono where the deck is built,
or the ring lettering falls back to Arial Narrow / Consolas.

**The mark.** Left stem = MODIS (from 2000, ending); right stem = VIIRS (from 2012, running on); crossbar = the
overlap where the two are calibrated into one; ember tip = now.
**The patch.** 27 ticks, one per fire season 2000–2026, running clockwise from the top; the ember tick at the top is
now; long ticks mark 2000 and 2012; the dashed inner arc is the VIIRS era. HARMONY on the upper ring, AD ASTRA PER
ASPERA on the lower ring.

## Colour

| Role | Dark | Light | Notes |
| --- | --- | --- | --- |
| Ground | `#0A0D12` | `#F6F7F9` | App background, slides |
| Surface | `#121720` | `#FFFFFF` | Panels, cards |
| Hairline | `#232B37` | `#DADEE4` | Rules and borders, never text |
| Text | `#ECEEF2` (16.8 : 1) | `#0D1015` (17.8 : 1) | |
| Text 2 | `#B9C0CC` (10.6 : 1) | `#353C47` (10.4 : 1) | |
| Muted | `#8B94A5` (6.4 : 1) | `#586070` (5.9 : 1) | |
| Ember | `#FF8A4C` (8.3 : 1) | `#C2410C` (4.8 : 1) | Now, and the one thing to look at |

States (each ≥ 4.5 : 1 on ground and surface, always paired with a shape): good `#2FBF5B` / `#0A7A2A`,
warning `#FAB219` / `#8A5A00`, serious `#EC835A` / `#A8481A`, critical `#F06A6A` / `#B42828`, info `#6AA8EC` / `#1D5FBF`.
Contrast is WCAG 2 against the ground.

The two data ramps (inferno for activity, blue → orange for compared-with-normal) are fixed in
`web/src/lib/color.ts` and are colour-blind safe. Never recolour them.
Two more fixed scales exist: the calendar's "activity with confidence" mode (a value-suppressing scale plus a dot
pattern, so confidence never rests on colour alone; `vsupColor` in `color.ts`) and the Global pulse's fire clock, which
uses Crameri's cyclic romaO (`web/src/lib/pulse/cyclic.ts`, MIT licence, credited in the README). Do not recolour them either.

## Type

| Role | Face | Setting |
| --- | --- | --- |
| Wordmark, labels | Barlow 500 | Caps, tracked 0.34 em (wordmark), 0.16–0.22 em (labels, tagline) |
| Interface | Schibsted Grotesk | 400 / 600, sentence case |
| Numerals | JetBrains Mono | Tabular figures |

Fallbacks: `'Barlow', 'D-DIN', 'Arial Narrow', sans-serif` · `'Schibsted Grotesk', system-ui, 'Segoe UI', sans-serif` ·
`'JetBrains Mono', 'Cascadia Mono', Consolas, monospace`.
App scale (root 15 px): 10.5 labels · 11.7 legends · 12.9 secondary · 15 body · 16.5 answers · 20.4 section titles ·
clamp(51–81 px) hero numeral.

## Copy

- Name: **Harmony** (wordmark set as HARMONY).
- Tagline: **Two sensors. One fire record.**
- Mission: *Harmony joins two generations of fire-detecting satellite sensors into one consistent record, so anyone
  responsible for a landscape can see when it burns, which years were extreme, and how this month compares with normal.*
- Dedication: *For everyone who works the fire line, the dispatch desk and the long night after.*
- Credit: Built by Toh Yu Heng · Singapore — https://hello.hernie.me
- Event: NASA Space Apps 2026 — Harmonization of MODIS and VIIRS Hot Spots.
- Footer: © 2026 Harmony, by Toh Yu Heng. All rights reserved.

## Rules

- The motto appears **only on the patch**: intro, About, Global pulse corner, title and closing slides, video end card.
- The interface never says anything heroic. Its precision is the tribute.
- Ember marks now and the one thing to look at: the current month, the live layer, the playhead, the × of the answer.
  Keep it out of chart data areas and off controls.
- Name NASA Space Apps as the event and FIRMS as the data source. Never state or imply NASA endorsement.
- Square corners (2–3 px), hairline borders, no drop shadows on text.

**Do:** mark at 16–32 px in chrome; patch at 88 px or larger; patch on the ground colour; ember used sparingly, never as decoration.
**Don't:** recolour the mark's stems; put the patch over data (globe, map, charts); use ember for categories or
emphasis in charts; set the wordmark in lowercase or untracked; translate the motto in the interface.
