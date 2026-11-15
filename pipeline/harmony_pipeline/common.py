"""Shared helpers: DuckDB connection, run manifest, freshness checks, timing."""
from __future__ import annotations

import json
import time
from contextlib import contextmanager
from pathlib import Path

import duckdb

from .config import RUN_JSON, TMP_DIR, WORK


def connect(threads: int = 12, memory: str = "12GB") -> duckdb.DuckDBPyConnection:
    TMP_DIR.mkdir(parents=True, exist_ok=True)
    con = duckdb.connect()
    con.execute(f"SET memory_limit='{memory}'; SET threads={threads}; "
                f"SET preserve_insertion_order=false; SET enable_progress_bar=false; SET temp_directory='{TMP_DIR.as_posix()}'")
    return con


def posix(p: Path | str) -> str:
    return Path(p).as_posix()


def run_info() -> dict:
    """The run manifest written by normalize: {"countries": [...] | None}."""
    if RUN_JSON.exists():
        return json.loads(RUN_JSON.read_text())
    return {"countries": None}


def is_regional() -> bool:
    return run_info().get("countries") is not None


def fresh(out: Path, inputs: list[Path]) -> bool:
    """True if `out` exists and is newer than every existing input (stage can be skipped)."""
    if not out.exists():
        return False
    t = out.stat().st_mtime
    return all(t >= p.stat().st_mtime for p in inputs if p.exists())


def write_json(path: Path, obj, compact: bool = False) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(obj, separators=(",", ":"), default=float) if compact else json.dumps(obj, indent=1, default=float)
    path.write_text(text)


def points_glob() -> str:
    return posix(WORK / "points" / "*" / "*.parquet")


@contextmanager
def timed(label: str):
    t0 = time.time()
    print(f"[{label}] start", flush=True)
    yield
    print(f"[{label}] done in {time.time() - t0:.1f}s", flush=True)
