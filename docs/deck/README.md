# Pitch deck

The seven slides shown at <https://harmony.hernie.me/demo>.

| Path | What it is |
|---|---|
| `project/deck.json` | Slide order and sections. |
| `project/deck.css` | Styles shared by every slide (1920 x 1080 canvas). |
| `project/slides/*.html` | One file per slide; the `<aside>` in each holds the speaker notes. |
| `build.py` | Writes `web/public/demo/index.html` and copies `deck.css` and the fonts. |

Images are kept once, in `web/public/demo/img/`. The viewer (`demo.css`, `demo.js`) is in `web/public/demo/`.

To rebuild after editing a slide, from the repository root:

```
python docs/deck/build.py
```

The two animated captures (`product.gif`, `globe.gif`) were assembled from screenshots of the live app; the frames and the two scripts that build the GIFs are kept outside git, in `data/work/deck/` on the build machine. Printing `/demo` from Chrome gives a seven-page 16:9 PDF.

Every figure on the slides is read from `data/dist/validation.json`; the tables are in [METHOD.md](../METHOD.md).

The deck is not covered by the code licence: (c) 2026 Harmony, by Toh Yu Heng. All rights reserved.
