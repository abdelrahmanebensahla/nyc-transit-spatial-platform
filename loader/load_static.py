"""Load the MTA supplemented subway GTFS static feed into Postgres/PostGIS.

    python loader/load_static.py
    python loader/load_static.py --zip loader/.cache/gtfs_supplemented.zip
    python loader/load_static.py --refresh-mode replace

Re-running is safe either way: rows are upserted by primary key, and by default
rows the feed no longer contains are pruned, so the database ends up matching
the feed rather than accumulating withdrawn trips.

Two refresh modes, differing only in how stop_times is written:

  upsert (default)  Everything in one transaction, via staging tables. Fully
                    atomic. Needs transient storage for a second copy of
                    stop_times, roughly 250 MB against this feed.

  replace           Commits the small tables, then TRUNCATEs and reloads
                    stop_times in a second transaction. Peak storage stays at
                    one copy. In exchange stop_times is briefly empty, and a
                    failure mid-copy leaves it that way until the next run.
                    Required on storage-capped tiers -- see the README.
"""

from __future__ import annotations

import argparse
import logging
import sys
import time
from pathlib import Path

import psycopg
from psycopg import sql

import config
import database
import feed
import records
from stats import SkipLog

log = logging.getLogger("load_static")

# Reverse dependency order: children before the parents they reference.
PRUNE_ORDER = (
    ("stop_times", ("trip_id", "stop_sequence")),
    ("trips", ("trip_id",)),
    ("shapes", ("shape_id",)),
    ("stops", ("stop_id",)),
    ("routes", ("route_id",)),
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--url", default=None, help="override the GTFS static feed URL")
    parser.add_argument("--zip", dest="zip_path", type=Path, default=None, help="load a previously downloaded zip instead of fetching")
    parser.add_argument("--save-zip", dest="save_zip", type=Path, default=None, help="write the downloaded zip to this path")
    parser.add_argument("--no-prune", action="store_true", help="keep rows the current feed omits")
    parser.add_argument(
        "--refresh-mode",
        choices=("upsert", "replace"),
        default="upsert",
        help=(
            "upsert (default): everything in one transaction via staging tables. "
            "replace: commit the small tables first, then TRUNCATE and reload "
            "stop_times directly. Use replace when storage cannot hold two copies "
            "of stop_times at once, e.g. the Neon free tier."
        ),
    )
    parser.add_argument("--verbose", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)-7s %(message)s",
        datefmt="%H:%M:%S",
    )

    replace_mode = args.refresh_mode == "replace"
    config.load_dotenv()
    # Resolved before the feed is fetched: failing on a missing connection
    # string after a 19 MiB download is a poor way to learn about it.
    database_url = config.database_url()
    started = time.monotonic()
    skips = SkipLog()
    loaded: dict[str, int] = {}
    pruned: dict[str, int] = {}

    source: bytes | Path
    if args.zip_path:
        if not args.zip_path.is_file():
            log.error("no such file: %s", args.zip_path)
            return 1
        source = args.zip_path
    else:
        source = feed.download(args.url or config.gtfs_static_url(), args.save_zip)

    with feed.open_feed(source) as archive, database.connect(database_url) as connection:
        with connection.cursor() as cursor:
            # --- routes ------------------------------------------------------
            route_rows = records.parse_routes(feed.read_rows(archive, "routes.txt"), skips)
            route_ids = {row[0] for row in route_rows}
            loaded["routes"] = _load(cursor, "routes", records.ROUTE_COLUMNS, ("route_id",), route_rows)

            # --- stops -------------------------------------------------------
            stop_rows = records.parse_stops(feed.read_rows(archive, "stops.txt"), skips)
            stop_ids = {row[0] for row in stop_rows}
            loaded["stops"] = _load(cursor, "stops", records.STOP_COLUMNS, ("stop_id",), stop_rows)

            # --- shapes ------------------------------------------------------
            shape_rows = records.build_shapes(feed.read_rows(archive, "shapes.txt"), skips)
            shape_ids = {row[0] for row in shape_rows}
            loaded["shapes"] = _load(cursor, "shapes", records.SHAPE_COLUMNS, ("shape_id",), shape_rows)

            # --- trips -------------------------------------------------------
            trip_rows = records.parse_trips(feed.read_rows(archive, "trips.txt"), route_ids, shape_ids, skips)
            trip_ids = {row[0] for row in trip_rows}
            loaded["trips"] = _load(cursor, "trips", records.TRIP_COLUMNS, ("trip_id",), trip_rows)
            del trip_rows

            # --- stop_times --------------------------------------------------
            # Streamed rather than materialised: this is the ~2M row file.
            if replace_mode:
                # Emptied here, reloaded after this transaction commits. The
                # commit is what actually releases the pages; until then the old
                # rows still occupy storage and a staging copy would not fit.
                database.truncate(cursor, "stop_times")
                log.info("stop_times    truncated, reload follows this commit")
            else:
                stop_time_rows = records.iter_stop_times(
                    feed.read_rows(archive, "stop_times.txt"), trip_ids, stop_ids, skips
                )
                loaded["stop_times"] = _load(
                    cursor, "stop_times", records.STOP_TIME_COLUMNS, ("trip_id", "stop_sequence"), stop_time_rows
                )

            # --- prune -------------------------------------------------------
            if args.no_prune:
                log.info("pruning disabled; rows absent from this feed are left in place")
            else:
                orphans = database.prune_orphan_shape_stop_positions(cursor)
                if orphans:
                    pruned["shape_stop_positions"] = orphans
                for table, key_columns in PRUNE_ORDER:
                    if replace_mode and table == "stop_times":
                        continue
                    removed = database.prune(cursor, table, _staging(table), key_columns)
                    if removed:
                        pruned[table] = removed

        connection.commit()

        if replace_mode:
            loaded["stop_times"] = _reload_stop_times(
                database_url, archive, trip_ids, stop_ids, skips
            )

    _report(loaded, pruned, skips, time.monotonic() - started)
    return 0


def _reload_stop_times(
    database_url: str,
    archive,
    trip_ids: set[str],
    stop_ids: set[str],
    skips: SkipLog,
) -> int:
    """COPY stop_times straight into the real table, in its own transaction.

    The trade this makes: between the truncate commit and this commit, the table
    is empty, and a failure here leaves it that way until the loader is re-run.
    In exchange the load never needs storage for two copies of the table, which
    is the difference between working and not on a 512 MB tier.
    """
    rows = records.dedupe_stop_times(
        records.iter_stop_times(feed.read_rows(archive, "stop_times.txt"), trip_ids, stop_ids, skips),
        skips,
    )

    with database.connect(database_url) as connection:
        with connection.cursor() as cursor:
            try:
                written = database.copy_into(
                    cursor, sql.Identifier("stop_times"), records.STOP_TIME_COLUMNS, rows
                )
            except psycopg.errors.UniqueViolation as exc:
                raise SystemExit(
                    "duplicate (trip_id, stop_sequence) survived the streaming "
                    "dedupe. Re-run with --refresh-mode upsert, which collapses "
                    f"duplicates server-side. {exc}"
                ) from exc
            cursor.execute("ANALYZE stop_times")
        connection.commit()

    log.info("%-12s copied    %9s (replace mode)", "stop_times", f"{written:,}")
    return written


def _staging(table: str) -> sql.Identifier:
    return sql.Identifier(f"staging_{table}")


def _load(cursor, table: str, columns, key_columns, rows) -> int:
    staging = database.create_staging(cursor, table)
    staged = database.copy_into(cursor, staging, columns, rows)
    database.analyze(cursor, staging)
    written = database.upsert(cursor, table, staging, columns, key_columns)

    collapsed = staged - written
    if collapsed > 0:
        log.warning("%s: %s duplicate key(s) in feed collapsed", table, f"{collapsed:,}")

    log.info("%-12s staged %9s -> upserted %9s", table, f"{staged:,}", f"{written:,}")
    return written


def _report(loaded: dict[str, int], pruned: dict[str, int], skips: SkipLog, elapsed: float) -> None:
    log.info("-" * 62)
    log.info("rows loaded")
    for table, count in loaded.items():
        log.info("  %-22s %9s  (%s skipped)", table, f"{count:,}", f"{skips.total_skipped(table):,}")

    if pruned:
        log.info("rows pruned (absent from this feed)")
        for table, count in sorted(pruned.items()):
            log.info("  %-22s %9s", table, f"{count:,}")

    report = skips.format_report()
    if report:
        log.info("skips and repairs by reason")
        for line in report:
            log.info("%s", line)
    else:
        log.info("no rows skipped or repaired")

    log.info("completed in %.1fs", elapsed)
    log.info("next: python scripts/run_sql.py scripts/populate_shape_stop_positions.sql")


if __name__ == "__main__":
    sys.exit(main())
