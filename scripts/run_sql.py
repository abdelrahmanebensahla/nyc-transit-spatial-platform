"""Execute a .sql file against Postgres without needing the psql binary.

    python scripts/run_sql.py drizzle/0000_init.sql
    python scripts/run_sql.py scripts/populate_shape_stop_positions.sql
    python scripts/run_sql.py scripts/verify.sql

The SQL files are also written to run under psql. This runner exists because
psql is a separate install that is not always present, and requiring it just to
verify the database would be a silly dependency for a project that already
depends on psycopg.

Runs in autocommit, so the BEGIN/COMMIT blocks inside the files apply as written.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "loader"))

import config  # noqa: E402
import psycopg  # noqa: E402

MAX_COLUMN_WIDTH = 60
MAX_ROWS = 50

# The SQL files use em dashes in comments and a Windows console defaults to
# cp1252, which cannot encode them.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")


def split_statements(text: str) -> list[str]:
    """Split on semicolons that are not inside quotes, comments or $$ blocks."""
    statements: list[str] = []
    current: list[str] = []
    i = 0
    in_single = in_line_comment = in_block_comment = False
    dollar_tag: str | None = None

    while i < len(text):
        char = text[i]
        rest = text[i:]

        if in_line_comment:
            if char == "\n":
                in_line_comment = False
            current.append(char)
        elif in_block_comment:
            if rest.startswith("*/"):
                in_block_comment = False
                current.append("*/")
                i += 2
                continue
            current.append(char)
        elif dollar_tag is not None:
            if rest.startswith(dollar_tag):
                current.append(dollar_tag)
                i += len(dollar_tag)
                dollar_tag = None
                continue
            current.append(char)
        elif in_single:
            if char == "'":
                in_single = False
            current.append(char)
        elif rest.startswith("--"):
            in_line_comment = True
            current.append(char)
        elif rest.startswith("/*"):
            in_block_comment = True
            current.append("/*")
            i += 2
            continue
        elif char == "'":
            in_single = True
            current.append(char)
        elif char == "$":
            end = text.find("$", i + 1)
            # A dollar quote is $$ (empty tag) or $tag$. The empty case matters:
            # plpgsql bodies are almost always $$-quoted, and missing it splits
            # the function on the semicolons inside it.
            tag_body = text[i + 1 : end] if end != -1 else None
            if end != -1 and (tag_body == "" or tag_body.replace("_", "").isalnum()):
                dollar_tag = text[i : end + 1]
                current.append(dollar_tag)
                i = end + 1
                continue
            current.append(char)
        elif char == ";":
            statements.append("".join(current))
            current = []
        else:
            current.append(char)

        i += 1

    if "".join(current).strip():
        statements.append("".join(current))

    # A chunk that is only comments is not worth a round trip.
    def has_sql(chunk: str) -> bool:
        return any(
            line.strip() and not line.strip().startswith("--")
            for line in chunk.splitlines()
        )

    return [s for s in (stmt.strip() for stmt in statements) if s and has_sql(s)]


def build_plan(path: Path) -> list[tuple[str, str]]:
    r"""Interleave psql \echo output with the statements around it.

    Echoing everything up front and then running the SQL would detach every
    section header from the result it labels, which is most of what verify.sql
    is for. Backslash commands other than \echo are dropped.
    """
    plan: list[tuple[str, str]] = []
    buffer: list[str] = []

    def flush() -> None:
        for statement in split_statements("\n".join(buffer)):
            plan.append(("sql", statement))
        buffer.clear()

    for line in path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped.startswith("\\"):
            buffer.append(line)
            continue
        flush()
        if stripped.startswith("\echo"):
            plan.append(("echo", stripped[len("\echo") :].strip().strip("'")))

    flush()
    return plan


def without_comments(statement: str) -> str:
    """Error previews should show the SQL, not the comment block above it."""
    lines = [line for line in statement.splitlines() if not line.strip().startswith("--")]
    return "\n".join(lines).strip() or statement


def render(columns: list[str], rows: list[tuple]) -> None:
    text_rows = [
        [("" if value is None else str(value))[:MAX_COLUMN_WIDTH] for value in row]
        for row in rows[:MAX_ROWS]
    ]
    widths = [len(name) for name in columns]
    for row in text_rows:
        for index, cell in enumerate(row):
            widths[index] = max(widths[index], len(cell))

    print("  " + " | ".join(name.ljust(widths[i]) for i, name in enumerate(columns)))
    print("  " + "-+-".join("-" * width for width in widths))
    for row in text_rows:
        print("  " + " | ".join(cell.ljust(widths[i]) for i, cell in enumerate(row)))
    if len(rows) > MAX_ROWS:
        print(f"  ... {len(rows) - MAX_ROWS:,} more row(s)")
    print(f"  ({len(rows):,} row{'' if len(rows) == 1 else 's'})")


def main() -> int:
    if len(sys.argv) != 2:
        print(__doc__)
        return 2

    path = Path(sys.argv[1])
    if not path.is_file():
        print(f"no such file: {path}", file=sys.stderr)
        return 1

    config.load_dotenv()
    plan = build_plan(path)

    failures = 0
    with psycopg.connect(config.database_url(), autocommit=True) as connection:
        for kind, payload in plan:
            if kind == "echo":
                print(payload)
                continue

            with connection.cursor() as cursor:
                try:
                    cursor.execute(payload)
                except psycopg.Error as exc:
                    failures += 1
                    preview = " ".join(without_comments(payload).split())[:90]
                    print(f"\nERROR on: {preview}\n  {exc}", file=sys.stderr)
                    continue

                if cursor.description is not None:
                    render([d.name for d in cursor.description], cursor.fetchall())
                elif cursor.statusmessage:
                    print(f"  {cursor.statusmessage}")

    if failures:
        print(f"\n{failures} statement(s) failed", file=sys.stderr)
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
