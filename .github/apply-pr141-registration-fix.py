#!/usr/bin/env python3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def replace_once(path: Path, old: str, new: str) -> None:
    text = path.read_text()
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{path}: expected one replacement target, found {count}")
    path.write_text(text.replace(old, new, 1))


index_path = ROOT / "worker/index.ts"
replace_once(
    index_path,
    'import { bulkInsertStatements } from "./d1-bulk";\n',
    'import { bulkInsertStatements } from "./d1-bulk";\nimport { primaryD1 } from "./d1-primary";\n',
)

test_path = ROOT / "worker/blob-registration-reconciliation.test.ts"
replace_once(
    test_path,
    '      "https://app.test/api/attachments/item-upload/download",\n',
    '      "https://app.test/api/exports/attachments/item-upload",\n',
)
