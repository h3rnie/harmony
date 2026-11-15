"""Fetch recent FIRMS data from the area API (world, <= 5-day windows) — 2026 for MODIS, S-NPP
(ends 2026-11-02) and NOAA-20 (after the bulk country files end), and NOAA-21 from 2023-03-01.

- Key: FIRMS_MAP_KEY from <repo>/.env.local, else <repo>/.env, else the environment. The key is
  never printed; error messages are redacted.
- Source per calendar month: the SP (standard) source if the availability endpoint says SP covers
  the whole month, else NRT. Whole months keep normalize's "SP supersedes NRT per (satellite, month)"
  rule lossless; when SP later covers a month, re-running fetches it and normalize drops that NRT month.
- Files: data/raw/api/{SOURCE}/{start}_{days}.csv (one per window; --bbox writes to
  data/raw/api_bbox/{w_s_e_n}/{SOURCE}/ instead, which normalize does not read). Resumable: existing
  valid files are skipped, except windows touching the last 3 days of a source's availability (NRT
  still filling) which are re-fetched. Each body is validated: an HTTP 200 can carry an error text, so
  the header must start with 'latitude,'; a header-only body is a valid empty window.
- Rate limit (5000 transactions / 10 min; large requests cost more): before each request the key's
  status endpoint is checked and the run sleeps while usage > 80 % of the limit; failed or throttled
  requests back off exponentially (30 s .. 10 min).
Usage: uv run python -m harmony_pipeline.cli fetch-api [--sensors viirs-noaa21 ...] [--from D] [--to D]
       [--limit N] [--bbox w,s,e,n] [--dry-run]
"""
from __future__ import annotations

import argparse
import calendar
import csv
import io
import json
import os
import subprocess
import time
from datetime import date, timedelta

from .config import API_DIR, API_SOURCES, OPERATING, ROOT, SENSORS

BASE = "https://firms.modaps.eosdis.nasa.gov"
WINDOW = 5
START = {s: date(SENSORS[s][3] + 1, 1, 1) if SENSORS[s][3] else date.fromisoformat(OPERATING["NOAA21"][0])
         for s in SENSORS}
END = {"viirs-snpp": date.fromisoformat(OPERATING["SNPP"][1])}


def map_key() -> str:
    for env in (ROOT / ".env.local", ROOT / ".env"):
        if env.exists():
            for line in env.read_text().splitlines():
                if line.strip().startswith("FIRMS_MAP_KEY="):
                    key = line.split("=", 1)[1].strip().strip('"').strip("'")
                    if key:
                        return key
    return os.environ.get("FIRMS_MAP_KEY", "")


class Fetcher:
    def __init__(self, key: str):
        self.key = key

    def redact(self, text: str) -> str:
        return text.replace(self.key, "***") if self.key else text

    def get(self, url: str, timeout: int = 300) -> bytes:
        """GET via curl (system TLS store). Raises RuntimeError with a redacted message."""
        r = subprocess.run(["curl", "-sS", "-f", "-L", "--max-time", str(timeout), url], capture_output=True)
        if r.returncode != 0:
            raise RuntimeError(self.redact(f"curl exit {r.returncode}: {r.stderr.decode(errors='replace')[:300]}"))
        return r.stdout

    def wait_for_quota(self) -> None:
        """Sleep while the key has used > 80 % of its 10-minute transaction allowance."""
        for _ in range(60):
            try:
                st = json.loads(self.get(f"{BASE}/mapserver/mapkey_status/?MAP_KEY={self.key}", 60))
                used, limit = int(st.get("current_transactions", 0)), int(st.get("transaction_limit", 5000))
            except Exception as e:      # status endpoint unavailable: fall back to a fixed pause
                print(f"  quota check failed ({self.redact(str(e))[:120]}); pausing 10 s", flush=True)
                time.sleep(10)
                return
            if used <= 0.8 * limit:
                return
            print(f"  quota {used}/{limit}; waiting 60 s", flush=True)
            time.sleep(60)

    def availability(self) -> dict[str, tuple[date, date]]:
        text = self.get(f"{BASE}/api/data_availability/csv/{self.key}/ALL", 120).decode()
        out = {}
        for r in csv.DictReader(io.StringIO(text)):
            try:
                out[r["data_id"]] = (date.fromisoformat(r["min_date"]), date.fromisoformat(r["max_date"]))
            except (KeyError, ValueError):
                continue
        if not out:
            raise RuntimeError("availability endpoint returned no rows (invalid key?)")
        API_DIR.mkdir(parents=True, exist_ok=True)
        (API_DIR / "data_availability.csv").write_text(text)
        return out

    def area(self, source: str, start: date, days: int, area: str = "world") -> bytes:
        url = f"{BASE}/api/area/csv/{self.key}/{source}/{area}/{days}/{start.isoformat()}"
        delay = 30
        for attempt in range(8):
            self.wait_for_quota()
            try:
                body = self.get(url)
                if body.lstrip().lower().startswith(b"latitude,"):
                    return body
                msg = body[:200].decode(errors="replace")
                raise RuntimeError(f"unexpected response: {msg}")
            except RuntimeError as e:
                print(f"  {source} {start} attempt {attempt + 1} failed: {self.redact(str(e))[:200]}; "
                      f"retry in {delay}s", flush=True)
                time.sleep(delay)
                delay = min(delay * 2, 600)
        raise RuntimeError(f"giving up on {source} {start}")


def plan(sensor: str, avail: dict[str, tuple[date, date]] | None, today: date) -> list[tuple[str, date, int, bool]]:
    """(source, start, days, still_filling) windows; SP for months it fully covers, else NRT."""
    sp, nrt = API_SOURCES[sensor]
    first, last = START[sensor], min(END.get(sensor, today), today)
    if avail:
        ends = [avail[s][1] for s in (sp, nrt) if s in avail]
        last = min(last, max(ends)) if ends else first - timedelta(days=1)
    out = []
    d = date(first.year, first.month, 1)
    while d <= last:
        m_end = date(d.year, d.month, calendar.monthrange(d.year, d.month)[1])
        lo, hi = max(d, first), min(m_end, last)
        sp_ok = avail and sp in avail and avail[sp][0] <= lo and avail[sp][1] >= m_end
        src = sp if sp_ok else nrt
        src_end = avail[src][1] if avail and src in avail else last
        w = lo
        while w <= hi:
            n = min(WINDOW, (hi - w).days + 1)
            out.append((src, w, n, w + timedelta(days=n - 1) >= src_end - timedelta(days=3)))
            w += timedelta(days=n)
        d = m_end + timedelta(days=1)
    return out


def valid_csv(path) -> bool:
    with path.open("rb") as fh:
        return fh.read(9).lower() == b"latitude,"


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="fetch-api")
    ap.add_argument("--sensors", nargs="+", default=list(SENSORS), choices=list(SENSORS))
    ap.add_argument("--from", dest="d0", type=date.fromisoformat, help="only windows starting on/after this date")
    ap.add_argument("--to", dest="d1", type=date.fromisoformat, help="only windows starting on/before this date")
    ap.add_argument("--limit", type=int, help="fetch at most N windows (testing)")
    ap.add_argument("--bbox", help="w,s,e,n instead of world (written to data/raw/api_bbox/, not normalized)")
    ap.add_argument("--dry-run", action="store_true", help="print the plan without downloading")
    args = ap.parse_args(argv)
    area, root = "world", API_DIR
    if args.bbox:
        w, s_, e, n = (float(x) for x in args.bbox.split(","))
        area = f"{w:g},{s_:g},{e:g},{n:g}"
        root = API_DIR.parent / "api_bbox" / area.replace(",", "_")
    key = map_key()
    if not key and not args.dry_run:
        print("FIRMS_MAP_KEY not set (add it to .env); nothing fetched")
        return 1
    f = Fetcher(key)
    today = date.today()
    avail = f.availability() if key else None
    done = failed = 0
    for sensor in args.sensors:
        windows = plan(sensor, avail, today)
        print(f"{sensor}: {len(windows)} windows "
              f"({sum(1 for w in windows if w[0].endswith('SP'))} SP / {sum(1 for w in windows if w[0].endswith('NRT'))} NRT)",
              flush=True)
        for src, start, days, filling in windows:
            if (args.d0 and start < args.d0) or (args.d1 and start > args.d1):
                continue
            if args.limit is not None and done + failed >= args.limit:
                break
            dest = root / src / f"{start.isoformat()}_{days}.csv"
            if dest.exists() and valid_csv(dest) and not filling:
                continue
            if args.dry_run:
                print(f"  would fetch {dest.relative_to(root)}{' (still filling)' if filling else ''}")
                continue
            dest.parent.mkdir(parents=True, exist_ok=True)
            try:
                body = f.area(src, start, days, area)
            except RuntimeError as e:
                print(f"  FAILED {dest.name}: {f.redact(str(e))}", flush=True)
                failed += 1
                continue
            tmp = dest.with_suffix(".part")
            tmp.write_bytes(body)
            tmp.replace(dest)
            done += 1
            print(f"  {src} {dest.stem}: {body.count(b'\n') - 1} rows", flush=True)
    print(f"fetched {done} windows, {failed} failed")
    return 1 if failed else 0
