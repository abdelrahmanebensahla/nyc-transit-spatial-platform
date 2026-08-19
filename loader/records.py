"""GTFS CSV rows -> validated tuples ready for COPY.

Each parser takes the raw row iterator plus a SkipLog and returns rows in the
column order declared alongside it. Nothing here touches the database.
"""

from __future__ import annotations

import re
from collections import defaultdict
from typing import Iterable, Iterator

from config import SUBWAY_ROUTE_TYPES
from feed import field
from geometry import CoordinateError, Coordinate, dedupe_consecutive, linestring_ewkt, parse_coordinate, point_ewkt
from stats import SkipLog

# GTFS times are offsets into a service day, so hours run past 24 and
# occasionally past 48. Anchored so '7:1:2' or '12:34' is rejected outright.
GTFS_TIME = re.compile(r"^\d{1,3}:[0-5]\d:[0-5]\d$")

ROUTE_COLUMNS = ("route_id", "route_short_name", "route_long_name", "route_color", "route_text_color")
STOP_COLUMNS = ("stop_id", "stop_name", "parent_station", "location_type", "geom")
SHAPE_COLUMNS = ("shape_id", "geom")
TRIP_COLUMNS = ("trip_id", "route_id", "service_id", "shape_id", "direction_id")
STOP_TIME_COLUMNS = ("trip_id", "stop_sequence", "stop_id", "arrival_time", "departure_time")


def _smallint(raw: str | None) -> int | None:
    try:
        return int(raw) if raw is not None else None
    except ValueError:
        return None


def _location_type(raw: str | None) -> int:
    """GTFS defines an empty location_type as 0 (stop/platform).

    The MTA feed leans on that default: every platform row ships an empty
    field, only the 496 parent stations carry an explicit 1. Storing NULL
    instead of 0 would quietly break `WHERE location_type = 0`.
    """
    value = _smallint(raw)
    return 0 if value is None else value


def _gtfs_time(raw: str | None) -> str | None:
    """Return the time as text for Postgres `interval`.

    Deliberately not parsed into a Python time: '24:47:00' is a valid GTFS
    value and has no datetime.time representation. Postgres parses the text
    into an interval that keeps the past-midnight hours intact.
    """
    if raw is None:
        return None
    return raw if GTFS_TIME.match(raw) else None


def parse_routes(rows: Iterable[dict[str, str]], skips: SkipLog) -> list[tuple]:
    parsed: list[tuple] = []

    for row in rows:
        route_id = field(row, "route_id")
        if not route_id:
            skips.skip("routes", "missing route_id")
            continue

        route_type = _smallint(field(row, "route_type"))
        if route_type not in SUBWAY_ROUTE_TYPES:
            skips.skip("routes", f"non-subway route_type={route_type}", route_id)
            continue

        short_name = field(row, "route_short_name")
        if not short_name:
            # route_short_name is NOT NULL. Falling back to route_id keeps the
            # route rather than dropping a whole line over a blank label.
            skips.repair("routes", "blank route_short_name, used route_id", route_id)
            short_name = route_id

        parsed.append(
            (
                route_id,
                short_name,
                field(row, "route_long_name"),
                field(row, "route_color"),
                field(row, "route_text_color"),
            )
        )

    return parsed


def parse_stops(rows: Iterable[dict[str, str]], skips: SkipLog) -> list[tuple]:
    """Parse stops.txt in two passes.

    The second pass exists because parent_station is a foreign key onto this
    same table: a platform pointing at a station that never made it into the
    feed would abort the insert. Those references are nulled and logged.
    """
    staged: list[tuple] = []

    for row in rows:
        stop_id = field(row, "stop_id")
        if not stop_id:
            skips.skip("stops", "missing stop_id")
            continue

        stop_name = field(row, "stop_name")
        if not stop_name:
            skips.skip("stops", "missing stop_name", stop_id)
            continue

        try:
            coordinate = parse_coordinate(field(row, "stop_lon"), field(row, "stop_lat"))
        except CoordinateError as exc:
            skips.skip("stops", str(exc), stop_id)
            continue

        staged.append(
            (
                stop_id,
                stop_name,
                field(row, "parent_station"),
                _location_type(field(row, "location_type")),
                point_ewkt(coordinate),
            )
        )

    known = {stop[0] for stop in staged}
    parsed: list[tuple] = []

    for stop_id, stop_name, parent, location_type, geom in staged:
        if parent is not None and parent not in known:
            skips.repair("stops", "parent_station not in feed, nulled", f"{stop_id}->{parent}")
            parent = None
        if parent == stop_id:
            skips.repair("stops", "stop is its own parent, nulled", stop_id)
            parent = None
        parsed.append((stop_id, stop_name, parent, location_type, geom))

    return parsed


def build_shapes(rows: Iterable[dict[str, str]], skips: SkipLog) -> list[tuple]:
    """Assemble one LineString per shape_id from shapes.txt points."""
    points: dict[str, list[tuple[int, Coordinate]]] = defaultdict(list)

    for row in rows:
        shape_id = field(row, "shape_id")
        if not shape_id:
            skips.skip("shapes", "missing shape_id")
            continue

        sequence = _smallint(field(row, "shape_pt_sequence"))
        if sequence is None:
            skips.skip("shapes", "missing or unparseable shape_pt_sequence", shape_id)
            continue

        try:
            coordinate = parse_coordinate(field(row, "shape_pt_lon"), field(row, "shape_pt_lat"))
        except CoordinateError as exc:
            skips.skip("shapes", f"point rejected: {exc}", shape_id)
            continue

        points[shape_id].append((sequence, coordinate))

    parsed: list[tuple] = []

    for shape_id, sequenced in points.items():
        # shapes.txt is not guaranteed to be ordered, and vertex order is the
        # whole meaning of a LineString.
        sequenced.sort(key=lambda item: item[0])
        coordinates = dedupe_consecutive(coordinate for _, coordinate in sequenced)

        if len(coordinates) < 2:
            skips.skip("shapes", "fewer than 2 distinct points", shape_id)
            continue

        parsed.append((shape_id, linestring_ewkt(coordinates)))

    return parsed


def parse_trips(
    rows: Iterable[dict[str, str]],
    route_ids: set[str],
    shape_ids: set[str],
    skips: SkipLog,
) -> list[tuple]:
    parsed: list[tuple] = []

    for row in rows:
        trip_id = field(row, "trip_id")
        if not trip_id:
            skips.skip("trips", "missing trip_id")
            continue

        route_id = field(row, "route_id")
        if route_id not in route_ids:
            # Usually a non-subway route filtered out upstream.
            skips.skip("trips", "route_id not loaded", f"{trip_id} ({route_id})")
            continue

        service_id = field(row, "service_id")
        if not service_id:
            skips.skip("trips", "missing service_id", trip_id)
            continue

        shape_id = field(row, "shape_id")
        if shape_id is not None and shape_id not in shape_ids:
            # Keep the trip: its schedule is still valid analytics input, it
            # just cannot be drawn or interpolated along.
            skips.repair("trips", "shape_id not in shapes.txt, nulled", f"{trip_id} ({shape_id})")
            shape_id = None

        parsed.append((trip_id, route_id, service_id, shape_id, _smallint(field(row, "direction_id"))))

    return parsed


def iter_stop_times(
    rows: Iterable[dict[str, str]],
    trip_ids: set[str],
    stop_ids: set[str],
    skips: SkipLog,
) -> Iterator[tuple]:
    """Stream stop_times.txt — roughly 2M rows, never held in memory at once."""
    for row in rows:
        trip_id = field(row, "trip_id")
        if trip_id not in trip_ids:
            skips.skip("stop_times", "trip_id not loaded", str(trip_id))
            continue

        stop_id = field(row, "stop_id")
        if stop_id not in stop_ids:
            # Documented MTA behaviour: the feeds reference internal track
            # locations, mostly near terminals, that stops.txt omits.
            skips.skip("stop_times", "stop_id not in stops.txt", str(stop_id))
            continue

        sequence = _smallint(field(row, "stop_sequence"))
        if sequence is None:
            skips.skip("stop_times", "missing or unparseable stop_sequence", f"{trip_id}")
            continue

        arrival_raw = field(row, "arrival_time")
        departure_raw = field(row, "departure_time")
        arrival = _gtfs_time(arrival_raw)
        departure = _gtfs_time(departure_raw)

        if arrival_raw and arrival is None:
            skips.repair("stop_times", "malformed arrival_time, nulled", f"{trip_id} {arrival_raw}")
        if departure_raw and departure is None:
            skips.repair("stop_times", "malformed departure_time, nulled", f"{trip_id} {departure_raw}")

        yield (trip_id, sequence, stop_id, arrival, departure)


def dedupe_stop_times(rows: Iterator[tuple], skips: SkipLog) -> Iterator[tuple]:
    """Drop duplicate (trip_id, stop_sequence) pairs.

    Upsert mode collapses duplicates server-side with DISTINCT ON. Replace mode
    copies straight into the primary key, where a duplicate aborts the load, so
    it has to be caught here instead.

    GTFS groups stop_times by trip, so only the current trip's sequences need
    holding — tracking all 2.3M keys would cost more memory than the rest of the
    loader combined. A trip whose rows are not contiguous is logged, because
    dedupe cannot be guaranteed across blocks.
    """
    current_trip: str | None = None
    seen_sequences: set[int] = set()
    finished: set[str] = set()

    for row in rows:
        trip_id, sequence = row[0], row[1]

        if trip_id != current_trip:
            if current_trip is not None:
                finished.add(current_trip)
            if trip_id in finished:
                skips.repair("stop_times", "trip block not contiguous", str(trip_id))
            current_trip = trip_id
            seen_sequences = set()

        if sequence in seen_sequences:
            skips.skip("stop_times", "duplicate (trip_id, stop_sequence)", f"{trip_id} #{sequence}")
            continue

        seen_sequences.add(sequence)
        yield row
