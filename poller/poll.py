"""Poll the MTA subway GTFS-Realtime feeds into Postgres.

    python poller/poll.py                 # run forever
    python poller/poll.py --once          # single cycle, for testing
    python poller/poll.py --dry-run       # parse and dedupe, write nothing

Runs as a long-lived worker (Fly.io / Railway), not on Vercel Cron: the Hobby
tier runs once a day and even Pro floors at one minute, against a 30s target.

Two things keep this inside a 512 MB database:

  * dedupe on write -- only state changes are stored (77.2% fewer rows,
    measured, not estimated)
  * daily partitions with a retention drop -- DROP TABLE returns space
    immediately where DELETE would not return it until vacuum
"""

from __future__ import annotations

import argparse
import logging
import signal
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import settings
import feeds
import writer
from state import VehicleState

log = logging.getLogger("poller")

_running = True


def _stop(signum, _frame) -> None:
    global _running
    log.info("signal %s received, finishing current cycle", signum)
    _running = False


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--once", action="store_true", help="run a single cycle and exit")
    parser.add_argument("--cycles", type=int, default=0, help="stop after N cycles (0 = run forever)")
    parser.add_argument("--dry-run", action="store_true", help="parse and dedupe without writing")
    parser.add_argument("--interval", type=int, default=settings.POLL_SECONDS)
    parser.add_argument("--retain-days", type=int, default=settings.RETAIN_DAYS)
    parser.add_argument("--verbose", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)-7s %(message)s",
        datefmt="%H:%M:%S",
    )
    settings.load_dotenv()

    signal.signal(signal.SIGINT, _stop)
    signal.signal(signal.SIGTERM, _stop)

    state = VehicleState()
    url = None if args.dry_run else settings.database_url()
    connection = None
    last_maintenance = 0.0

    if url:
        connection = writer.connect(url)
        with connection.cursor() as cursor:
            created, dropped = writer.run_maintenance(cursor, args.retain_days)
        connection.commit()
        last_maintenance = time.monotonic()
        log.info("startup maintenance: %d partition(s) created, %d dropped", created, dropped)

    cycles = 0
    try:
        while _running:
            started = time.monotonic()
            observations, failures = feeds.fetch_all()
            result = state.apply(observations)

            written = arrivals = 0
            if connection is not None:
                with connection.cursor() as cursor:
                    written = writer.write_positions(cursor, result.changed)
                    arrivals = writer.write_stop_events(cursor, result.arrivals)

                    if time.monotonic() - last_maintenance > settings.MAINTENANCE_EVERY_SECONDS:
                        created, dropped = writer.run_maintenance(cursor, args.retain_days)
                        size = writer.database_megabytes(cursor)
                        log.info(
                            "maintenance: +%d partition(s), -%d dropped, db %.0f MB",
                            created, dropped, size,
                        )
                        last_maintenance = time.monotonic()
                connection.commit()

            elapsed = time.monotonic() - started
            log.info(
                "%4d vehicles | %3d changed %4d unchanged (%.0f%% deduped) | %3d written %3d arrivals | %4.1fs%s",
                len(observations),
                len(result.changed),
                result.unchanged,
                100 * result.unchanged / len(observations) if observations else 0,
                written,
                arrivals,
                elapsed,
                f" | {len(failures)} feed failure(s)" if failures else "",
            )

            cycles += 1
            if args.once or (args.cycles and cycles >= args.cycles):
                break

            # Sleep the remainder of the interval so the cadence stays honest
            # regardless of how long the fetch took.
            time.sleep(max(0.0, args.interval - (time.monotonic() - started)))
    finally:
        if connection is not None:
            connection.close()

    log.info("stopped after %d cycle(s)", cycles)
    return 0


if __name__ == "__main__":
    sys.exit(main())
