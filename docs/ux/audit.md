# Harmony UX audit: hierarchy, sequence and cognitive load

*Audit date 15 Nov 2026. Scope: the analysed view, first-run experience, map chrome, Global pulse and About.
Method: published guidance and research (Part 1), measurements of the running app with Chrome DevTools at
1600×950, 1366×768 and 400×800 (Part 2), recommendation (Part 3). No code was changed.*

**The short version.** Harmony's problem is not how much it shows. The problem is that it shows everything at the
same volume, in an order that follows how it was built rather than the questions the user is asking. The first
screen at 1366×768 holds 38 controls and 61 numbers, two large "×-normal" figures for two different time frames,
and a sticky bar of four analyst settings that sits above the answer. The plainest-language summary on the page
(the situation brief) is 4.2 screens down. The research does not say "show less". It says lead with the answer,
order the rest by the user's questions, explain terms where they appear, and fold the specialist material behind
one obvious step. Recommended: **Option A, a guided single scroll** with question titles, a sticky section index,
and the method material gathered into one closing chapter. It reuses every existing component.

---

## Part 1: What the research says

Numbers in brackets refer to the source list at the end. **Evidence** tells you what kind of support each principle
has:
- **Strong**: replicated research or a formal standard.
- **Guideline**: the consensus of expert and government guidance, without controlled studies behind it.
- **Reasoned**: my own inference from the sources, stated as such.

| # | Principle | One line of evidence | Evidence |
|---|---|---|---|
| P1 | **One primary answer, placed first, with one focal point.** | Inverted pyramid: the "most important information (or… the conclusion) is presented first" [4]. Dashboards should "display a focal point… according to hierarchy (color, position, size, and visual weight)" [31]. Operational systems lead with a single categorical level: GDACS green/orange/red [51], and CAL FIRE's five headline numbers plus an outlook sentence [53]. | Guideline, strong field practice |
| P2 | **Progressive disclosure, at most two levels.** | "The very fact that something appears on the initial display tells users that it's important." Designs "beyond 2 disclosure levels typically have low usability" [1]. | Guideline (NN/g field studies) |
| P3 | **Overview first, then zoom and filter, then details on demand.** Give an author-driven opening, then hand over to free exploration. | Shneiderman's mantra [34]. It is a design guideline, "only a starting point", not an experimental result. The martini-glass structure: "a tight narrative path early on… then opening up later for free exploration" [45]. | Guideline |
| P4 | **Support situation awareness in order: perception, then comprehension, then projection.** | Endsley's three levels [55]. In Harmony's terms: what is happening (answer), what it means (pattern, trend), what comes next (outlook). | Strong (human factors) |
| P5 | **Put settings next to what they change, and keep operational and analytic layers apart.** | Material separates operations dashboards ("answer a predefined set of questions… simple charts") from analytics dashboards (exploration) [31]. COGA: "Help users focus" [21]. Few: "arranging data poorly" and "ineffective highlighting" are pitfalls [35]. | Guideline + reasoned |
| P6 | **Recognition over recall; don't make users hold numbers in memory.** | Working memory holds "about four chunks" (Cowan [44]). Miller himself called the 7 "a pernicious, Pythagorean coincidence" [43]. Interfaces should offload remembering [10]. COGA: "Ensure processes do not rely on memory" [21]. **Overstated in pop UX:** "7±2 items per menu" misapplies the work. Menus rely on recognition, not recall [17, 20]. | Strong (cognitive psychology); the menu rule is a myth |
| P7 | **Plain language, with jargon explained where it first appears. This applies to experts too.** | "Explain the term in plain English when you first use it." The "more specialist their knowledge, the greater their preference for plain English" [25]. Experts "crave succinct information that is easy to scan" [14]. WCAG 3.1.3 and 3.1.4 (AAA) ask for a way to define jargon and abbreviations [22]. COGA: "Use clear words" [21]. | Strong (GOV.UK research) + standard |
| P8 | **Order sections by the user's questions, and use headings that describe the content.** | Layer-cake scanning of headings is "by far the most effective way to scan pages." Headings should be "descriptive of all topics in the section" and "lead with the most important words" [3]. WCAG 2.4.6 (AA) asks that headings describe the topic, and 2.4.10 asks for section headings [22]. COGA: "Make the purpose of your page clear", "Use a clear and understandable page structure" [21]. | Strong (eye-tracking) + standard |
| P9 | **Legible type, comfortable line length, a small type scale.** | WCAG 1.4.8 (AAA): no more than 80 characters per line, and line spacing of at least 1.5 [22]. WCAG 1.4.12 (AA): text spacing can be overridden without loss [22]. Contrast must be 4.5:1 (1.4.3); chart lines and heatmap cells 3:1 (1.4.11) [22]. Few's pitfall: "meaningless variety" [35]. | Standard |
| P10 | **One time frame per view; always answer "compared to what?"** | Few's pitfall "inadequate context" ("Compared to what?") [35]. Comprehension (P4) breaks when two dates share one display without a label. | Reasoned from [35, 55] |
| P11 | **The basemap sits behind the data: muted, with few labels.** | "Simpler, more neutral backgrounds are better choices for thematic maps." Grey basemaps "read as background information" [48]. Muted basemaps "sandwich thematic layers between a base layer and a label reference layer" [49]. | Guideline (cartographic practice). I found no ICA or Imhof source I could open. |
| P12 | **Speed and stability are part of simplicity.** | Response-time limits: 0.1 s, 1 s and 10 s [16]. Core Web Vitals at the 75th percentile: LCP ≤ 2.5 s, INP ≤ 200 ms, CLS ≤ 0.1 [56]. Use skeletons for full-page loads under 10 s, and they "do not replace performance optimization" [15]. Don't lazy-load what is in the first screen [56]. | Strong (measured) |
| P13 | **Do not hide content people need to compare or need to see.** Tabs are for parallel, non-compared sections. Accordions are for optional content. | Tabs only "when users don't need to simultaneously see information presented under different tabs" [6]. "Do not use an accordion for content that all users need to see," and "Test your content without an accordion first" [26]. Users scroll "only if what's above the fold is promising enough." 57 % of viewing time falls in the first screen and 74 % in the first two [8, 9]. | Guideline, consistent across NN/g, GOV.UK and USWDS [6, 7, 26–28] |
| P14 | **Reduce noise, not data. Density is acceptable when it is ordered.** Teach with context, not tutorials. | Minimalism is contested. Viewers preferred non-minimal bars [38]. Embellished charts were "no worse" for accuracy and better recalled after 2–3 weeks [39]. Visual distinctiveness improves memorability [40]. Charts: "Keep a chart simple, letting people choose when they want additional details" [33]. "Don't try to do too much… one central theme" [29]. Onboarding tutorials are "dramatically overused" and "don't result in better task performance"; prefer contextual help [11]. "Teach through interactivity" [33]. | Mixed. Charts: guideline. Onboarding: NN/g studies. |

**What is commonly overstated, and how this audit uses it:**

- **Hick's law.** It is RT = b·log₂(n+1) for *equally probable*, known choices. It does not cover scanning an
  unordered list, which grows linearly, or complex decisions [19]. It does not justify "fewer options always". Here
  the argument for fewer visible controls is P2 (what is shown signals importance) and P5, not Hick.
- **"Seven plus or minus two".** It is not a design limit (P6).
- **"The fold doesn't matter" and "nobody scrolls".** Both are wrong. Users scroll when the top earns it [8, 9].
- **Few's "a dashboard fits on a single screen" [35].** This is expert opinion. It applies to Harmony's operational
  first screen, not to the whole analysis.
- **Tufte's maximise data-ink.** It is contested as a universal rule [38–40].
- **Scrollytelling versus steppers.** The evidence is thin and mixed:
  - In a 180-person crowdsourced study, a slideshow layout beat vertical scroll for comprehension [46].
  - Another study found stepper versus scroller not significant for engagement [47].

**Where the research disagrees with the owner's hunch.** The research supports the hunch that newcomers are
overloaded, but not the remedy it implies, which is to show less data:
- Plain language helps experts too [14, 25].
- Embellished, rich charts are not worse [39].
- Operational interfaces such as CAL FIRE and GDACS are dense below a very simple top [51, 53].

The fault lies in the **missing hierarchy and sequence** (P1, P3, P8, P10) and the **unexplained terms** (P7). Volume
is not the fault. Cutting the seam or method content would also cost Validity and Creativity points.

---

## Part 2: Audit of the running app

### 2.1 What was measured, and how

Dev server on port 5193 (Vite dev build, so asset weight is not representative of production). Measurements were
taken in the page with `evaluate_script`. "Controls" means visible buttons, links, inputs and radio items. "Charts"
means visible SVG or canvas elements at least 120×60 px; the calendar is an HTML table and is counted separately.
"Numbers" means numeric tokens in visible text. The map's basemap labels are drawn on canvas, so they were counted
by eye from screenshots.

The journey: landing with no area → story preset (`#p=gran-chaco`, `#p=amazon-2019&m=2019-08`, `#p=miombo`) →
the analysed view top to bottom → Global pulse (`#view=pulse&t=2019-09`) → About.

### 2.2 Measurements

| Measure | 1600×950 | 1366×768 | 400×800 (mobile) |
|---|---|---|---|
| Analysed page height | 5,319 px = **5.6 screens** | 5,485 px = **7.1 screens** | 7,786 px = **9.7 screens** |
| Sections / headings (h1–h4) on the page | 11 / 16 | 11 / 16 | 11 / 16 |
| Interactive controls on the page | 72 | 72 | 67 |
| Controls in the first screen (header + map + analysis) | 39 | **38** (5 + 20 + 13) | 35 before the answer starts |
| Charts on the page (plus the calendar table) | 7 + 1 | 7 + 1 | 7 + 1 |
| Numbers in the first screen, analysis column | n/a | **48** (+13 on the map) | n/a |
| "×-normal" hero figures in the first screen | 2 (Sep 2020 and this week) | 2 | 1 (below the fold) |
| Visible text elements / words on the page | 449 / 1,306 | 445 / 1,295 | n/a |
| Words in the first screen | 294 | 250 | n/a |
| Answer numeral top edge | 270 px | 270 px | **844 px (below the 800 px fold)** |
| Sticky controls bar height | 126 px (14 % of the column) | 126 px (**18 %** of 716 px) | 228 px (not sticky) |
| Time from choosing a preset to the answer | 0.56 s (warm) | n/a | n/a |
| Cold load of `#p=canada-2023`: LCP / CLS | 0.90 s (LCP is the answer sentence) / 0.028 | | |

**Typography and visual system** (analysis column, Gran Chaco):

- **14 distinct font sizes** in use (10, 10.5, 11.1, 11.7, 12.9, 15, 15.6, 16.5, 20.4, 22.5, 31.4, 44.6, 57, 81 px).
  Plus 4 font families (three brand faces and the map's Helvetica Neue).
- **71 % of words are set below 13 px** (875 of 1,232). Only 68 words (5.5 %) are at 16 px or larger. The root size is
  15 px, so body text is 15 px, and controls and secondary text are 12.9 px.
- **35 tracked-caps eyebrow labels** at 10.5 px. Together with the H2 titles, most sections carry two titles.
- 8 text colours, 10 border styles.
- The longest measured paragraph line is about 150 characters (the exports acknowledgement and brief at 1600 px).
  Most ledes are capped near 60–75 characters.
- Contrast: the brand tokens pass WCAG AA in both themes. The automated scan found no real text failure. The few hits
  were disabled buttons (exempt) and artefacts of how the scan reads translucent backgrounds.

**Jargon before explanation** (word position counted from the top of the analysis column):

| Term | First appears at word | Times used | Where it is explained |
|---|---|---|---|
| "Anomaly" / "Percentile" (calendar mode buttons) | 12 | 2 | Nowhere in place |
| "Baseline", "Overpass" (control labels) | 1–10 | 1 each | Overpass only in the collapsed Method section |
| "percentile" (answer sentence) | 32 | 2 | Not explained |
| **"AFCD-M"** | **43** | **7** before its definition | Only in the collapsed Method section at about word 1,200 (5,120 px), and in the footer |
| "median" | 45 | 8 | Partly ("the normal for September") |
| "Theil–Sen … p = 0.02" (trend KPI) | 71 | 3 | Not explained |
| "q25–q75" (Now card) | 149 | 2 | Not explained |
| "provisional", "near-real-time" | 209 | several | Tooltip only |
| "VIIRS" | 255 | 11 | In the seam section, about 140 words later |
| "seam" | 398 | 1 heading | Explained in the next sentence (good) |

**Map chrome** (Gran Chaco, 1600×950):

- **7 floating panels**: tool bar (9 buttons), area chip, cell legend (2-way toggle), live panel (4-way toggle), zoom,
  scale, attribution.
- They cover **22.6 %** of the map and carry 20 controls, 79 words and 13 numbers.
- **4 data layers at once**: basemap with about 20–25 place labels (city names plus italic region names such as
  "DEPARTAMENTO DE BOQUERÓN" drawn over the data), the cell grid, the area outline, and live hotspot dots.
- **Two time frames on one map.** The cells show the focus month (September 2020). The blue dots show detections from
  the last 24 hours (November 2026). Nothing on the map says the two layers belong to different dates.
- On mobile, the live panel sits over the middle of the area and the legend covers its lower part.

**Order of the analysed view** (top to bottom, with section eyebrows):

```
controls bar (sticky) ─ Years shown · Baseline · Overpass · Calendar mode    10 controls
01 This month vs normal   answer + 4 KPIs                                    340 px
—  Live · last 7 days     second hero (this week), bar chart                 649 px   unnumbered, different time frame
02 Burning calendar       year × month table                                 797 px
03 Why harmonize?         the 2012 seam, raw vs harmonized                   551 px   method
—  Method lab             in-browser ML (collapsed)                          177 px   unnumbered, method
04 Season & year to date  two charts                                         414 px
05 Trend                  bar chart, title "Falling"                         408 px
06 Outlook                three figures + chart                              499 px
07 Situation brief        AI brief + Ask Harmony                             737 px   plain-language summary at 4,014 px
08 Exports                10 buttons                                         370 px
09 Method                 collapsed                                          100 px
```

**Global pulse**: one headline ("September 2019"), one visual, one timeline, 9 controls, 66 words. **About**: 152 words,
one heading, and a clear statement of what Harmony is and is not. Both are already calm. The pulse is the model the
analysed view should follow.

### 2.3 What already works and must be kept

- **Answer first.** The status strip leads with one large figure ("1.5× the normal for September"), a sentence of
  rank and percentile, a level chip, and a shape and colour pair. This follows the inverted pyramid and the NWS and
  GDACS practice of giving a status level first. Keep it, and keep it on top.
- **The burning calendar.** Heatmap rows by year and columns by month, readable at a glance and keyboard-operable. It
  pairs with an accessible table, uses the colour-blind-safe inferno ramp, and has a median row. It is the product's
  signature and the best "pattern" view on the page.
- **Colour-blind-safe ramps and shape-paired state chips.** Level chips pair colour with a triangle, diamond or circle
  (WCAG 1.4.1). Do not recolour the ramps.
- **Keyboard and screen-reader work.** Skip link, `aria-live` summary announcement, radiogroups, tables behind
  `<details>`, and focus restored after closing the pulse.
- **Speed and stability.** The answer paints in about 0.6–0.9 s, CLS is 0.028, and there is a skeleton while loading.
- **The pulse and About**, as they are. The intro's three-step "how it works" and the story cards are a good first-run
  pattern.
- **The situation brief.** It is the best plain-language summary on the page; it is in the wrong place.
- **Restraint in the brand.** Hairlines, no shadows, ember only for "now". The research below supports this kind of
  restraint.

### 2.4 Findings, ranked by severity

Severity: **S1** blocks or misleads a first-time or time-pressed user. **S2** adds measurable load or friction.
**S3** is polish.

| # | Sev | Finding | Evidence | Principle violated (Part 1) |
|---|---|---|---|---|
| F1 | S1 | **Two answers for two time frames compete in the first screen.** "1.5× the normal for September (2020)" and "1.6× the normal daily pace for November (2026)" use the same big-numeral style and the same × glyph, and the Now card has its own level chip. The map adds a third layer: last-24-hour dots over September-2020 cells. | 2 hero figures and 2 level chips in the 1366 first screen. The map mixes two dates with no label. | P1 one primary answer, P4 situation awareness, P10 one time frame per view |
| F2 | S1 | **Analyst settings come before the answer.** The sticky bar (Years shown, Baseline, Overpass, Calendar mode) is the first thing in the column. It is shown even on the landing page, where it does nothing. On mobile it pushes the answer below the fold. | 10 controls above the answer. 126 px sticky (18 % of the 1366 column). Mobile: 35 controls before the answer, numeral at 844 px. | P2 progressive disclosure, P5 controls in context, P6 recognition over recall |
| F3 | S1 | **Unexplained jargon in the answer itself.** "AFCD-M" is used 7 times before its only definition, which is collapsed at the bottom of the page. "Percentile", "Theil–Sen", "p = 0.02", "q25–q75", "Anomaly" and "Baseline" are never explained where they appear. | Jargon table: first jargon at word 12, AFCD-M at word 43, definition at about word 1,200. | P7 plain language / WCAG 3.1.3, COGA "use clear words" |
| F4 | S2 | **The order follows the build, not the user's questions.** Method material (the seam, the ML lab) sits in positions 4–5 of 11, between "when does it burn" and "how is this year going". The plain-language brief is at 4,014 px. Numbering skips two sections (01, —, 02, 03, —, 04…), so it reads as broken. | Order table above; 2 of 11 sections unnumbered. | P3 overview first then details on demand, P8 sequence by question |
| F5 | S2 | **No visual hierarchy below the answer.** Every section has the same eyebrow + H2 + lede + chart + legend, at the same width and weight. Most text is small: 71 % of words are below 13 px, there are 14 font sizes, and 35 tracked-caps eyebrows. | Typography measurements. | P9 legibility, P1 hierarchy |
| F6 | S2 | **The map is crowded.** 7 floating panels cover 22.6 % of the map, with 20 controls and 4 data layers. About 20–25 basemap labels, including region names, are drawn over the data. On mobile, the live panel covers the area. | Map measurements, screenshots. | P11 map generalisation, P2 |
| F7 | S2 | **Section titles are clever, not descriptive.** "Falling", "Now", "For the duty officer", "Take it with you", "The 2012 seam" make sense after reading, not before scanning. This weakens the headings as a scan path (WCAG 2.4.6). | Heading list. | P8, P7 |
| F8 | S2 | **The page is long with no map of where things are.** 5.6–9.7 screens, 11 sections, no section index. The sticky bar holds settings, not navigation. | Page height. | P3, P8 |
| F9 | S2 | **The answer changes after it is shown, and a story can contradict itself.** `#p=miombo` first rendered November 2026, then switched to July 2026 when the pending focus month resolved. Opening `#view=pulse&t=2019-09` by changing the hash in an open app first showed November 2000. The Amazon 2019 story, billed as the famous fire year, lands on "1.4× · near normal" with no framing. | Observed in the journey. | P4, P12 perceived stability |
| F10 | S3 | **Technical chrome in the header.** The "WASM KERNEL" chip means nothing to the audience. | Header. | P7 |
| F11 | S3 | **Touch targets are small.** Every control is under 44 px tall on mobile, and 10 are under 24 px (WCAG 2.5.8 is 24 px minimum). | Mobile measurement. | P9 |
| F12 | S3 | **Body text is 15 px**, below the 16 px most design systems use, and long paragraphs run up to about 150 characters at 1600 px. | Type scale; line measurement. | P9 |

---

## Part 3: Recommendation

### 3.1 Three information-architecture options

All three keep the map on the left and the answer at the top. They differ in how depth is disclosed.

#### Option A: Guided single scroll, question titles, sticky section index (recommended)

```
┌ H HARMONY │ Two sensors. One fire record.        ● Record 15 Nov 2026 · live 3 h  [Global pulse] Method About ◐ ┐
├───────────── map 42 % ─────────────────┬───────────────────────── reading column 58 % (max 72ch text) ──────────────┤
│ [Stories ▾] [Draw area ▾] [⌖] [⇪]      │ GRAN CHACO · 680,639 km²                              [Month: Sep 2020 ▾] │
│                                        │ ┌──────────────────────────────────────────────────────────────────────┐ │
│                                        │ │ 1.5×  the normal for September          ▲ Above normal                │ │
│     area outline + cells for           │ │ 4th most active September in 26 years. The fire season here runs     │ │
│     Sep 2020 only                      │ │ Jul–Dec and peaks in September. Burning has fallen about 2 % a year. │ │
│     (live dots off unless the          │ │ ⓘ What "normal" means                                                │ │
│      month in view is the latest)      │ └──────────────────────────────────────────────────────────────────────┘ │
│                                        │  Year so far  0.43× normal │ Peak month  September │ Record  Aug 2001     │
│                                        │                                                                           │
│                                        │ ┌ On this page ──────────────────────────────────────────────────────────┐│
│                                        │ │ When does it burn? · Is this year unusual? · Is it getting worse? ·   ││
│                                        │ │ What's next? · Right now · Brief & export · How we know               ││
│ ┌ Sep 2020 · fire activity ────────┐   │ └────────────────────────────────────────────────────────────────────────┘│
│ │ ▁▂▃▅▇  low → high   [vs normal]  │   │ When does it burn?                          [Activity | vs normal]   ⚙   │
│ └──────────────────────────────────┘   │ ████████████ calendar 2000–2026 × Jan–Dec ████████████                    │
│                          [+][−]  ©     │ …                                                                         │
└────────────────────────────────────────┴───────────────────────────────────────────────────────────────────────────┘
 Mobile: answer card first (map collapses to a 200 px strip with "Show map"), then the index as horizontal chips, then sections.
```

- **How it works.** One reading column in question order:
  1. **Answer**: the strip, with the brief's first sentence merged in.
  2. **When does it burn?**: the calendar, with the mode switch and a ⚙ "Years and baseline" disclosure in its header.
  3. **Is this year unusual?**: season and year so far.
  4. **Is it getting worse?**: trend.
  5. **What's next?**: outlook.
  6. **Right now**: the live card, own time frame, clearly dated.
  7. **Brief, ask and export.**
  8. **How we know**: the seam, the ML lab and the method, gathered into one chapter. The seam stays open as the
     chapter's lead visual.

  A sticky "On this page" index replaces the sticky settings bar. The detail rows (80 % intervals, Theil–Sen, q25–q75)
  move behind "Details" toggles inside each section.
- **Cost from the current code: M.** About 2–4 days. It reorders the `{#each}` in `App.svelte`, moves `ControlsBar`
  pieces into `CalendarView` and a popover, adds a small `SectionIndex.svelte` (IntersectionObserver), retitles
  sections, and adds a `Term` tooltip component. No new charts.
- **Risks.** Still long (about 4.5 screens at 1600). The sticky index must not become a second toolbar. Judges must
  still find the seam, so the index names it and the hero links to it ("How we know →").

#### Option B: Summary first, then tabs for depth

```
┌ header ────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
├──────────── map ─────────────┬── GRAN CHACO · Sep 2020 ─────────────────────────────────────────────────────────────┤
│                              │ 1.5× normal ▲ Above normal · 4th of 26 · season Jul–Dec · falling 2 %/yr            │
│                              │ ┌Overview┬Calendar┬This year┬Trend & outlook┬Live┬How we know┐  [Export ▾]           │
│                              │ │ calendar thumbnail + brief + 3 KPI                         │                       │
│                              │ └────────────────────────────────────────────────────────────┘                       │
└──────────────────────────────┴──────────────────────────────────────────────────────────────────────────────────────┘
 Mobile: tabs become a horizontal scroller under the answer; one panel at a time.
```

- **Cost: M–L.** About 4–6 days. It needs a tab component with roving focus and URL state (`#tab=`), lazy chart
  mounting (charts measure width on mount, so hidden tabs need a resize on show), and an Overview panel that does not
  exist yet.
- **Risks.**
  - Content in tabs is seen less often (NN/g). Users cannot compare the calendar with the season charts side by side.
  - Judges and newcomers may never open "How we know". That is where the Validity and Creativity scores live.
  - Screenshots and printing get harder, and it breaks the single-scroll demo video.

#### Option C: Essentials / Analyst mode switch

```
┌ header … [ Essentials | Analyst ] ┐
Essentials: answer · calendar · brief · "Right now" · export      (≈2 screens)
Analyst:    today's full stack + controls bar + method lab
```

- **Cost: S–M.** About 1–3 days. Wrap sections in `{#if mode === 'analyst'}` and persist the mode in the URL and
  local storage.
- **Risks.**
  - I found no direct study of novice/expert mode switches, so this is reasoned from P2. The initial display tells
    people what matters, so content behind a mode reads as unimportant. Users must also understand which mode they
    are in, and a mode adds a second disclosure level on top of every in-section toggle.
  - It splits the product into two experiences to QA and present.
  - Hidden-by-mode content can't be found by search or by a colleague's link.
  - The judging story (seam, ML lab) is hidden by default, or the mode defaults to Analyst and fixes nothing.

#### Option D (narrative): Answer → pattern → change → what next → evidence

This is Option A's order. It is folded into A rather than built as a separate step-by-step wizard with Next buttons:
- GOV.UK's "one thing per page" is a form pattern [24].
- A wizard would force analysts through the steps.

The evidence is not one-sided. One crowdsourced study found a slideshow beat vertical scroll for comprehension [46].
So a stepped **story mode for the presets** (nice-to-have 12) is a reasonable later experiment. It should not be the
default analysed view.

**Recommendation: Option A.**

- It fixes the S1 findings by moving and retitling things, not by removing them.
- It keeps everything one scroll or one click away for analysts and judges.
- It matches the overview-first, inverted-pyramid and martini-glass findings: an author-driven opening that hands
  over to free exploration.
- It costs the least for its benefit.

Why not B: tabs hide the method story that earns Validity and Creativity, and they block comparison across views.
Why not C: mode switches are among the weakest forms of progressive disclosure. They double the surface without
helping a newcomer decide.

#### First-run experience (all options)

- **Keep the intro as is**, minus the controls bar. Story cards and the three steps are good.
- **No tour.** NN/g finds onboarding tutorials "dramatically overused" with no performance benefit, and does not
  recommend deck-of-cards tours [11, 12]. Apple advises context-specific tips [33]. So use **contextual help** instead:
  - the `Term` explanations (3.3);
  - a one-line, dismissible hint under the answer on the first analysis only: "Click any month in the calendar to map
    it";
  - an "ⓘ What 'normal' means" link in the answer card.
- **Give each story card a one-line "what to notice"** that sets expectations. Example for Amazon 2019: "The outcry
  was global; the satellite count was only 1.4× normal. Look at 2005 and 2007 in the calendar."

### 3.2 Disposition of every existing element

| Element | Disposition | Detail |
|---|---|---|
| **Header**: wordmark + tagline | Keep | Tagline already hides below 1180 px. |
| Header: "WASM KERNEL" chip | **Remove** (move to Method) | Means nothing to the audience. Demo-data chip stays. |
| Header: Record / Live freshness chip | Keep, simplify | "Data to 15 Nov 2026 · live 3 h ago". Sentence case, not tracked caps. |
| Header: Global pulse, Method, About, theme | Keep | |
| **Controls bar**: Years shown | **Move** | Into the ⚙ "Years and baseline" popover in the calendar header. Default is fine for 95 % of users. |
| Controls bar: Baseline | **Move + explain** | Same popover, with the line "Normal = the median of these years for the same month." |
| Controls bar: Overpass (Both/Day/Night) | **Move, collapse by default** | Same popover, under "Advanced"; rename "Satellite pass: day and night / day only / night only". |
| Controls bar: Calendar mode | **Move** | Into the calendar header as "Activity / vs normal / Rank". Drop "Percentile" as a label, or keep it with a tooltip. |
| Controls bar: sticky behaviour | **Replace** | With a sticky "On this page" index (desktop) or chips (mobile). Keep the 2 px progress bar under the header. |
| **01 Answer strip**: hero ratio | Keep as is | Make it the only hero numeral on the page. |
| Answer: percentile · rank sentence | Simplify | "4th most active September in 26 years". Percentile goes to the tooltip or details. |
| Answer: level chip | Keep | |
| Answer: AFCD-M / 80 % / median / source line | **Collapse** | Behind "Details". Write the unit once as "fire-days (AFCD-M)" with a term tooltip. |
| KPI: Year to date | Keep, simplify | "Year so far: 0.43× normal (25th of 26)". |
| KPI: Trend | Simplify | "Falling about 2 % a year". The Theil–Sen and p-value move to the trend section's details. |
| KPI: Peak month | **Merge** | Into the answer sentence ("season Jul–Dec, peaks in September"). Frees a slot. |
| KPI: Record month | Keep | "Record: August 2001 (1.9× normal)". |
| **Now card** (live) | **Move + retitle** | After the outlook as "Right now (last 7 days)", with its own date stamp. Its hero shrinks to stat size (22.5 px) so it never competes with the answer. When the focus month is the latest month, show one line in the answer card instead: "This week: 1.6× the normal pace →". |
| Now: Refresh, Live hotspots CSV | Keep, move | Refresh stays. The CSV moves to Export. |
| **02 Calendar** | Keep as is (signature) | Title "When does it burn?". The legend's era-mark key moves into a "Reading the calendar" disclosure. |
| **03 The 2012 seam** | **Move** | To open the "How we know" chapter. Title "Why two sensors had to be joined". Keep the toggle and the 4 figures. |
| **Method lab** | **Move + collapse** (already collapsed) | Inside "How we know", after the seam. |
| **04 Season + year to date** | Keep, retitle | "Is this year unusual?". Keep both charts side by side. The "Compare with" select stays in context. |
| **05 Trend** | Simplify, retitle | "Is it getting worse?". Lead: "Burning has fallen about 2 % a year since 2001 (likely a real trend)". The statistics move to details. |
| **06 Outlook** | Keep, retitle | "What's next?". The 80 % ranges become "likely range". |
| **07 Situation brief** | **Split** | Its first sentence joins the answer card. The full brief and Ask Harmony become "Brief and questions", directly before Export. Title "Brief for the duty officer" (keeps the brand voice, says what it is). |
| **08 Exports** | Keep, simplify | "Share and export". The primary action is "Copy link"; the rest sit under "Data and figures". |
| **09 Method** | Keep (collapsed) | Last part of "How we know". It gains the glossary. |
| Numbering "01 · …" eyebrows | **Remove** | The numbering is broken (2 sections unnumbered). The question titles and the index carry the sequence. |
| Eyebrows generally | **Reduce** | Keep tracked caps only for the map legend, KPI labels and the answer's area name. Target 10 or fewer per page (now 35). |
| Demo-data banner | Keep | |
| No-detections state | Keep | Add "Try a larger area" as a button. |
| **Map**: tool bar | Simplify | Keep Stories, Coordinates and GeoJSON. Polygon, rectangle and circle collapse into a "Draw area ▾" menu. Edit and Clear appear only when an area exists. 9 buttons become 4–6. |
| Map: area chip | **Move** | Into the reading column header (name + km²). Drop "24,258 cells @ L0" from the default view. |
| Map: cell legend | Keep, simplify | Title "Sep 2020 · fire activity". Keep the Activity / vs normal toggle. Unit line: "fire-days per cell". |
| Map: live panel | **Merge** | Into the legend as a "Show last 24 h detections" checkbox, with the age options in a small menu. Default off when the month in view is not the latest month. When on, add a "Live (Nov 2026)" key. |
| Map: live hotspot dots | Collapse by default (historic month) | See F1. |
| Map: basemap labels | Simplify | With the data overlay on, show country, capital and major city labels only, and hide admin-region labels. Mute label colour to ink-3 with a halo. |
| Map: zoom, scale, attribution | Keep | Attribution is required. |
| **Footer** | Keep | |
| **Intro** (no area) | Keep, minus the controls bar | Move the pulse CTA below the story cards, or make it smaller. It currently competes with the main task ("Pick any area"). |
| **Global pulse** | Keep as is | Exemplar. |
| **About** | Keep as is | |

### 3.3 Plain-language naming

**Section titles as user questions:**

| Now | Proposed |
|---|---|
| 01 · This month vs normal / "September 2020" | **How does September 2020 compare with normal?** (the month stays the visual title) |
| Live · last 7 days / "Now" | **What is burning right now?** (last 7 days, provisional) |
| 02 · Burning calendar / "Every month since 2000" | **When does this area burn?** |
| 03 · Why harmonize? / "The 2012 seam" | **Why two sensors had to be joined** (in "How we know") |
| Method lab / "Would machine learning do better?" | **Would machine learning do better?** (keep; it is already a question) |
| 04 · Season & YTD / "How 2026 is unfolding" | **Is this year unusual?** |
| 05 · Trend / "Falling" | **Is burning increasing or decreasing?** (the answer "Falling about 2 % a year" becomes the lead) |
| 06 · Outlook / "Next 3 months" | **What's likely in the next three months?** |
| 07 · Situation brief / "For the duty officer" | **Brief for the duty officer** + **Ask a question** |
| 08 · Exports / "Take it with you" | **Share and export** |
| 09 · Method / "How the record is harmonized" | **How we know** (the chapter) / How the record is built |

**Jargon: replace, or explain once where it first appears.** Use a `Term` component with a dotted underline and a
tooltip or popover that is keyboard-reachable; the WCAG 3.1.3 "unusual words" technique G62 is a glossary.

| Term | In the interface | One-time explanation |
|---|---|---|
| AFCD-M | "fire-days" in running text; "AFCD-M" in axis units and exports | "Fire-days: each 1.4 km square that had at least one satellite fire detection on a given day or night, counted the way MODIS counts them, so 2000 and 2026 are comparable. Not burned area." |
| Normal / median / baseline | "normal" | "Normal = the middle value for the same month across 2003–2022. Change the years under ⚙." |
| × normal | keep | "2× = twice the usual activity for this month." |
| Percentile | Drop from the headline; "rank" | "83rd percentile = more active than 83 of every 100 baseline Septembers." |
| Anomaly (calendar mode) | "vs normal" | Same as × normal. |
| Overpass: Both / Day / Night | "Satellite pass: day and night / day only / night only" | "Satellites cross each place about once by day and once by night. Night-only removes most agricultural burning." Adjust to what the data supports. |
| Provisional / near-real-time | "provisional" + date | "Recent data that has not had final quality checks yet. Numbers may change." |
| Seam (2012) | "the 2012 jump" in running text | "In 2012 the finer VIIRS sensor took over; raw counts jump about 4.7× because it sees more small fires, not because more burned." |
| Theil–Sen, Mann–Kendall, p | Hide in details; "likely a real trend" / "could be chance" | p < 0.05 → "likely a real trend", otherwise "could be chance". |
| 80 % range / q25–q75 | "likely range" | "8 times in 10 the value falls in this range." |
| MODIS, VIIRS | Keep (they are the story) | Name them once: "MODIS (2000–) and VIIRS (2012–), the two generations of fire-detecting satellite instruments." |
| L0 / cells @ L1 / WASM | Remove from the default view | Method page only. |

### 3.4 Acceptance criteria for the redesign

Measured with the same scripts at 1366×768 (desktop) and 400×800 (mobile), Gran Chaco, September 2020.

**First screen**

1. The first analysed screen contains **one** hero answer, **at most three** supporting figures, and **at most one**
   chart or calendar preview. It shows **no more than one "×-normal" numeral**.
2. **No more than 4 controls** sit above the answer in the reading column (now 13), and **at most 25 controls** are
   visible in the first screen including map and header (now 38).
3. **At most 25 numbers** are in the analysis column's first screen (now 48).
4. On mobile, the answer numeral is **inside the first 800 px** (now 844 px), with **0 settings** before it (now 35
   controls).

**Map**

5. The map shows **at most 4 floating panels by default** (tool bar, legend, zoom, attribution and scale counted as
   one), covering **at most 12 %** of the map (now 7 panels, 22.6 %).
6. The map shows **one time frame by default**. Live dots are off when the month in view is not the latest month.
   When they are on, the legend names both dates.

**Language and sequence**

7. **Every jargon term in 3.3** is explained in place, or replaced, at its first appearance. **0** uses of "AFCD-M"
   come before its explanation (now 7).
8. **Every section can be understood without the Method page**: each starts with a one-sentence answer in plain
   language. Check this with a 5-second test: 4 of 5 newcomers can say what the section shows.
9. **Section titles are questions or plain statements**, and all are listed in a section index. The numbering is
   either consistent or gone.
10. **Method material** (seam, lab, method) sits in **one** chapter, after the user-question sections.

**Type and legibility**

11. Body and answer text is **16 px or larger**. **At least 60 % of words** are at 15 px or larger (now 29 %). There
    are **at most 8 font sizes** (now 14) and **at most 10 tracked-caps labels** per page (now 35).
12. Reading text has a line length of **75 characters or fewer** (CSS `max-width: 70ch` on prose).

**Accessibility and performance**

13. **Nothing falls below WCAG 2.2 AA**: text 4.5:1 (large 3:1), non-text 3:1 (1.4.11). Touch targets are at least
    24×24 px (2.5.8), and 44×44 px on mobile for primary actions.
14. **Time from choosing a preset to the answer is 1.5 s or less** on a warm production build. LCP is 2.5 s or less
    and CLS 0.1 or less at the 75th percentile (web.dev). Charts below the first screen mount lazily.
15. **The answer never changes after first paint** without a visible transition and announcement (F9).

### 3.5 Build plan

**Must do** (fixes S1 and S2; about 4–6 days in total)

| # | Change | Size | Files |
|---|---|---|---|
| 1 | Remove the sticky controls bar. Move the calendar mode into `CalendarView`'s header. Put Years, Baseline and Overpass in a ⚙ popover in the calendar header. Hide everything when no area is selected. | M | `App.svelte`, `ControlsBar.svelte` → `AnalysisSettings.svelte`, `CalendarView.svelte` |
| 2 | Reorder the sections in question order and gather the seam, lab and method into a "How we know" chapter at the end. | S | `App.svelte` |
| 3 | Separate the time frames. Move the Now card after the outlook, shrink its hero to stat size, and add a one-line "This week" link in the answer card when the month in view is the latest. Turn live map dots off by default for historic months and label the dates in the legend. | M | `NowCard.svelte`, `StatusStrip.svelte`, `MapPanel.svelte`, `MapLegend.svelte` |
| 4 | Retitle all sections as questions, drop the "01 ·" numbering, and cut eyebrows to 10 or fewer. | S | each section component |
| 5 | Add a `Term` component with glossary text. Apply it to AFCD-M, normal, percentile, provisional, the seam and overpass at first use. Make "fire-days" the running-text name. | M | new `lib/components/Term.svelte`, `lib/glossary.ts`, `StatusStrip`, `CalendarView`, `MapLegend`, `NowCard` |
| 6 | Make the answer card plain: merge the peak month into the sentence, put the AFCD-M/80 %/median line and the Theil–Sen/p values under "Details", and lift the brief's first sentence into the card. | S–M | `StatusStrip.svelte`, `BriefCard.svelte` |
| 7 | Simplify the map chrome: a "Draw area ▾" menu, Edit and Clear only with an area, the area chip moved to the column header, the live panel merged into the legend. | M | `MapPanel.svelte`, `MapLegend.svelte` |
| 8 | Raise the type floor: root 16 px (or body 1.067 rem), secondary 13.5–14 px, prose `max-width: 70ch`, collapse the scale to 8 steps. Re-check the chart layouts. | S–M | `app.css`, a few component styles |
| 9 | Add a sticky "On this page" section index (desktop) and chips (mobile), with IntersectionObserver for the active state. | S–M | new `SectionIndex.svelte`, `App.svelte` |
| 10 | Fix answer stability: resolve the preset's pending month before first paint (or hold the skeleton), and honour `t=` when the pulse opens by hashchange. | S | `session.svelte.ts`, `App.svelte` / pulse |

**Nice to have**

| # | Change | Size |
|---|---|---|
| 11 | A first-analysis contextual hint (one line, dismissible, localStorage). No multi-step tour [11]. | S |
| 12 | A "what to notice" line on each story card. Reframe Amazon 2019. Optional later: a stepped story mode for presets (answer → pattern → change → next → evidence), A/B-tested against the scroll [46, 47]. | S / M |
| 13 | A basemap label filter while the data overlay is on (hide admin-region labels, mute the label colour). | S |
| 14 | Mobile: the answer card above the map, with the map collapsed to a strip plus "Show map". | M |
| 15 | Lazy-mount the charts below the first screen with IntersectionObserver, and measure the production bundle (the dev build moved 19.8 MB in 201 requests). | S–M |
| 16 | Move the "WASM kernel" chip to the Method page. Make primary touch targets 44 px on mobile. | S |
| 17 | Run a 5-person first-click and 5-second test with the presets before and after (newcomers and one emergency manager, if possible). | S |

---

## Sources

Each URL was checked with a live request on 15 Nov 2026.
- **V**: I read the cited claim on the page.
- **R**: the URL resolves, but the publisher blocks automated reading. The claim comes from the standard citation or
  an open copy.

1. Nielsen, J. *Progressive Disclosure*. NN/g, 2006. https://www.nngroup.com/articles/progressive-disclosure/ (V)
2. Pernice, K. *F-Shaped Pattern of Reading on the Web: Misunderstood, But Still Relevant*. NN/g, 2017. https://www.nngroup.com/articles/f-shaped-pattern-reading-web-content/ (V)
3. Pernice, K. *The Layer-Cake Pattern of Scanning Content on the Web*. NN/g, 2019. https://www.nngroup.com/articles/layer-cake-pattern-scanning/ (V)
4. Schade, A. *Inverted Pyramid: Writing for Comprehension*. NN/g, 2018. https://www.nngroup.com/articles/inverted-pyramid/ (V)
5. Laubheimer, P. *Dashboards: Making Charts and Graphs Easier to Understand*. NN/g, 2017. https://www.nngroup.com/articles/dashboards-preattentive/ (V)
6. NN/g. *Tabs, Used Right*. Revised 2024. https://www.nngroup.com/articles/tabs-used-right/ (V)
7. Wang, H. *Accordions on Desktop*. NN/g, 2023. https://www.nngroup.com/articles/accordions-on-desktop/ (V)
8. Fessenden, T. *Scrolling and Attention*. NN/g, 2018. https://www.nngroup.com/articles/scrolling-and-attention/ (V)
9. Schade, A. *The Fold Manifesto: Why the Page Fold Still Matters*. NN/g, 2015. https://www.nngroup.com/articles/page-fold-manifesto/ (V)
10. Whitenton, K. *Minimize Cognitive Load to Maximize Usability*. NN/g, 2013. https://www.nngroup.com/articles/minimize-cognitive-load/ (V)
11. Laubheimer, P. *Onboarding Tutorials vs. Contextual Help*. NN/g, 2023. https://www.nngroup.com/articles/onboarding-tutorials/ (V)
12. Kendrick, A. *Mobile-App Onboarding: An Analysis of Components and Techniques*. NN/g, 2020. https://www.nngroup.com/articles/mobile-app-onboarding/ (V)
13. Kaplan, K. *Designing Empty States in Complex Applications*. NN/g, 2021. https://www.nngroup.com/articles/empty-state-interface-design/ (V)
14. Loranger, H. *Plain Language Is for Everyone, Even Experts*. NN/g, 2017. https://www.nngroup.com/articles/plain-language-experts/ (V)
15. Tankala, S. *Skeleton Screens 101*. NN/g, 2023. https://www.nngroup.com/articles/skeleton-screens/ (V)
16. Nielsen, J. *Response Times: The 3 Important Limits*. NN/g, 1993. https://www.nngroup.com/articles/response-times-3-important-limits/ (V)
17. Nielsen, J. *Short-Term Memory and Web Usability*. NN/g, 2009. https://www.nngroup.com/articles/short-term-memory-and-web-usability/ (V)
18. Sherwin, K. *Hick's Law: Designing Long Menu Lists* (video). NN/g, 2018. https://www.nngroup.com/videos/hicks-law-long-menus/ (V, summary only)
19. *Hick's law*. Wikipedia. https://en.wikipedia.org/wiki/Hick%27s_law (V)
20. Yablonski, J. *Laws of UX*: Miller's Law and Hick's Law. https://lawsofux.com/millers-law/ ; https://lawsofux.com/hicks-law/ (V)
21. W3C COGA TF. *Making Content Usable for People with Cognitive and Learning Disabilities*. W3C Working Group Note, 29 Apr 2021. https://www.w3.org/TR/coga-usable/ (V)
22. W3C WAI. *Understanding WCAG 2.2*: 1.4.1, 1.4.3, 1.4.8, 1.4.11, 1.4.12, 2.4.6, 2.4.10, 3.1.3, 3.1.4, 3.3.2. https://www.w3.org/WAI/WCAG22/Understanding/ (all resolve; 1.4.8, 1.4.11, 1.4.12 and 3.1.3 read)
23. Government Digital Service. *Government Design Principles*. https://www.gov.uk/guidance/government-design-principles (V)
24. GOV.UK Service Manual. *Structuring forms* (one thing per page). https://www.gov.uk/service-manual/design/form-structure (V)
25. GOV.UK. *Writing guidelines: Use clear language*. https://guidance.publishing.service.gov.uk/writing-to-gov-uk-standards/writing-guidelines/clear-language/ (V)
26. GOV.UK Design System. *Accordion*. https://design-system.service.gov.uk/components/accordion/ (V)
27. GOV.UK Design System. *Tabs*. https://design-system.service.gov.uk/components/tabs/ (V)
28. US Web Design System. *Accordion*. https://designsystem.digital.gov/components/accordion/ (V)
29. US Web Design System. *Data visualizations*. https://designsystem.digital.gov/components/data-visualizations/ (V)
30. digital.gov. *Plain language guide*. https://digital.gov/guides/plain-language (resolves)
31. Google. *Material Design: Data visualization* (principles; dashboards). https://m2.material.io/design/communication/data-visualization.html (V)
32. Google. *Material Design 3: Content design overview*. https://m3.material.io/foundations/content-design/overview (V; thin)
33. Apple. *Human Interface Guidelines*: Onboarding; Charting data; Charts. https://developer.apple.com/design/human-interface-guidelines/onboarding ; https://developer.apple.com/design/human-interface-guidelines/charting-data ; https://developer.apple.com/design/human-interface-guidelines/charts (V)
34. Shneiderman, B. *The Eyes Have It: A Task by Data Type Taxonomy for Information Visualizations*. IEEE Visual Languages, 1996. https://www.cs.umd.edu/~ben/papers/Shneiderman1996eyes.pdf (V)
35. Few, S. *Common Pitfalls in Dashboard Design*. Perceptual Edge, 2006. https://www.perceptualedge.com/articles/Whitepapers/Common_Pitfalls.pdf (V)
36. Few, S. *Dashboard Confusion*. 2004. https://www.perceptualedge.com/articles/ie/dashboard_confusion.pdf (V)
37. Few, S. *The Chartjunk Debate*. 2011. https://www.perceptualedge.com/articles/visual_business_intelligence/the_chartjunk_debate.pdf (resolves)
38. Inbar, O., Tractinsky, N., Meyer, J. *Minimalism in information visualization: attitudes towards maximizing the data-ink ratio*. ECCE 2007. https://doi.org/10.1145/1362550.1362587 (R)
39. Bateman, S. et al. *Useful Junk? The Effects of Visual Embellishment on Comprehension and Memorability of Charts*. CHI 2010. https://sites.stat.columbia.edu/gelman/communication/Bateman2010.pdf (V)
40. Borkin, M. et al. *What Makes a Visualization Memorable?* IEEE TVCG, 2013. https://ieeexplore.ieee.org/document/6634103 (R)
41. Cleveland, W. S., McGill, R. *Graphical Perception: Theory, Experimentation, and Application to the Development of Graphical Methods*. JASA 79(387), 1984. https://doi.org/10.1080/01621459.1984.10478080 (R)
42. Heer, J., Bostock, M. *Crowdsourcing Graphical Perception*. CHI 2010. https://vis.stanford.edu/files/2010-MTurk-CHI.pdf (V)
43. Miller, G. A. *The Magical Number Seven, Plus or Minus Two*. Psychological Review 63, 1956. http://www.musanim.com/miller1956/ (V)
44. Cowan, N. *The magical number 4 in short-term memory*. Behavioral and Brain Sciences 24(1), 2001. https://doi.org/10.1017/S0140525X01003922 (V)
45. Segel, E., Heer, J. *Narrative Visualization: Telling Stories with Data*. IEEE TVCG, 2010. https://vis.stanford.edu/files/2010-Narrative-InfoVis.pdf (V)
46. Zhi, Q., Ottley, A., Metoyer, R. *Linking and Layout: Exploring the Integration of Text and Visualization in Storytelling*. Computer Graphics Forum (EuroVis), 2019. https://visualdata.wustl.edu/files/linking.pdf (V)
47. McKenna, S. et al. *Visual Narrative Flow*. Computer Graphics Forum (EuroVis), 2017. https://www.microsoft.com/en-us/research/wp-content/uploads/2017/08/VisualNarrativeFlow-EuroVis2017.pdf (V)
48. Esri. *Design symbology for a thematic map*. Learn ArcGIS. https://learn.arcgis.com/en/projects/design-symbology-for-a-thematic-map/arcgis-online/ (V)
49. CARTO. *5 cartographic tips for your Data Observatory maps*. 2016. https://carto.com/blog/cartography-data-extract-value (V)
50. NOAA National Weather Service. *Hazard Simplification*; *Impact-Based Decision Support Services*. https://www.weather.gov/hazardsimplification/ ; https://www.weather.gov/about/idss (V)
51. EC JRC / UN OCHA. *GDACS wildfire alert model*. https://www.gdacs.org/knowledge/models_wf.aspx (V)
52. NASA Earthdata. *FIRMS*. https://www.earthdata.nasa.gov/data/tools/firms ; https://firms.modaps.eosdis.nasa.gov/map/ (V)
53. CAL FIRE. *Current Emergency Incidents*. https://www.fire.ca.gov/incidents (V)
54. Copernicus EMS. *EFFIS Current Situation Viewer*. https://forest-fire.emergency.copernicus.eu/apps/effis_current_situation/ (V)
55. Endsley, M. R. *Toward a Theory of Situation Awareness in Dynamic Systems*. Human Factors 37(1), 1995. https://doi.org/10.1518/001872095779049543 (R)
56. Google web.dev. *Web Vitals*; *Browser-level image lazy loading*. https://web.dev/articles/vitals ; https://web.dev/articles/browser-level-image-lazy-loading (V)

**Gaps.** I found no verifiable ICA or Imhof source on generalisation and label density; P11 rests on Esri and CARTO
practice. NN/g has no written article on Hick's law, only a video. Alberto Cairo is not cited because nothing I found
added evidence beyond the sources above.
