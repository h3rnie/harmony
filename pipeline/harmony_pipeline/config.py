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
    2: (1.0, 30.0),
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


# ---- pipeline layout ----------------------------------------------------------------------
ZIP_DIR = RAW / "country_zips"
COUNTRY_CSV_DIR = RAW / "country_csv"   # per-country CSVs fetched individually (regional runs)
API_DIR = RAW / "api"
POINTS_DIR = WORK / "points"
TMP_DIR = WORK / "tmp"
RUN_JSON = WORK / "run.json"            # {"countries": [...] | null} written by normalize

# sensor key (dir under work/points) -> FIRMS bulk prefix, instrument, first/last bulk year
SENSORS = {
    "modis": ("modis", "MODIS", 2000, 2025),
    "viirs-snpp": ("viirs-snpp", "VIIRS", 2012, 2025),
    "viirs-noaa20": ("viirs-jpss1", "VIIRS", 2018, 2025),
    "viirs-noaa21": (None, "VIIRS", None, None),      # API only (SP from 2023-03-01)
}
# FIRMS area-API sources -> sensor key; SP listed first (preferred when available)
API_SOURCES = {
    "modis": ("MODIS_SP", "MODIS_NRT"),
    "viirs-snpp": ("VIIRS_SNPP_SP", "VIIRS_SNPP_NRT"),
    "viirs-noaa20": ("VIIRS_NOAA20_SP", "VIIRS_NOAA20_NRT"),
    "viirs-noaa21": ("VIIRS_NOAA21_SP", "VIIRS_NOAA21_NRT"),
}
SATELLITES = ("Terra", "Aqua", "SNPP", "NOAA20", "NOAA21")
VIIRS_SATS = ("SNPP", "NOAA20", "NOAA21")
VIIRS_BIT = {"SNPP": 1, "NOAA20": 2, "NOAA21": 4}

# Nominal operating periods in FIRMS (end None = still operating at data_through).
OPERATING = {
    "Terra": ("2000-11-01", None),
    "Aqua": ("2002-07-04", None),
    "SNPP": ("2012-01-20", "2026-11-02"),
    "NOAA20": ("2018-01-01", None),
    "NOAA21": ("2023-03-01", None),
}
# Known multi-day instrument outages (inclusive, approximate). Used ONLY for regional runs, where
# regional daily counts cannot separate "no fire" from "no data"; the global run detects outages
# from counts. Sources: MODIS/VIIRS operational histories (Terra power-supply anomaly 2001,
# Terra safe-hold 2016, S-NPP safe mode 2022).
KNOWN_OUTAGES = {
    "Terra": [("2001-06-15", "2001-07-02"), ("2016-02-19", "2016-02-27")],
    "Aqua": [],
    "SNPP": [("2022-07-26", "2022-08-09")],
    "NOAA20": [],
    "NOAA21": [],
}

# ---- method thresholds --------------------------------------------------------------------
AVAIL_FRACTION = 0.05          # day available if count > 5 % of centred 31-day median
AVAIL_WINDOW = 31
SUB_DEG = L0_DEG / SUB         # 0.0125 deg
SUB_NX = L0_NX * SUB           # 28800
MASK_TYPED_MIN = 5             # >= 5 type 1/2/3 detections in a sub-cell -> static
MASK_TYPED_SHARE_N = 3         # or > 50 % of typed detections when >= 3 are typed
MASK_PERSIST_MONTHS = 10       # or accepted VIIRS detections in >= 10 months of a year ...
MASK_PERSIST_YEARS = 3         # ... in >= 3 years
COV_MIN = 0.5                  # below this month coverage is left uncorrected (flagged via cov)
COV_MAX_CORR = 2.0             # cap of the 1/cov correction
K_MIN_SUM = 200                # min sum of the numerator stream to accept a ratio at a level
TAU_GRID = (5.0, 10.0, 20.0, 50.0, float("inf"))
LOYO_YEARS = tuple(range(2012, 2022))
CLIM_BASELINE = (2003, 2022)   # overview climatology years


def ym_index(ym: tuple[int, int]) -> int:
    return month_index(*ym)
