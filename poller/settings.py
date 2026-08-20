"""Poller configuration.

Named settings.py rather than config.py on purpose: loader/config.py is on the
path too, and two modules called config shadow each other into a circular
import.

Feed URLs live here and nowhere else -- MTA moves them, and hunting them
through the code is how a poller quietly stops working.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "loader"))

from config import load_dotenv, database_url  # noqa: E402,F401  re-exported

# Subway GTFS-Realtime. No API key required since the 2023 change.
FEED_BASE = "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2F"

SUBWAY_FEEDS = (
    "gtfs",        # 1234567S
    "gtfs-ace",
    "gtfs-bdfm",
    "gtfs-g",
    "gtfs-jz",
    "gtfs-nqrw",
    "gtfs-l",
    "gtfs-si",     # Staten Island Railway
)

POLL_SECONDS = int(os.environ.get("POLL_SECONDS", "30"))

# Raw retention. 44 MB/day measured at 30s polling with dedupe on, against a
# 512 MB tier, so this is the number to lower first if storage gets tight.
RETAIN_DAYS = int(os.environ.get("RETAIN_DAYS", "7"))

# Partition maintenance and retention are cheap but not free; run them
# hourly rather than every poll.
MAINTENANCE_EVERY_SECONDS = 3600

GTFS_STATUS = {0: "INCOMING_AT", 1: "STOPPED_AT", 2: "IN_TRANSIT_TO"}
