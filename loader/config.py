"""Configuration and environment loading for the GTFS static loader."""

from __future__ import annotations

import os
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent

# The SUPPLEMENTED subway feed. It is regenerated hourly and folds in service
# changes for the next several days; the regular feed does not, and realtime
# trip_id matching in Phase 3 depends on the supplemented one.
DEFAULT_GTFS_STATIC_URL = "https://rrgtfsfeeds.s3.amazonaws.com/gtfs_supplemented.zip"

# GTFS route_type 1 is subway. The MTA subway feed should contain nothing else.
# Anything of another type is skipped and logged rather than silently ingested,
# so an upstream feed change shows up in the run summary.
SUBWAY_ROUTE_TYPES = {1}

# Generous bounding box around the five boroughs, used to reject junk
# coordinates (0/0, swapped lon/lat, truncated values).
NYC_BBOX = (-74.40, 40.40, -73.60, 41.00)

SRID = 4326


def load_dotenv(path: Path | None = None) -> None:
    """Minimal .env reader. Existing environment variables win."""
    env_path = path or REPO_ROOT / ".env"
    if not env_path.is_file():
        return

    for line in env_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        os.environ.setdefault(key, value)


def database_url() -> str:
    """Prefer the direct endpoint: the loader writes in large batches and the
    pooled endpoint adds nothing for a single long-lived connection."""
    url = os.environ.get("DATABASE_URL_UNPOOLED") or os.environ.get("DATABASE_URL")
    if not url:
        raise SystemExit(
            "DATABASE_URL_UNPOOLED (or DATABASE_URL) is not set. "
            "Copy .env.example to .env and fill it in."
        )
    return url


def gtfs_static_url() -> str:
    return os.environ.get("GTFS_STATIC_URL") or DEFAULT_GTFS_STATIC_URL
