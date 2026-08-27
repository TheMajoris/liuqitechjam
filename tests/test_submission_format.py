from __future__ import annotations

import csv
from pathlib import Path

import pytest

from submit import HEADER, read_submission, write_submission


ROWS = [
    (20220422, "10", "100", "author", "tab", 1.0, 0),
    (20220422, "10", "100", "author", "tab", 1.0, 1),
    (20220422, "11", "101", "author", "tab", 1.0, 0),
]


def write_records(path: Path, header: list[str], records: list[list[object]]) -> None:
    with path.open("w", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(header)
        writer.writerows(records)


def test_official_writer_round_trips_duplicate_user_video_pairs(tmp_path: Path) -> None:
    path = tmp_path / "submission.csv"
    write_submission(path, ROWS, [0.25, -1.0, 3.5])
    assert read_submission(path, ROWS) == [0.25, -1.0, 3.5]


@pytest.mark.parametrize(
    ("header", "records", "message"),
    [
        (["user_id", "video_id", "score"], [], "\u8868\u5934\u5fc5\u987b\u662f"),
        (HEADER, [[1, "10", "100", 0.1]], "\u5fc5\u987b 0 \u8d77\u8fde\u7eed\u9012\u589e"),
        (HEADER, [[0, "10", "wrong", 0.1]], "\u5bf9\u9f50\u9519\u8bef"),
        (HEADER, [[0, "10", "100", "NaN"]], "NaN/Inf"),
        (HEADER, [[0, "10", "100", 0.1]], "\u6570\u91cf\u4e0d\u7b26"),
    ],
)
def test_checker_rejects_invalid_submissions(
    tmp_path: Path,
    header: list[str],
    records: list[list[object]],
    message: str,
) -> None:
    path = tmp_path / "submission.csv"
    write_records(path, header, records)
    with pytest.raises(ValueError, match=message):
        read_submission(path, ROWS)
