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
# A month drives statistics (current month, ranks, baselines, YTD, analogs, outlook origin, records, annual
# completeness, seam, trend, watchlist target and baselines) only when the stream(s) serving it delivered data
# on >= this fraction of its days; below it the month is "in progress" (or an outage month): drawn and flagged
# partial, never ranked. Written to meta.json as `complete_min_coverage` and read from there by the kernel,
# the web app, overview.py and watch.py, so there is one value.
COV_COMPLETE = 0.9
K_MIN_SUM = 200                # min sum of the numerator stream to accept a ratio at a level
NOAA_MAX_MONTH_SHARE = 0.5     # NOAA-20/21 -> S-NPP: max share of either sum from one month at an accepted level
NOAA_RANGE = (0.5, 2.0)        # NOAA-20/21 -> S-NPP: plausible range of a stratum / biome factor (same VIIRS design)
TAU_GRID = (5.0, 10.0, 20.0, 50.0, float("inf"))
LOYO_YEARS = tuple(range(2012, 2022))
CLIM_BASELINE = (2003, 2022)   # overview climatology years


def ym_index(ym: tuple[int, int]) -> int:
    return month_index(*ym)

# ---- harmonization science core (harmonize.py) -----------------------------------------------
TC_WINDOW = ((2012, 2), (2019, 12))   # pre-drift overlap: triple collocation, drift reference ratios
DRIFT_REF_YEARS = (2012, 2019)        # reference years for the satellite-specific drift ratios
DRIFT_START_YEAR = 2020               # first year the kernel corrects MODIS for drift
DRIFT_ATTR_FRAC = 0.5                 # |log factor| x this is added (as 1 sd) for drift-vs-real-change attribution
DRIFT_MIN_EXP = 2000.0                # min expected AFCD in a biome x dn x year for a biome-specific factor
JACK_GROUPS = 40                      # delete-a-group jackknife over 5-degree blocks
VIIRS_ERAS = {1: ((2012, 2), (2017, 12)),   # number of VIIRS satellites -> TC window for the VIIRS stream
              2: ((2018, 1), (2019, 12)),
              3: ((2023, 3), (2025, 12))}
TC_MIN_DOF_CELL = 500                 # min residual degrees of freedom for a 1-degree TC estimate at a level
TC_MIN_DOF_STRATUM = 48               # same for stratum-month TC
CONF_SIZE_EDGES = (5.0, 20.0, 100.0, 1000.0)   # activity-size classes of the predicted value (AFCD-M)
CONF_MIN_N = 500                      # min scores per Mondrian bin (biome group x size class) before merging
CONF_Q_MAX = 8.0                      # cap of a conformal multiplier (a bin with >5 % unreachable scores)
OOT_TEST_YEARS = (2022, 2024)         # out-of-time conformal coverage test
# biome groups for conformal bins and summaries (RESOLVE biome numbers; 0 = unclassified)
BIOME_GROUPS = (
    ("Tropical forests", (1, 2, 3)),
    ("Temperate forests", (4, 5)),
    ("Boreal forest and tundra", (6, 11)),
    ("Tropical savannas and grasslands", (7,)),
    ("Temperate grasslands", (8,)),
    ("Flooded and montane grasslands", (9, 10)),
    ("Mediterranean", (12,)),
    ("Deserts and xeric shrublands", (13,)),
    ("Mangroves and unclassified", (14, 0, 98, 99)),
)
