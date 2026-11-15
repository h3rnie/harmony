"""Builds the deck served at /demo (web/public/demo) from the slide sources in this folder.

Run from the repository root after `pnpm install` in web/ (the fonts come from node_modules):

    python docs/deck/build.py

The slides refer to images by id (/_blob/<id>); the table below maps each id to its file in
web/public/demo/img/, which is the only copy of the images.
"""
import json, re, pathlib, shutil, sys
root = pathlib.Path(__file__).parent
web = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else root.parent.parent / 'web'
out = web / 'public' / 'demo'
(out / 'fonts').mkdir(parents=True, exist_ok=True)
blobs = {
 '6d0594b53af5af88f8343267f458687a': 'patch.png',
 'c2c746a9521313b3f1105f8874f921b4': 'product.gif',
 '066be50104773c30268d75cbea51a8ad': 'globe.gif',
 '7efae73eb1f08db802265ca502b00b5e': 'qr-site.png',
 '92b371739c1d536cee4c5db7f4630c1c': 'qr-repo.png',
}
order = json.loads((root / 'project/deck.json').read_text(encoding='utf-8'))['order']
used = set()
def sub(m):
    used.add(m.group(1)); return '/demo/img/' + blobs[m.group(1)]
slides = []
for n, sid in enumerate(order, 1):
    h = (root / f'project/slides/{sid}.html').read_text(encoding='utf-8').strip()
    h = re.sub(r'/_blob/([0-9a-f]{32})', sub, h)
    h = h.replace(f'<section id="{sid}"', f'<section id="{sid}" aria-label="Slide {n} of {len(order)}"', 1)
    h = h.replace(' data-transition="fade"', '')
    slides.append(h)
missing = [blobs[b] for b in used if not (out / 'img' / blobs[b]).is_file()]
if missing:
    sys.exit('missing in ' + str(out / 'img') + ': ' + ', '.join(missing))
fonts = {
 'barlow-500.woff2': '@fontsource/barlow/files/barlow-latin-500-normal.woff2',
 'barlow-600.woff2': '@fontsource/barlow/files/barlow-latin-600-normal.woff2',
 'schibsted-grotesk.woff2': '@fontsource-variable/schibsted-grotesk/files/schibsted-grotesk-latin-wght-normal.woff2',
 'jetbrains-mono.woff2': '@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-wght-normal.woff2',
}
for dst, src in fonts.items():
    shutil.copyfile(web / 'node_modules' / src, out / 'fonts' / dst)
shutil.copyfile(root / 'project/deck.css', out / 'deck.css')
html = f'''<!doctype html>
<html lang="en" data-theme="dark">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Harmony — pitch deck</title>
<meta name="description" content="Seven slides on Harmony: one consistent fire record from NASA's MODIS and VIIRS hot spots, 2000 to today. NASA Space Apps 2026, team Hernie.">
<meta name="author" content="Toh Yu Heng">
<meta name="theme-color" content="#0a0d12">
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<link rel="canonical" href="https://harmony.hernie.me/demo">
<meta property="og:title" content="Harmony — pitch deck">
<meta property="og:description" content="Two sensors. One fire record. Seven slides for NASA Space Apps 2026.">
<meta property="og:image" content="https://harmony.hernie.me/og.png">
<link rel="preload" href="/demo/fonts/schibsted-grotesk.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="/demo/demo.css">
<link rel="stylesheet" href="/demo/deck.css">
</head>
<body>
<main class="dv-viewport" id="viewport" aria-roledescription="slide deck" aria-label="Harmony pitch deck">
<div class="dv-stage" id="stage">
{chr(10).join(slides)}
</div>
</main>
<div class="dv-notes" id="notes" hidden><p id="notes-text"></p></div>
<nav class="dv-bar" aria-label="Slide controls">
<a class="dv-home" href="/">Open the live app</a>
<div class="dv-steps">
<button id="prev" type="button" aria-label="Previous slide">←</button>
<p id="count" aria-live="polite">1 / {len(order)}</p>
<button id="next" type="button" aria-label="Next slide">→</button>
</div>
<div class="dv-tools">
<button id="notes-btn" type="button" aria-pressed="false" aria-controls="notes">Notes</button>
<button id="full-btn" type="button">Full screen</button>
</div>
</nav>
<script src="/demo/demo.js"></script>
</body>
</html>
'''
(out / 'index.html').write_text(html, encoding='utf-8', newline='\n')
print('slides', len(slides), 'images', sorted(blobs[b] for b in used))
