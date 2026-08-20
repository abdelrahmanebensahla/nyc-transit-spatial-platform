"""Database writes for the poller."""

from __future__ import annotations

import logging
from typing import Iterable, Sequence

import psycopg
from psycopg import sql

from feeds import Observation

log = logging.getLogger(__name__)

VEHICLE_COLUMNS = ("trip_id", "trip_start_date", "route_id", "stop_id", "current_status", "observed_at")


def connect(url: str) -> psycopg.Connection:
    return psycopg.connect(url, autocommit=False)


def write_positions(cursor: psycopg.Cursor, observations: Sequence[Observation]) -> int:
    """COPY the changed observations into the partitioned parent.

    Postgres routes each row to its day partition automatically, so the poller
    never names one.
    """
    if not observations:
        return 0

    statement = sql.SQL("COPY vehicle_positions ({columns}) FROM STDIN").format(
        columns=sql.SQL(", ").join(sql.Identifier(column) for column in VEHICLE_COLUMNS)
    )

    with cursor.copy(statement) as copy:
        for observation in observations:
            copy.write_row(
                (
                    observation.trip_id,
                    observation.trip_start_date,
                    observation.route_id,
                    observation.stop_id,
                    observation.current_status,
                    observation.observed_at,
                )
            )

    return len(observations)


def write_stop_events(cursor: psycopg.Cursor, arrivals: Sequence[Observation]) -> int:
    """Record arrivals derived from transitions into STOPPED_AT.

    ON CONFLICT DO NOTHING against the (trip_id, trip_start_date, stop_id)
    unique constraint. That is what makes a poller restart harmless: the
    in-memory dedupe state is lost on restart, so the first poll after one
    re-reports every stopped train as an arrival.
    """
    if not arrivals:
        return 0

    cursor.executemany(
        """
        INSERT INTO stop_events (trip_id, trip_start_date, route_id, stop_id, arrived_at)
        VALUES (%s, %s, %s, %s, %s)
        ON CONFLICT (trip_id, trip_start_date, stop_id) DO NOTHING
        """,
        [(a.trip_id, a.trip_start_date, a.route_id, a.stop_id, a.observed_at) for a in arrivals],
    )
    return cursor.rowcount


def run_maintenance(cursor: psycopg.Cursor, retain_days: int) -> tuple[int, int]:
    """Create upcoming partitions and drop expired ones.

    Called from here rather than pg_cron: Neon suspends compute on inactivity
    and pg_cron does not fire while suspended, so in-database scheduling would
    stop silently.
    """
    cursor.execute("SELECT ensure_vehicle_position_partitions(2)")
    created = cursor.fetchone()[0]
    cursor.execute("SELECT drop_old_vehicle_position_partitions(%s)", (retain_days,))
    dropped = cursor.fetchone()[0]
    return created, dropped


def database_megabytes(cursor: psycopg.Cursor) -> float:
    cursor.execute("SELECT pg_database_size(current_database()) / 1048576.0")
    return float(cursor.fetchone()[0])
