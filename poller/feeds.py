"""Fetch and parse the subway GTFS-Realtime feeds."""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import date, datetime, timezone

import requests
from google.transit import gtfs_realtime_pb2

from settings import FEED_BASE, GTFS_STATUS, SUBWAY_FEEDS

log = logging.getLogger(__name__)

TIMEOUT = (10, 45)


@dataclass(frozen=True, slots=True)
class Observation:
    """One VehiclePosition, flattened.

    No coordinates: the NYCT subway feed does not supply them. Position is
    derived later from shape_stop_positions.
    """

    trip_id: str
    trip_start_date: date
    route_id: str
    stop_id: str | None
    current_status: str | None
    observed_at: datetime

    @property
    def key(self) -> tuple[str, date]:
        """What identifies one run of a train.

        trip_id alone is not enough: measured against static GTFS, one RT
        trip_id matches up to 10 scheduled trips because the same pattern runs
        under several service_ids.
        """
        return (self.trip_id, self.trip_start_date)

    @property
    def state(self) -> tuple[str | None, str | None]:
        """The pair that dedupe compares. Unchanged state is not written."""
        return (self.stop_id, self.current_status)


def _parse_start_date(raw: str, fallback: datetime) -> date:
    try:
        return datetime.strptime(raw, "%Y%m%d").date()
    except ValueError:
        return fallback.date()


def fetch_feed(name: str) -> list[Observation]:
    response = requests.get(FEED_BASE + name, timeout=TIMEOUT)
    response.raise_for_status()

    message = gtfs_realtime_pb2.FeedMessage()
    message.ParseFromString(response.content)

    now = datetime.now(timezone.utc)
    observations: list[Observation] = []

    for entity in message.entity:
        if not entity.HasField("vehicle"):
            continue
        vehicle = entity.vehicle
        if not vehicle.trip.trip_id:
            continue

        observations.append(
            Observation(
                trip_id=vehicle.trip.trip_id,
                trip_start_date=_parse_start_date(vehicle.trip.start_date, now),
                route_id=vehicle.trip.route_id or "?",
                stop_id=vehicle.stop_id or None,
                current_status=GTFS_STATUS.get(vehicle.current_status),
                # The feed's own timestamp when present: it is when the train
                # was actually observed, not when we happened to poll.
                observed_at=datetime.fromtimestamp(vehicle.timestamp, timezone.utc)
                if vehicle.timestamp
                else now,
            )
        )

    return observations


def fetch_all() -> tuple[list[Observation], dict[str, str]]:
    """Poll every feed. A failing feed is logged and skipped, never fatal --
    one bad endpoint must not stop ingestion for the whole system."""
    observations: list[Observation] = []
    failures: dict[str, str] = {}

    for name in SUBWAY_FEEDS:
        try:
            observations.extend(fetch_feed(name))
        except Exception as exc:  # noqa: BLE001 - any failure is non-fatal
            failures[name] = f"{type(exc).__name__}: {exc}"
            log.warning("feed %s failed: %s", name, failures[name])

    return observations, failures
