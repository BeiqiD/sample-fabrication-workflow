#!/usr/bin/env python3
"""Run the unchanged physical checker with the hosted, pinned SQLite backend."""

import argparse
import importlib
import importlib.metadata
import json
from pathlib import Path
import runpy
import sys


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--python-tools", required=True)
    parser.add_argument("checker_args", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    checker_args = args.checker_args
    if not checker_args or checker_args[0] != "--":
        parser.error("Pass the original check-isolated-state.py arguments after --")
    checker_args = checker_args[1:]
    tools = Path(args.python_tools).resolve(strict=True)
    sys.path.insert(0, str(tools))
    backend = importlib.import_module("pysqlite3")
    distribution = importlib.metadata.distribution("pysqlite3-binary")
    if distribution.version != "0.5.4.post2" or Path(distribution.locate_file("")).resolve() != tools:
        raise RuntimeError("Use pysqlite3-binary==0.5.4.post2 from the dedicated --python-tools target")
    if not Path(backend.__file__).resolve().is_relative_to(tools):
        raise RuntimeError("The SQLite module must come from the dedicated --python-tools target")
    if backend.sqlite_version_info != (3, 51, 1):
        raise RuntimeError(f"The pinned wheel must provide SQLite 3.51.1; actual={backend.sqlite_version}")
    checker = Path(__file__).with_name("check-isolated-state.py")
    print(json.dumps({"physicalSqliteBackend": {
        "backend": "pysqlite3", "distribution": "pysqlite3-binary",
        "distribution_version": distribution.version, "sqlite_version": backend.sqlite_version,
        "module_file": backend.__file__, "original_checker": str(checker),
        "expected_wheel_sha256": "b6162cd966fa563fe85b5372c3e61d11dd7903bd0f09cc185cb0a4c9125f4a0f",
    }}), flush=True)
    # Only this child uses the alternate DB-API implementation. The original
    # checker retains every SQL statement, assertion and receipt write.
    sys.modules["sqlite3"] = backend
    sys.modules["sqlite3.dbapi2"] = importlib.import_module("pysqlite3.dbapi2")
    sys.argv = [str(checker), *checker_args]
    runpy.run_path(str(checker), run_name="__main__")


if __name__ == "__main__":
    main()
