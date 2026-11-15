"""Download the official FIRMS country-year bulk zips (standard-quality MODIS / VIIRS).

Uses curl (system TLS store, resumable). Verifies each file against the size in the FIRMS index.
Usage: uv run python -m harmony_pipeline.fetch_country [--prefix modis viirs-snpp viirs-jpss1]
"""
from __future__ import annotations

import argparse
import csv
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor

from .config import BULK_PREFIXES, FIRMS_COUNTRY_BASE, FIRMS_INDEX_URL, RAW

ZIP_DIR = RAW / "country_zips"


def curl(url: str, dest, resume: bool = True) -> None:
    cmd = ["curl", "-sSfL", "--retry", "5", "--retry-delay", "5", "-o", str(dest), url]
    if resume:
        cmd[1:1] = ["-C", "-"]
    subprocess.run(cmd, check=True)


def load_index() -> list[tuple[str, int]]:
    RAW.mkdir(parents=True, exist_ok=True)
    idx = RAW / "yearly_summary_files.txt"
    curl(FIRMS_INDEX_URL, idx, resume=False)
    with idx.open(newline="") as fh:
        rows = list(csv.DictReader(fh))
    return [(r["filename"], int(r["size"])) for r in rows if r["filename"].endswith("_all_countries.zip")]


def fetch_one(item: tuple[str, int]) -> str:
    name, size = item
    dest = ZIP_DIR / name
    if dest.exists() and dest.stat().st_size == size:
        return f"ok      {name}"
    curl(f"{FIRMS_COUNTRY_BASE}/zips/{name}", dest)
    got = dest.stat().st_size
    if got != size:
        return f"SIZE MISMATCH {name}: got {got}, index says {size}"
    return f"fetched {name} ({size / 1e6:.0f} MB)"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--prefix", nargs="*", default=list(BULK_PREFIXES))
    ap.add_argument("--jobs", type=int, default=3)
    args = ap.parse_args()
    ZIP_DIR.mkdir(parents=True, exist_ok=True)
    todo = [it for it in load_index() if it[0].split("_")[0] in args.prefix]
    todo.sort(key=lambda it: it[1])  # small files first so early stages can start
    print(f"{len(todo)} zips, {sum(s for _, s in todo) / 1e9:.2f} GB", flush=True)
    bad = 0
    with ThreadPoolExecutor(args.jobs) as pool:
        for msg in pool.map(fetch_one, todo):
            print(msg, flush=True)
            bad += msg.startswith("SIZE")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
