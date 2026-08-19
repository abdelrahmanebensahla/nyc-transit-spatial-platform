"""Geometry construction for stops and shapes.

Everything is emitted as EWKT text. Postgres `geography` input parses EWKT
directly, so COPY can stream it straight into the column with no client-side
geometry library and no WKB encoding.
"""

from __future__ import annotations

from typing import Iterable, Sequence

from config import NYC_BBOX, SRID

Coordinate = tuple[float, float]


class CoordinateError(ValueError):
    """Raised for coordinates that are unparseable or outside NYC."""


def parse_coordinate(lon_raw: str | None, lat_raw: str | None) -> Coordinate:
    if not lon_raw or not lat_raw:
        raise CoordinateError("missing lat/lon")

    try:
        lon = float(lon_raw)
        lat = float(lat_raw)
    except ValueError as exc:
        raise CoordinateError(f"unparseable lat/lon ({lat_raw!r}, {lon_raw!r})") from exc

    min_lon, min_lat, max_lon, max_lat = NYC_BBOX
    if not (min_lon <= lon <= max_lon and min_lat <= lat <= max_lat):
        # Catches 0/0 and lon/lat transpositions, which read as valid floats.
        raise CoordinateError(f"coordinate outside NYC bbox ({lat}, {lon})")

    return lon, lat


def point_ewkt(coordinate: Coordinate) -> str:
    lon, lat = coordinate
    return f"SRID={SRID};POINT({lon} {lat})"


def linestring_ewkt(coordinates: Sequence[Coordinate]) -> str:
    body = ", ".join(f"{lon} {lat}" for lon, lat in coordinates)
    return f"SRID={SRID};LINESTRING({body})"


def dedupe_consecutive(coordinates: Iterable[Coordinate]) -> list[Coordinate]:
    """Drop repeated consecutive vertices.

    Zero-length segments are legal in a LineString but add nothing, and they
    make ST_LineLocatePoint results marginally less stable at the seam.
    """
    result: list[Coordinate] = []
    for coordinate in coordinates:
        if not result or coordinate != result[-1]:
            result.append(coordinate)
    return result
