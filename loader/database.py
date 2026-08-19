"""Staging-table load primitives.

Every table follows the same three steps:

  1. COPY the parsed rows into an unconstrained TEMP table
  2. INSERT ... SELECT DISTINCT ON (key) ... ON CONFLICT DO UPDATE into the real
     table, which is what makes a re-run idempotent
  3. optionally DELETE real rows absent from the staging table, so a refresh
     against a newer feed does not leave withdrawn trips behind

Staging first also fixes the ordering problem: foreign keys are enforced by
AFTER ROW triggers that fire at the end of the statement, so a single
INSERT ... SELECT satisfies stops.parent_station regardless of row order.
"""

from __future__ import annotations

import logging
from typing import Iterable, Sequence

import psycopg
from psycopg import sql

log = logging.getLogger(__name__)


def connect(url: str) -> psycopg.Connection:
    """One connection, one transaction for the whole load. A partial GTFS load
    is worse than none — the tables reference each other."""
    return psycopg.connect(url, autocommit=False)


def create_staging(cursor: psycopg.Cursor, table: str) -> sql.Identifier:
    """LIKE copies column types (including geography) and NOT NULL, but no
    keys, indexes or foreign keys — staging should accept anything we hand it
    so validation stays in Python where the reasons can be logged."""
    staging = f"staging_{table}"
    cursor.execute(
        sql.SQL("CREATE TEMP TABLE {staging} (LIKE {table}) ON COMMIT DROP").format(
            staging=sql.Identifier(staging), table=sql.Identifier(table)
        )
    )
    return sql.Identifier(staging)


def copy_into(
    cursor: psycopg.Cursor,
    staging: sql.Identifier,
    columns: Sequence[str],
    rows: Iterable[tuple],
) -> int:
    statement = sql.SQL("COPY {staging} ({columns}) FROM STDIN").format(
        staging=staging,
        columns=sql.SQL(", ").join(sql.Identifier(column) for column in columns),
    )

    written = 0
    with cursor.copy(statement) as copy:
        for row in rows:
            copy.write_row(row)
            written += 1

    return written


def analyze(cursor: psycopg.Cursor, staging: sql.Identifier) -> None:
    """Staging tables have no statistics, and the prune step joins against
    them. Without this the planner assumes ~2,550 rows and picks badly."""
    cursor.execute(sql.SQL("ANALYZE {staging}").format(staging=staging))


def upsert(
    cursor: psycopg.Cursor,
    table: str,
    staging: sql.Identifier,
    columns: Sequence[str],
    key_columns: Sequence[str],
) -> int:
    """DISTINCT ON collapses duplicate keys within the feed itself, which
    ON CONFLICT cannot do — Postgres rejects a statement that touches the same
    row twice with 'cannot affect row a second time'."""
    updatable = [column for column in columns if column not in key_columns]
    column_list = sql.SQL(", ").join(sql.Identifier(column) for column in columns)
    key_list = sql.SQL(", ").join(sql.Identifier(column) for column in key_columns)

    if updatable:
        action = sql.SQL("DO UPDATE SET {assignments}").format(
            assignments=sql.SQL(", ").join(
                sql.SQL("{column} = EXCLUDED.{column}").format(column=sql.Identifier(column))
                for column in updatable
            )
        )
    else:
        action = sql.SQL("DO NOTHING")

    cursor.execute(
        sql.SQL(
            "INSERT INTO {table} ({columns}) "
            "SELECT DISTINCT ON ({keys}) {columns} FROM {staging} ORDER BY {keys} "
            "ON CONFLICT ({keys}) {action}"
        ).format(
            table=sql.Identifier(table),
            columns=column_list,
            keys=key_list,
            staging=staging,
            action=action,
        )
    )

    return cursor.rowcount


def prune(
    cursor: psycopg.Cursor,
    table: str,
    staging: sql.Identifier,
    key_columns: Sequence[str],
) -> int:
    """Delete rows the current feed no longer contains."""
    predicate = sql.SQL(" AND ").join(
        sql.SQL("s.{column} = t.{column}").format(column=sql.Identifier(column))
        for column in key_columns
    )

    cursor.execute(
        sql.SQL(
            "DELETE FROM {table} AS t "
            "WHERE NOT EXISTS (SELECT 1 FROM {staging} AS s WHERE {predicate})"
        ).format(table=sql.Identifier(table), staging=staging, predicate=predicate)
    )

    return cursor.rowcount


def prune_orphan_shape_stop_positions(cursor: psycopg.Cursor) -> int:
    """shape_stop_positions references shapes and stops, so it has to give up
    its rows before those tables can lose theirs. It is rebuilt wholesale by
    scripts/populate_shape_stop_positions.sql after every load anyway."""
    cursor.execute(
        """
        DELETE FROM shape_stop_positions AS p
        WHERE NOT EXISTS (SELECT 1 FROM staging_shapes s WHERE s.shape_id = p.shape_id)
           OR NOT EXISTS (SELECT 1 FROM staging_stops s WHERE s.stop_id = p.stop_id)
        """
    )
    return cursor.rowcount


def truncate(cursor: psycopg.Cursor, table: str) -> None:
    """Empty a table. Committing after this is what actually frees the storage.

    Used by replace mode: the free-tier ceiling cannot hold the old and new
    copies of stop_times at once, so the old one has to be released before the
    new one is written.
    """
    cursor.execute(sql.SQL("TRUNCATE {table}").format(table=sql.Identifier(table)))
