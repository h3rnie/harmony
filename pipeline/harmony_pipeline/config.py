"""Shared paths, grid constants and method parameters. Single source of truth for the pipeline."""
from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "data"
RAW = DATA / "raw"            # downloaded FIRMS files (zips, API pulls)
WORK = DATA / "work"          # intermediate Parquet
DIST = DATA / "dist"          # what the web app serves

FIRMS_COUNTRY_BASE = "https://firms.modaps.eosdis.nasa.gov/data/country"
FIRMS_INDEX_URL = f"{FIRMS_COUNTRY_BASE}/yearly_summary_files.txt"
# prefix in FIRMS file names -> sensor family
BULK_PREFIXES = {"modis": "MODIS", "viirs-snpp": "VIIRS", "viirs-jpss1": "VIIRS"}

# ---- grid -------------------------------------------------------------------------------
L0_DEG = 0.05                 # serving cell (aligned with the MODIS CMG grid)
SUB = 4                       # 4x4 sub-cells of 0.0125 deg define an active-fire cell-day
L0_NX, L0_NY = 7200, 3600
LEVELS = {                    # level -> (cell size deg, tile size deg)
    0: (0.05, 2.5),
    1: (0.25, 10.0),
    2: (1.0, 360.0),
}
MONTH0_YEAR = 2000            # month index m = (year - 2000) * 12 + (month - 1)

# ---- method -----------------------------------------------------------------------------
MODIS_MIN_CONFIDENCE = 30
VIIRS_OK_CONFIDENCE = ("n", "h")
FIT_START, FIT_END = (2012, 2), (2021, 12)        # VIIRS -> MODIS calibration window
BRIDGE_START, BRIDGE_END = (2003, 1), (2011, 12)  # Terra-only -> Terra+Aqua bridge window
AQUA_START = (2002, 7)                            # first month Aqua is used
DEFAULT_SWITCH = (2023, 1)                        # first month served from calibrated VIIRS


def month_index(year: int, month: int) -> int:
    return (year - MONTH0_YEAR) * 12 + (month - 1)
