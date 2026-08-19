"""Skip and repair accounting, so every rejected row is explained."""

from __future__ import annotations

from collections import Counter, defaultdict

MAX_EXAMPLES = 3


class SkipLog:
    """Counts rows dropped or repaired per table, grouped by reason.

    MTA feeds routinely reference stops that are absent from stops.txt and trips
    whose shape is missing. The loader must not crash on those, but it must not
    hide them either — every drop lands here and is printed in the run summary.
    """

    def __init__(self) -> None:
        self.skipped: dict[str, Counter[str]] = defaultdict(Counter)
        self.repaired: dict[str, Counter[str]] = defaultdict(Counter)
        self.examples: dict[tuple[str, str], list[str]] = defaultdict(list)

    def skip(self, table: str, reason: str, example: str | None = None) -> None:
        self.skipped[table][reason] += 1
        self._record_example(table, reason, example)

    def repair(self, table: str, reason: str, example: str | None = None) -> None:
        """A field was corrected rather than the row dropped."""
        self.repaired[table][reason] += 1
        self._record_example(table, reason, example)

    def _record_example(self, table: str, reason: str, example: str | None) -> None:
        if example is None:
            return
        bucket = self.examples[(table, reason)]
        if len(bucket) < MAX_EXAMPLES:
            bucket.append(example)

    def total_skipped(self, table: str) -> int:
        return sum(self.skipped[table].values())

    def format_report(self) -> list[str]:
        lines: list[str] = []
        tables = sorted(set(self.skipped) | set(self.repaired))
        for table in tables:
            for label, counter in (("skipped", self.skipped[table]), ("repaired", self.repaired[table])):
                for reason, count in counter.most_common():
                    examples = self.examples.get((table, reason), [])
                    suffix = f"  e.g. {', '.join(examples)}" if examples else ""
                    lines.append(f"  {table}: {count:>7,} {label} - {reason}{suffix}")
        return lines
