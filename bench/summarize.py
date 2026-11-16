#!/usr/bin/env python3
"""Print median / min / max ops/sec and p99 per label from bench/results.csv."""

from __future__ import annotations

import csv
import sys
from collections import defaultdict
from pathlib import Path


def median(values: list[float]) -> float:
    ordered = sorted(values)
    mid = len(ordered) // 2
    if not ordered:
        return 0.0
    if len(ordered) % 2 == 1:
        return ordered[mid]
    return (ordered[mid - 1] + ordered[mid]) / 2


def main() -> None:
    path = Path(sys.argv[1] if len(sys.argv) > 1 else Path(__file__).with_name("results.csv"))
    if not path.exists():
        print(f"No CSV at {path}", file=sys.stderr)
        sys.exit(1)
    with path.open(newline="", encoding="utf-8") as handle:
        rows = list(csv.DictReader(handle))
    if not rows:
        print(f"{path} has no data rows", file=sys.stderr)
        sys.exit(1)

    by_label: dict[str, list[dict[str, str]]] = defaultdict(list)
    for row in rows:
        by_label[row.get("label") or "unnamed"].append(row)

    print(f"{'label':<32} {'n':>3}  {'ops med':>10} {'ops min':>10} {'ops max':>10}  {'p99 med':>8} {'p99 min':>8} {'p99 max':>8}")
    for label in sorted(by_label):
        group = by_label[label]
        ops = [float(r["ops_per_sec"]) for r in group]
        p99 = [float(r["p99_ms"]) for r in group]
        print(
            f"{label:<32} {len(group):>3}  "
            f"{median(ops):>10.2f} {min(ops):>10.2f} {max(ops):>10.2f}  "
            f"{median(p99):>8.3f} {min(p99):>8.3f} {max(p99):>8.3f}"
        )


if __name__ == "__main__":
    main()
