#!/usr/bin/env python3
"""Read bench/results.csv and write latency + throughput charts into docs/."""

from __future__ import annotations

import csv
import sys
from pathlib import Path

try:
    import matplotlib.pyplot as plt
except ImportError:
    print("matplotlib is required: pip install matplotlib", file=sys.stderr)
    sys.exit(1)

ROOT = Path(__file__).resolve().parents[1]
CSV_PATH = Path(__file__).resolve().parent / "results.csv"
DOCS = ROOT / "docs"


def load_rows(path: Path) -> list[dict[str, str]]:
    if not path.exists():
        print(f"No results file at {path}. Run: npm run bench -- ...", file=sys.stderr)
        sys.exit(1)
    with path.open(newline="", encoding="utf-8") as handle:
        rows = list(csv.DictReader(handle))
    if not rows:
        print(
            f"{path} has no data rows yet (header only). "
            "Run benchmarks first; refusing to invent numbers.",
            file=sys.stderr,
        )
        sys.exit(1)
    return rows


def latest_by_label(rows: list[dict[str, str]]) -> list[dict[str, str]]:
    """Keep the last run for each label so re-runs replace older points on the chart."""
    chosen: dict[str, dict[str, str]] = {}
    for row in rows:
        label = row.get("label") or "unnamed"
        chosen[label] = row
    return list(chosen.values())


def main() -> None:
    csv_path = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else CSV_PATH
    rows = latest_by_label(load_rows(csv_path))
    labels = [row["label"] for row in rows]
    p50 = [float(row["p50_ms"]) for row in rows]
    p95 = [float(row["p95_ms"]) for row in rows]
    p99 = [float(row["p99_ms"]) for row in rows]
    ops = [float(row["ops_per_sec"]) for row in rows]

    DOCS.mkdir(parents=True, exist_ok=True)
    x = range(len(labels))
    width = 0.25

    fig, ax = plt.subplots(figsize=(10, 5))
    ax.bar([i - width for i in x], p50, width, label="p50")
    ax.bar(list(x), p95, width, label="p95")
    ax.bar([i + width for i in x], p99, width, label="p99")
    ax.set_xticks(list(x), labels, rotation=20, ha="right")
    ax.set_ylabel("Latency (ms)")
    ax.set_title("Benchmark latency (latest run per label)")
    ax.legend()
    fig.tight_layout()
    latency_path = DOCS / "bench-latency.png"
    fig.savefig(latency_path, dpi=140)
    plt.close(fig)

    fig, ax = plt.subplots(figsize=(10, 5))
    ax.bar(list(x), ops, color="#2a6f97")
    ax.set_xticks(list(x), labels, rotation=20, ha="right")
    ax.set_ylabel("Operations / second")
    ax.set_title("Benchmark throughput (latest run per label)")
    fig.tight_layout()
    throughput_path = DOCS / "bench-throughput.png"
    fig.savefig(throughput_path, dpi=140)
    plt.close(fig)

    print(f"Wrote {latency_path}")
    print(f"Wrote {throughput_path}")
    print(f"Plotted {len(rows)} label(s) from {csv_path}")


if __name__ == "__main__":
    main()
