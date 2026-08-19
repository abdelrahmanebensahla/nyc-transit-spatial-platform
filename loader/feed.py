"""Fetching and reading the GTFS static zip."""

from __future__ import annotations

import csv
import io
import logging
import zipfile
from pathlib import Path
from typing import Iterator

import requests

log = logging.getLogger(__name__)

CHUNK = 1 << 20
TIMEOUT = (10, 120)  # connect, read


def download(url: str, save_to: Path | None = None) -> bytes:
    log.info("downloading %s", url)
    with requests.get(url, stream=True, timeout=TIMEOUT) as response:
        response.raise_for_status()
        buffer = io.BytesIO()
        for chunk in response.iter_content(CHUNK):
            buffer.write(chunk)

    data = buffer.getvalue()
    log.info("downloaded %.1f MiB", len(data) / (1 << 20))

    if save_to is not None:
        save_to.parent.mkdir(parents=True, exist_ok=True)
        save_to.write_bytes(data)
        log.info("saved feed to %s", save_to)

    return data


def open_feed(source: bytes | Path) -> zipfile.ZipFile:
    if isinstance(source, Path):
        log.info("reading local feed %s", source)
        return zipfile.ZipFile(source)
    return zipfile.ZipFile(io.BytesIO(source))


def _resolve_member(archive: zipfile.ZipFile, name: str) -> str:
    """Match by basename — some GTFS zips nest their files in a folder."""
    for candidate in archive.namelist():
        if candidate.rsplit("/", 1)[-1].lower() == name.lower():
            return candidate
    raise FileNotFoundError(
        f"{name} not found in feed. Contains: {', '.join(sorted(archive.namelist()))}"
    )


def read_rows(archive: zipfile.ZipFile, name: str) -> Iterator[dict[str, str]]:
    """Stream one GTFS CSV as dicts. utf-8-sig strips the BOM that MTA ships."""
    member = _resolve_member(archive, name)
    with archive.open(member) as raw:
        text = io.TextIOWrapper(raw, encoding="utf-8-sig", newline="")
        yield from csv.DictReader(text)


def field(row: dict[str, str], key: str) -> str | None:
    """GTFS encodes absent values as empty strings. Normalise to None."""
    value = row.get(key)
    if value is None:
        return None
    value = value.strip()
    return value or None
