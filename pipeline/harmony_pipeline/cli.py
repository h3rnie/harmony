"""Harmony pipeline command line.

  uv run python -m harmony_pipeline.cli all [--countries Argentina Bolivia ...] [--force]
  uv run python -m harmony_pipeline.cli <stage> [--force]

Stages run in order: normalize, availability, static_mask, afcd, strata, calibrate, tiles, points,
overview, verify. `--countries` selects a regional run (normalize only; later stages follow the run
manifest data/work/run.json). Without it the run is global. Each stage skips work whose outputs are
newer than its inputs unless --force. fetch-country / fetch-api download raw data (not part of all).
"""
from __future__ import annotations

import argparse
import importlib
import sys
import time

STAGES = ["normalize", "availability", "static_mask", "afcd", "strata", "calibrate",
          "build_tiles", "build_points", "overview", "verify"]
ALIASES = {"tiles": "build_tiles", "points": "build_points", "static-mask": "static_mask",
           "mask": "static_mask", "cube": "afcd"}


def run_stage(name: str, args) -> float:
    mod = importlib.import_module(f"harmony_pipeline.{name}")
    t0 = time.time()
    if name == "normalize":
        mod.main(countries=args.countries, force=args.force, sensors=args.sensors, years=args.years)
    else:
        mod.main(force=args.force)
    return time.time() - t0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("stage", help="all | " + " | ".join(STAGES) + " | fetch-country | fetch-api")
    ap.add_argument("--countries", nargs="+", help="regional run: FIRMS country names (e.g. Argentina)")
    ap.add_argument("--sensors", nargs="+", help="normalize only: subset of sensors")
    ap.add_argument("--years", nargs="+", type=int, help="normalize only: subset of years")
    ap.add_argument("--from", dest="start", help="all: start at this stage")
    ap.add_argument("--force", action="store_true", help="recompute even if outputs are up to date")
    argv = sys.argv[1:] if argv is None else argv
    if argv and argv[0] in ("fetch-country", "fetch-api"):   # pass their own options through untouched
        if argv[0] == "fetch-country":
            from . import fetch_country
            sys.argv = [sys.argv[0], *argv[1:]]
            return fetch_country.main()
        from . import fetch_api
        return fetch_api.main(argv[1:])
    args = ap.parse_args(argv)
    stage = ALIASES.get(args.stage, args.stage)
    if stage == "all":
        todo = STAGES[STAGES.index(ALIASES.get(args.start, args.start)):] if args.start else STAGES
    elif stage in STAGES:
        todo = [stage]
    else:
        ap.error(f"unknown stage {args.stage}")
    timings = {}
    for s in todo:
        timings[s] = run_stage(s, args)
    print("stage timings (s): " + ", ".join(f"{k}={v:.0f}" for k, v in timings.items()))
    return 0


if __name__ == "__main__":
    sys.exit(main())
