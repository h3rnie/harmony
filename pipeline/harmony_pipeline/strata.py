"""Calibration strata: RESOLVE Ecoregions 2017 biome x realm for every fire-active L0 cell.

- Only L0 cells present in the cube are labelled (point-in-polygon of the cell centre).
- Speed: multipolygons are split into parts (ST_Dump) and clipped to the 1-degree boxes that
  contain fire-active cells; each cell centre is then tested only against the small pieces of
  its own box (equi-join on the box id). ~10x faster than a direct point-in-polygon join
  against the 14M-vertex ecoregion layer, same result.
- Cells whose centre falls outside every ecoregion (coasts, lakes, the 'N/A' rock & ice polygon)
  take the stratum of the nearest ecoregion polygon within 0.25 deg, else 'Unclassified'.
- The MCD12C1 cropland flag from the design is not implemented (time-box); strata are biome x realm.
Outputs: data/work/strata.parquet (id, biome, realm, realm_name, biome_name, name),
         data/work/strata_cells.parquet (l0, stratum).
"""
from __future__ import annotations

import subprocess
import zipfile

from .afcd import OUT as CUBE
from .common import connect, fresh, posix, timed
from .config import L0_DEG, L0_NX, RAW, WORK

URL = "https://storage.googleapis.com/teow2016/Ecoregions2017.zip"
ZIP = RAW / "resolve" / "Ecoregions2017.zip"
SHP = RAW / "resolve" / "shp" / "Ecoregions2017.shp"
OUT_STRATA = WORK / "strata.parquet"
OUT_CELLS = WORK / "strata_cells.parquet"
NEAREST_DEG = 0.25
REALM_CODE = {"Afrotropic": "AT", "Antarctica": "AN", "Australasia": "AA", "Indomalayan": "IM",
              "Nearctic": "NA", "Neotropic": "NT", "Oceania": "OC", "Palearctic": "PA"}


def ensure_shapefile() -> None:
    if SHP.exists():
        return
    ZIP.parent.mkdir(parents=True, exist_ok=True)
    if not ZIP.exists():
        subprocess.run(["curl", "-sSfL", "--retry", "5", "-o", str(ZIP), URL], check=True)
    with zipfile.ZipFile(ZIP) as z:
        z.extractall(SHP.parent)


def main(force: bool = False) -> None:
    if not force and fresh(OUT_CELLS, [CUBE]) and fresh(OUT_STRATA, [CUBE]):
        print("[strata] up to date")
        return
    ensure_shapefile()
    con = connect()
    con.execute("LOAD spatial")
    with timed("strata"):
        con.execute(f"""CREATE TEMP TABLE eco AS
            SELECT CAST(BIOME_NUM AS INTEGER) AS biome, BIOME_NAME AS biome_name, REALM AS realm_name,
                   unnest(ST_Dump(geom), recursive := true)
            FROM ST_Read('{posix(SHP)}') WHERE BIOME_NAME <> 'N/A'""")
        con.execute(f"""CREATE TEMP TABLE pts AS
            SELECT l0, (l0 // {L0_NX} // 20) * 360 + (l0 % {L0_NX}) // 20 AS c1,
                   ST_Point(((l0 % {L0_NX}) + 0.5) * {L0_DEG} - 180, ((l0 // {L0_NX}) + 0.5) * {L0_DEG} - 90) AS pt
            FROM (SELECT DISTINCT l0::BIGINT AS l0 FROM '{posix(CUBE)}')""")
        con.execute("""CREATE TEMP TABLE box AS SELECT c1,
                         ST_MakeEnvelope(c1 % 360 - 180, c1 // 360 - 90, c1 % 360 - 179, c1 // 360 - 89) AS g
                       FROM (SELECT DISTINCT c1 FROM pts)""")
        con.execute("""CREATE TEMP TABLE piece AS
            SELECT box.c1, eco.biome, eco.realm_name, ST_Intersection(eco.geom, box.g) AS geom
            FROM eco JOIN box ON ST_Intersects(eco.geom, box.g)""")
        con.execute("""CREATE TEMP TABLE hit AS
            SELECT l0, min(biome) AS biome, arg_min(realm_name, biome) AS realm_name
            FROM pts JOIN piece ON piece.c1 = pts.c1 AND ST_Intersects(piece.geom, pts.pt) GROUP BY l0""")
        con.execute(f"""CREATE TEMP TABLE near AS
            WITH miss AS (SELECT * FROM pts WHERE l0 NOT IN (SELECT l0 FROM hit)),
            c AS (SELECT l0, biome, realm_name, ST_Distance(eco.geom, miss.pt) AS d
                  FROM miss JOIN eco ON ST_DWithin(eco.geom, miss.pt, {NEAREST_DEG}))
            SELECT l0, arg_min(biome, d) AS biome, arg_min(realm_name, d) AS realm_name FROM c GROUP BY l0""")
        con.execute("""CREATE TEMP TABLE lab AS
            SELECT p.l0, coalesce(h.biome, n.biome, 0) AS biome,
                   coalesce(h.realm_name, n.realm_name, '') AS realm_name,
                   CASE WHEN h.l0 IS NOT NULL THEN 'inside' WHEN n.l0 IS NOT NULL THEN 'nearest'
                        ELSE 'unclassified' END AS how
            FROM pts p LEFT JOIN hit h USING (l0) LEFT JOIN near n USING (l0)""")
        names = dict(con.execute("SELECT DISTINCT biome, biome_name FROM eco").fetchall())
        combos = con.execute("SELECT DISTINCT biome, realm_name FROM lab ORDER BY biome = 0, biome, realm_name"
                             ).fetchall()
        rows = []
        for i, (b, r) in enumerate(combos):
            bn = names.get(b, "Unclassified")
            rows.append((i, b, REALM_CODE.get(r, ""), r, bn, f"{bn} · {r}" if b else "Unclassified"))
        con.execute("CREATE TEMP TABLE st(id USMALLINT, biome UTINYINT, realm VARCHAR, realm_name VARCHAR, "
                    "biome_name VARCHAR, name VARCHAR)")
        con.executemany("INSERT INTO st VALUES (?, ?, ?, ?, ?, ?)", rows)
        con.execute(f"COPY st TO '{posix(OUT_STRATA)}' (FORMAT parquet)")
        con.execute(f"""COPY (SELECT l0::UINTEGER AS l0, st.id AS stratum, how FROM lab
                              JOIN st ON st.biome = lab.biome AND st.realm_name = lab.realm_name ORDER BY l0)
                        TO '{posix(OUT_CELLS)}' (FORMAT parquet)""")
        print(con.execute("SELECT how, count(*) FROM lab GROUP BY 1").df().to_string(index=False))
        print(con.execute(f"""SELECT st.id, st.name, count(*) cells FROM '{posix(OUT_CELLS)}' c
                              JOIN st ON st.id = c.stratum GROUP BY ALL ORDER BY 1""").df().to_string(index=False))
