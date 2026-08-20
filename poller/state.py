"""In-memory dedupe state.

The whole point of the poller's storage story: most polls show no change, so
writing every observation costs roughly 4x the rows for no extra information.

Measured against the live feed, 30 seconds apart: 672 vehicles, 519 unchanged,
149 changed, 4 new. Writing only changes is a 77.2% reduction -- 1,935,360
rows/day becomes 440,640.

State is deliberately in memory rather than read back from the database. It is
one dict of ~700 entries, it rebuilds itself on the first poll after a restart,
and the alternative is a query against the largest table on every cycle.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date

from feeds import Observation

STOPPED_AT = "STOPPED_AT"


@dataclass
class DedupeResult:
    changed: list[Observation] = field(default_factory=list)
    arrivals: list[Observation] = field(default_factory=list)
    unchanged: int = 0
    appeared: int = 0


class VehicleState:
    def __init__(self) -> None:
        self._last: dict[tuple[str, date], tuple[str | None, str | None]] = {}

    def apply(self, observations: list[Observation]) -> DedupeResult:
        result = DedupeResult()
        seen: set[tuple[str, date]] = set()

        for observation in observations:
            key = observation.key
            seen.add(key)
            previous = self._last.get(key)

            if previous == observation.state:
                result.unchanged += 1
                continue

            if previous is None:
                result.appeared += 1
            result.changed.append(observation)

            # An arrival is a TRANSITION into STOPPED_AT at a stop, not merely
            # being stopped. Without the transition test every poll while a
            # train sits in a station would count as another arrival.
            if (
                observation.current_status == STOPPED_AT
                and observation.stop_id
                and (previous is None or previous != (observation.stop_id, STOPPED_AT))
            ):
                result.arrivals.append(observation)

            self._last[key] = observation.state

        # Trips that have ended: drop them so the dict tracks active trains
        # rather than growing without bound.
        for key in self._last.keys() - seen:
            del self._last[key]

        return result

    def __len__(self) -> int:
        return len(self._last)
