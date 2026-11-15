//! AOI geometry: polygon cleaning, spherical area, centroid and per-cell coverage weights.
//!
//! Edges are straight lines in lon/lat (plate carrée), the same space the tile grid lives in,
//! and inside/outside uses the even–odd rule, so ring winding does not matter.

use std::collections::BTreeSet;

use serde::Serialize;

use crate::{meta::LevelMeta, Error};

/// Mean Earth radius (IUGG), km.
const EARTH_RADIUS_KM: f64 = 6371.0088;
/// Sub-scanlines per cell row for coverage; the horizontal overlap on each is exact, so the
/// per-cell error is at most 1/(2·SUB_ROWS), reached only along horizontal edges.
const SUB_ROWS: usize = 16;
/// Refuse to rasterise more bounding-box cells than this at one level (keeps the wasm heap
/// bounded; the UI picks coarser levels for large areas).
const MAX_BBOX_CELLS: u64 = 12_000_000;
const ANTIMERIDIAN: &str =
    "areas crossing the antimeridian are not supported yet; split the polygon at 180°";

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AoiInfo {
    pub area_km2: f64,
    /// west, south, east, north
    pub bbox: [f64; 4],
    /// lon, lat
    pub centroid: [f64; 2],
}

type Ring = Vec<[f64; 2]>;

/// A cleaned polygon (first ring outer, later rings holes) with its summary.
#[derive(Debug, Clone)]
pub struct Aoi {
    rings: Vec<Ring>,
    info: AoiInfo,
}

/// Cells of one level with a positive AOI coverage fraction, sorted by cell id.
#[derive(Debug, Clone, Default)]
pub struct CellWeights {
    pub level: u8,
    pub cells: Vec<u32>,
    pub weights: Vec<f32>,
}

impl Aoi {
    /// Builds an AOI from interleaved lon/lat pairs. `ring_offsets` holds the first vertex index
    /// of every ring (GeoArrow style; a trailing offset equal to the vertex count is accepted).
    pub fn from_flat(coords: &[f64], ring_offsets: &[u32]) -> Result<Self, Error> {
        if !coords.len().is_multiple_of(2) {
            return Err(Error::new("coordinates must be lon/lat pairs"));
        }
        let n = coords.len() / 2;
        let mut starts: Vec<usize> = ring_offsets.iter().map(|&o| o as usize).collect();
        if starts.is_empty() {
            starts.push(0);
        }
        if starts.len() > 1 && starts.last() == Some(&n) {
            starts.pop();
        }
        if starts[0] != 0 || starts.windows(2).any(|w| w[0] > w[1]) || starts.iter().any(|&s| s > n) {
            return Err(Error::new("ring offsets must start at 0, increase, and stay within the vertex count"));
        }
        let rings = starts
            .iter()
            .enumerate()
            .map(|(k, &s)| {
                let e = starts.get(k + 1).copied().unwrap_or(n);
                (s..e).map(|i| [coords[2 * i], coords[2 * i + 1]]).collect()
            })
            .collect();
        Self::from_rings(rings)
    }

    /// Cleans the rings (drops repeated and closing vertices, degenerate holes), normalises
    /// longitudes, and rejects unusable input with a readable error.
    pub fn from_rings(rings: Vec<Ring>) -> Result<Self, Error> {
        let mut cleaned = Vec::with_capacity(rings.len());
        for (k, ring) in rings.into_iter().enumerate() {
            let ring = clean_ring(ring)?;
            let usable = ring.len() >= 3 && planar_moments(&ring).0.abs() > 1e-14;
            if usable {
                cleaned.push(ring);
            } else if k == 0 {
                return Err(Error::new("the area needs at least 3 distinct points enclosing a non-zero area"));
            }
        }
        if cleaned.is_empty() {
            return Err(Error::new("the area has no rings"));
        }
        normalize_longitudes(&mut cleaned)?;
        let info = describe(&cleaned);
        if info.area_km2.is_nan() || info.area_km2 <= 0.0 {
            return Err(Error::new("the area has zero size (its holes cover it)"));
        }
        Ok(Aoi { rings: cleaned, info })
    }

    pub fn info(&self) -> &AoiInfo {
        &self.info
    }

    /// Even–odd point-in-polygon test over all rings.
    pub fn contains(&self, lon: f64, lat: f64) -> bool {
        let mut inside = false;
        for ring in &self.rings {
            for (a, b) in edges(ring) {
                if (a[1] > lat) != (b[1] > lat) && lon < a[0] + (lat - a[1]) * (b[0] - a[0]) / (b[1] - a[1]) {
                    inside = !inside;
                }
            }
        }
        inside
    }

    /// Fraction of each cell's area inside the AOI at `level`.
    ///
    /// Scanline rasterisation in grid units: every cell row is cut by 16 horizontal sub-lines and
    /// the inside spans on each are clipped exactly to the cells, so interior cells get exactly 1
    /// and boundary cells are exact horizontally and 16-fold supersampled vertically. Cost is
    /// O(edge crossings + covered cells), so country-sized polygons at 0.05° take milliseconds.
    pub fn weights(&self, level: &LevelMeta) -> Result<CellWeights, Error> {
        let c = level.cell_deg;
        let (nx, ny) = (level.nx as i64, level.ny as i64);
        let [w, s, e, n] = self.info.bbox;
        let ix0 = (((w + 180.0) / c).floor() as i64).clamp(0, nx - 1);
        let ix1 = (((e + 180.0) / c).ceil() as i64).clamp(ix0 + 1, nx);
        let iy0 = (((s + 90.0) / c).floor() as i64).clamp(0, ny - 1);
        let iy1 = (((n + 90.0) / c).ceil() as i64).clamp(iy0 + 1, ny);
        let (width, height) = ((ix1 - ix0) as usize, (iy1 - iy0) as usize);
        if (width as u64) * (height as u64) > MAX_BBOX_CELLS {
            return Err(Error::new(format!(
                "area too large for level {} ({width}×{height} cells); use a coarser level",
                level.level
            )));
        }

        // Edges in grid units relative to the bbox corner; horizontal edges never cross a sub-line.
        let to_grid = |p: &[f64; 2]| ((p[0] + 180.0) / c - ix0 as f64, (p[1] + 90.0) / c - iy0 as f64);
        let grid_edges: Vec<[f64; 4]> = self
            .rings
            .iter()
            .flat_map(|r| edges(r))
            .map(|(a, b)| {
                let ((x1, y1), (x2, y2)) = (to_grid(a), to_grid(b));
                [x1, y1, x2, y2]
            })
            .filter(|g| g[1] != g[3])
            .collect();

        // Sub-line j sits at y = (j + ½) / SUB_ROWS; an edge crosses it when min(y) <= y < max(y).
        let lines = height * SUB_ROWS;
        let sub = SUB_ROWS as f64;
        let line_span = |g: &[f64; 4]| {
            let at = |y: f64| (y * sub - 0.5).ceil().clamp(0.0, lines as f64) as usize;
            (at(g[1].min(g[3])), at(g[1].max(g[3])))
        };

        // Crossings bucketed by sub-line (CSR layout).
        let mut offs = vec![0usize; lines + 1];
        for g in &grid_edges {
            let (a, b) = line_span(g);
            for j in a..b {
                offs[j + 1] += 1;
            }
        }
        for j in 0..lines {
            offs[j + 1] += offs[j];
        }
        let mut xs = vec![0f64; offs[lines]];
        let mut fill = offs.clone();
        for g in &grid_edges {
            let (a, b) = line_span(g);
            let [x1, y1, x2, y2] = *g;
            for j in a..b {
                let y = (j as f64 + 0.5) / sub;
                xs[fill[j]] = x1 + (y - y1) * (x2 - x1) / (y2 - y1);
                fill[j] += 1;
            }
        }

        let mut acc = vec![0f64; width];
        let mut out = CellWeights { level: level.level, ..Default::default() };
        for r in 0..height {
            for k in 0..SUB_ROWS {
                let j = r * SUB_ROWS + k;
                let row = &mut xs[offs[j]..offs[j + 1]];
                row.sort_unstable_by(f64::total_cmp);
                for [a, b] in row.as_chunks::<2>().0 {
                    add_span(&mut acc, *a, *b);
                }
            }
            let row_base = (iy0 as u64 + r as u64) * nx as u64 + ix0 as u64;
            for (i, a) in acc.iter_mut().enumerate() {
                if *a > 1e-6 {
                    out.cells.push((row_base + i as u64) as u32);
                    out.weights.push(a.min(1.0) as f32);
                }
                *a = 0.0;
            }
        }
        Ok(out)
    }
}

/// Adds the inside span [a, b) of one sub-line (grid units) to the row accumulator.
fn add_span(acc: &mut [f64], a: f64, b: f64) {
    const STEP: f64 = 1.0 / SUB_ROWS as f64;
    let width = acc.len() as f64;
    let (a, b) = (a.clamp(0.0, width), b.clamp(0.0, width));
    if b <= a {
        return;
    }
    let (ia, ib) = (a.floor() as usize, b.floor() as usize);
    if ia == ib {
        acc[ia] += (b - a) * STEP;
        return;
    }
    acc[ia] += (ia as f64 + 1.0 - a) * STEP;
    for v in &mut acc[ia + 1..ib] {
        *v += STEP;
    }
    if let Some(v) = acc.get_mut(ib) {
        *v += (b - ib as f64) * STEP;
    }
}

/// Distinct tile keys `"tx_ty"` holding at least one weighted cell, sorted.
pub fn tile_keys(weights: &CellWeights, level: &LevelMeta) -> Vec<String> {
    let per = level.cells_per_tile();
    let nx = level.nx.max(1);
    let mut keys = BTreeSet::new();
    let mut last = None;
    for &cell in &weights.cells {
        let key = ((cell % nx) / per, (cell / nx) / per);
        if last != Some(key) {
            keys.insert(key);
            last = Some(key);
        }
    }
    keys.into_iter().map(|(tx, ty)| format!("{tx}_{ty}")).collect()
}

fn edges(ring: &[[f64; 2]]) -> impl Iterator<Item = (&[f64; 2], &[f64; 2])> {
    ring.iter().zip(ring.iter().cycle().skip(1))
}

fn clean_ring(ring: Ring) -> Result<Ring, Error> {
    let mut out: Ring = Vec::with_capacity(ring.len());
    for p in ring {
        if !(p[0].is_finite() && p[1].is_finite()) {
            return Err(Error::new("coordinates must be finite numbers"));
        }
        if p[1].abs() > 90.0 {
            return Err(Error::new(format!("latitude {} is outside [-90, 90]", p[1])));
        }
        if out.last() != Some(&p) {
            out.push(p);
        }
    }
    while out.len() > 1 && out.first() == out.last() {
        out.pop();
    }
    Ok(out)
}

/// Rejects edges longer than 180° of longitude and shifts a polygon drawn on a wrapped copy of
/// the world (e.g. lon 190..200) back into [-180, 180].
fn normalize_longitudes(rings: &mut [Ring]) -> Result<(), Error> {
    if rings.iter().any(|r| edges(r).any(|(a, b)| (b[0] - a[0]).abs() > 180.0)) {
        return Err(Error::new(ANTIMERIDIAN));
    }
    let lons = || rings.iter().flatten().map(|p| p[0]);
    let lo = lons().fold(f64::INFINITY, f64::min);
    let hi = lons().fold(f64::NEG_INFINITY, f64::max);
    let shift = (-2..=2)
        .map(|k| k as f64 * 360.0)
        .find(|s| lo + s >= -180.0 && hi + s <= 180.0)
        .ok_or_else(|| Error::new(ANTIMERIDIAN))?;
    if shift != 0.0 {
        rings.iter_mut().flatten().for_each(|p| p[0] += shift);
    }
    Ok(())
}

/// Signed planar area and first moments (shoelace) relative to `origin`.
fn planar_moments_from(ring: &[[f64; 2]], origin: [f64; 2]) -> (f64, f64, f64) {
    let (mut a, mut mx, mut my) = (0.0, 0.0, 0.0);
    for (p, q) in edges(ring) {
        let (x0, y0, x1, y1) = (p[0] - origin[0], p[1] - origin[1], q[0] - origin[0], q[1] - origin[1]);
        let cross = x0 * y1 - x1 * y0;
        a += cross;
        mx += (x0 + x1) * cross;
        my += (y0 + y1) * cross;
    }
    (a / 2.0, mx / 6.0, my / 6.0)
}

fn planar_moments(ring: &[[f64; 2]]) -> (f64, f64, f64) {
    planar_moments_from(ring, ring.first().copied().unwrap_or([0.0, 0.0]))
}

/// Area on the sphere of a ring whose edges are straight in lon/lat:
/// A = R² |∮ sin φ dλ|, integrated exactly along each edge with φ linear in λ.
pub fn spherical_ring_area_km2(ring: &[[f64; 2]]) -> f64 {
    let mut sum = 0.0;
    for (a, b) in edges(ring) {
        let (l1, p1, l2, p2) = (a[0].to_radians(), a[1].to_radians(), b[0].to_radians(), b[1].to_radians());
        let half = (p2 - p1) / 2.0;
        // (cos φ1 − cos φ2)/(φ2 − φ1) = sin(φm) · sin(h)/h, stable as h → 0.
        let sinc = if half.abs() < 1e-9 { 1.0 } else { half.sin() / half };
        sum += (l2 - l1) * ((p1 + p2) / 2.0).sin() * sinc;
    }
    (sum * EARTH_RADIUS_KM * EARTH_RADIUS_KM).abs()
}

fn describe(rings: &[Ring]) -> AoiInfo {
    let mut bbox = [f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY];
    for p in rings.iter().flatten() {
        bbox = [bbox[0].min(p[0]), bbox[1].min(p[1]), bbox[2].max(p[0]), bbox[3].max(p[1])];
    }
    let area: f64 = rings
        .iter()
        .enumerate()
        .map(|(k, r)| if k == 0 { 1.0 } else { -1.0 } * spherical_ring_area_km2(r))
        .sum();

    // Planar area-weighted centroid in lon/lat; holes subtract whatever their winding.
    let origin = rings[0][0];
    let (mut a, mut mx, mut my) = (0.0, 0.0, 0.0);
    for (k, ring) in rings.iter().enumerate() {
        let (ra, rx, ry) = planar_moments_from(ring, origin);
        let sign = if k == 0 { 1.0 } else { -1.0 } * ra.signum();
        a += sign * ra;
        mx += sign * rx;
        my += sign * ry;
    }
    let centroid = if a > 1e-12 {
        [origin[0] + mx / a, origin[1] + my / a]
    } else {
        [(bbox[0] + bbox[2]) / 2.0, (bbox[1] + bbox[3]) / 2.0]
    };
    AoiInfo { area_km2: area.max(0.0), bbox, centroid }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn level(cell_deg: f64, tile_deg: f64) -> LevelMeta {
        LevelMeta {
            level: 0,
            cell_deg,
            tile_deg,
            nx: (360.0 / cell_deg).round() as u32,
            ny: (180.0 / cell_deg).round() as u32,
        }
    }

    fn rect(w: f64, s: f64, e: f64, n: f64) -> Ring {
        vec![[w, s], [e, s], [e, n], [w, n], [w, s]]
    }

    /// Brute-force coverage: fraction of a 64×64 point lattice inside the AOI.
    fn brute_weight(aoi: &Aoi, lv: &LevelMeta, cell: u32) -> f64 {
        let (ix, iy) = ((cell % lv.nx) as f64, (cell / lv.nx) as f64);
        let k = 64;
        let mut inside = 0;
        for a in 0..k {
            for b in 0..k {
                let lon = (ix + (a as f64 + 0.5) / k as f64) * lv.cell_deg - 180.0;
                let lat = (iy + (b as f64 + 0.5) / k as f64) * lv.cell_deg - 90.0;
                inside += aoi.contains(lon, lat) as u32;
            }
        }
        inside as f64 / (k * k) as f64
    }

    fn check_against_brute(aoi: &Aoi, lv: &LevelMeta) {
        let w = aoi.weights(lv).unwrap();
        assert!(w.cells.windows(2).all(|p| p[0] < p[1]), "cells sorted");
        let [west, south, east, north] = aoi.info().bbox;
        let (ix0, ix1) = (((west + 180.0) / lv.cell_deg).floor() as u32, ((east + 180.0) / lv.cell_deg).ceil() as u32);
        let (iy0, iy1) = (((south + 90.0) / lv.cell_deg).floor() as u32, ((north + 90.0) / lv.cell_deg).ceil() as u32);
        let mut total = (0.0, 0.0);
        for iy in iy0..iy1 {
            for ix in ix0..ix1 {
                let cell = iy * lv.nx + ix;
                let brute = brute_weight(aoi, lv, cell);
                let got = w.cells.binary_search(&cell).map(|i| w.weights[i] as f64).unwrap_or(0.0);
                // 1/32 sub-row quantisation + 1/128 lattice error.
                assert!((got - brute).abs() < 0.045, "cell {cell}: got {got}, brute {brute}");
                total.0 += got;
                total.1 += brute;
            }
        }
        assert!((total.0 - total.1).abs() < 0.01 * total.1.max(1.0), "{total:?}");
    }

    #[test]
    fn point_in_polygon_with_hole_and_any_winding() {
        let mut outer = rect(0.0, 0.0, 10.0, 10.0);
        outer.reverse(); // clockwise outer
        let aoi = Aoi::from_rings(vec![outer, rect(4.0, 4.0, 6.0, 6.0)]).unwrap();
        assert!(aoi.contains(1.0, 1.0));
        assert!(!aoi.contains(5.0, 5.0));
        assert!(!aoi.contains(11.0, 5.0));
    }

    #[test]
    fn coverage_matches_brute_force_concave_with_hole() {
        // A concave "C" shape with a triangular hole, off-grid vertices.
        let outer = vec![
            [0.013, 0.021], [0.512, 0.004], [0.497, 0.118], [0.141, 0.152],
            [0.163, 0.351], [0.488, 0.377], [0.503, 0.493], [0.022, 0.487],
        ];
        let hole = vec![[0.05, 0.20], [0.11, 0.24], [0.06, 0.43]];
        let aoi = Aoi::from_rings(vec![outer, hole]).unwrap();
        check_against_brute(&aoi, &level(0.05, 2.5));
    }

    #[test]
    fn coverage_interior_is_exactly_one() {
        let aoi = Aoi::from_rings(vec![rect(10.01, 20.01, 10.49, 20.49)]).unwrap();
        let lv = level(0.05, 2.5);
        let w = aoi.weights(&lv).unwrap();
        assert_eq!(w.cells.len(), 100);
        assert_eq!(w.weights.iter().filter(|&&x| x == 1.0).count(), 64);
        check_against_brute(&aoi, &lv);
    }

    #[test]
    fn area_of_one_degree_boxes() {
        let eq = Aoi::from_rings(vec![rect(0.0, 0.0, 1.0, 1.0)]).unwrap();
        let r2 = EARTH_RADIUS_KM * EARTH_RADIUS_KM;
        let expected_eq = r2 * 1f64.to_radians() * 1f64.to_radians().sin(); // ≈ 12 364 km²
        assert!((eq.info().area_km2 - expected_eq).abs() / expected_eq < 1e-9);
        assert!((eq.info().area_km2 - 12_364.0).abs() / 12_364.0 < 0.01);
        let hi = Aoi::from_rings(vec![rect(30.0, 60.0, 31.0, 61.0)]).unwrap();
        let expected_60 = r2 * 1f64.to_radians() * (61f64.to_radians().sin() - 60f64.to_radians().sin());
        assert!((hi.info().area_km2 - expected_60).abs() / expected_60 < 1e-9);
        assert!((hi.info().area_km2 - 6_088.0).abs() / 6_088.0 < 0.01);
        assert_eq!(eq.info().bbox, [0.0, 0.0, 1.0, 1.0]);
        assert!((eq.info().centroid[0] - 0.5).abs() < 1e-12 && (eq.info().centroid[1] - 0.5).abs() < 1e-12);
    }

    #[test]
    fn hole_subtracts_area() {
        let a = Aoi::from_rings(vec![rect(0.0, 0.0, 2.0, 2.0), rect(0.5, 0.5, 1.5, 1.5)]).unwrap();
        let full = spherical_ring_area_km2(&rect(0.0, 0.0, 2.0, 2.0));
        let hole = spherical_ring_area_km2(&rect(0.5, 0.5, 1.5, 1.5));
        assert!((a.info().area_km2 - (full - hole)).abs() < 1e-6);
    }

    #[test]
    fn degenerate_and_antimeridian_input() {
        assert!(Aoi::from_rings(vec![vec![[0.0, 0.0], [1.0, 1.0], [0.0, 0.0]]]).is_err());
        assert!(Aoi::from_rings(vec![vec![[0.0, 0.0], [1.0, 1.0], [2.0, 2.0]]]).is_err()); // collinear
        assert!(Aoi::from_rings(vec![]).is_err());
        assert!(Aoi::from_flat(&[0.0, 0.0, 1.0], &[0]).is_err());
        assert!(Aoi::from_flat(&[0.0, f64::NAN, 1.0, 0.0, 1.0, 1.0], &[0]).is_err());
        assert!(Aoi::from_rings(vec![rect(170.0, 0.0, 190.0, 1.0)]).is_err());
        assert!(Aoi::from_rings(vec![vec![[179.0, 0.0], [-179.0, 0.0], [-179.0, 1.0], [179.0, 1.0]]]).is_err());
        assert!(Aoi::from_rings(vec![rect(0.0, 80.0, 1.0, 95.0)]).is_err());
        // Wrapped copy of the world is shifted back.
        let a = Aoi::from_rings(vec![rect(190.0, 0.0, 191.0, 1.0)]).unwrap();
        assert_eq!(a.info().bbox[0], -170.0);
        // Degenerate hole is dropped, repeated vertices tolerated, offsets with end marker.
        let flat = [0.0, 0.0, 1.0, 0.0, 1.0, 0.0, 1.0, 1.0, 0.0, 1.0, 0.0, 0.0, 0.2, 0.2, 0.3, 0.3];
        let a = Aoi::from_flat(&flat, &[0, 6, 8]).unwrap();
        assert!(a.info().area_km2 > 12_000.0);
    }

    #[test]
    fn tile_keys_for_level() {
        let lv = level(0.05, 2.5);
        let aoi = Aoi::from_rings(vec![rect(-1.0, -1.0, 1.0, 1.0)]).unwrap();
        let w = aoi.weights(&lv).unwrap();
        // lon -1..1 -> tx 71,72 ; lat -1..1 -> ty 35,36
        assert_eq!(tile_keys(&w, &lv), vec!["71_35", "71_36", "72_35", "72_36"]);
        let global = level(1.0, 360.0);
        let w = aoi.weights(&global).unwrap();
        assert_eq!(tile_keys(&w, &global), vec!["0_0"]);
    }

    #[test]
    fn country_sized_polygon_is_fast_enough() {
        // ~40° × 35° star-ish polygon with 4000 vertices, at 0.05°.
        let n = 4000;
        let ring: Ring = (0..n)
            .map(|i| {
                let t = i as f64 / n as f64 * std::f64::consts::TAU;
                let r = 17.0 + 2.0 * (7.0 * t).sin() + 0.5 * (53.0 * t).cos();
                [-55.0 + r * t.cos(), -12.0 + r * 0.9 * t.sin()]
            })
            .collect();
        let aoi = Aoi::from_rings(vec![ring]).unwrap();
        let lv = level(0.05, 2.5);
        let t0 = std::time::Instant::now();
        let w = aoi.weights(&lv).unwrap();
        let dt = t0.elapsed();
        assert!(w.cells.len() > 200_000, "{}", w.cells.len());
        // Sum of weights × cell area ≈ polygon area (cells near ±30° lat; use per-row area).
        let cell_area = |cell: u32| {
            let iy = (cell / lv.nx) as f64;
            let (s, n) = ((iy * 0.05 - 90.0).to_radians(), ((iy + 1.0) * 0.05 - 90.0).to_radians());
            EARTH_RADIUS_KM * EARTH_RADIUS_KM * 0.05f64.to_radians() * (n.sin() - s.sin())
        };
        let covered: f64 = w.cells.iter().zip(&w.weights).map(|(&c, &x)| cell_area(c) * x as f64).sum();
        assert!((covered - aoi.info().area_km2).abs() / aoi.info().area_km2 < 1e-3);
        eprintln!("weights for {} cells in {:?}", w.cells.len(), dt);
    }
}
