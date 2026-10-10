#!/usr/bin/env python3
"""Record read-only physical diagnostics of a stopped private synthetic fixture.

This is a physical SQLite check, not a D1 API PRAGMA qualification. It does not
stop processes, fix state, checkpoint databases, or overwrite earlier evidence.
"""

import argparse
import errno
import hashlib
import json
import os
from pathlib import Path
import socket
import sqlite3
import stat
import tempfile
import urllib.parse
import uuid


def require(condition, message):
    if not condition:
        raise ValueError(message)


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def canonical_temporary_directory(value):
    alias = Path(tempfile.gettempdir()).absolute()
    root = alias.resolve(strict=True)
    path = Path(value).expanduser().absolute()
    require(".." not in path.parts, "Private roots must not contain parent traversal.")
    if path.is_relative_to(alias):
        path = root / path.relative_to(alias)
    require(path != root and path.is_relative_to(root), "Only directories below OS temporary storage are supported.")
    for component in (path, *path.parents):
        require(not component.is_symlink(), "Private paths must not traverse symlinks.")
    require(path.resolve(strict=True) == path and path.is_dir(), "Expected a canonical existing directory.")
    require(stat.S_IMODE(path.stat().st_mode) == 0o700, "Private roots must have mode 0700.")
    return path


def regular_file(root, value):
    relative = Path(value)
    require(value and not relative.is_absolute() and ".." not in relative.parts,
            "Receipt file paths must be relative and contained.")
    path = root / relative
    for component in (path, *path.parents):
        require(not component.is_symlink(), "Receipt and state files must not traverse symlinks.")
    require(path.is_file() and path.resolve(strict=True).is_relative_to(root), "Expected a contained regular file.")
    return path


def read_json(root, relative):
    return json.loads(regular_file(root, relative).read_text(encoding="utf-8"))


def inspect_tree(root, allowed_dependency=None):
    require(root.is_dir() and not root.is_symlink() and root.resolve(strict=True) == root,
            "Inspected trees must remain canonical directories.")
    files = []
    for parent, directories, names in os.walk(root, followlinks=False):
        for name in directories + names:
            path = Path(parent) / name
            if path.is_symlink():
                require(allowed_dependency is not None and path == root / "node_modules"
                        and path.resolve(strict=True) == allowed_dependency,
                        "Unexpected symlink in the isolated copy or fixture.")
            elif path.is_file():
                files.append(path)
            else:
                require(path.is_dir(), "Only regular files and directories are supported.")
    return sorted(files)


def port_refused():
    connection = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    connection.settimeout(1.0)
    try:
        result = connection.connect_ex(("127.0.0.1", 4219))
    finally:
        connection.close()
    require(result == errno.ECONNREFUSED,
            "Loopback port 4219 must refuse connections; timeout or an open port is not quiescence.")
    return {"host": "127.0.0.1", "port": 4219, "connection": "refused"}


def dead_pid(value):
    require(isinstance(value, int) and not isinstance(value, bool) and value > 0,
            "Recorded server session PID must be a positive integer.")
    try:
        os.kill(value, 0)
    except ProcessLookupError:
        return {"sessionPid": value, "process": "absent"}
    except PermissionError as error:
        raise ValueError("Recorded server PID cannot be inspected; quiescence is unproven.") from error
    raise ValueError("Recorded server session PID is still live; wait for its exit, without killing automatically.")


def quoted(identifier):
    return '"' + identifier.replace('"', '""') + '"'


def diagnose(path, manifest, migration_names):
    uri = "file:" + urllib.parse.quote(str(path), safe="/") + "?mode=ro"
    database = sqlite3.connect(uri, uri=True)
    try:
        database.execute("PRAGMA query_only=ON")
        database.execute("BEGIN")
        quick = database.execute("PRAGMA quick_check").fetchall()
        foreign_keys = database.execute("PRAGMA foreign_key_check").fetchall()
        require(quick == [("ok",)] and not foreign_keys,
                "Physical SQLite integrity checks failed; preserve and inspect the fixture.")
        schema = database.execute("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name").fetchall()
        tables = {name for kind, name, _, _ in schema if kind == "table"}
        counts = {name: database.execute("SELECT count(*) FROM " + quoted(name)).fetchone()[0]
                  for name in sorted(tables)}
        result = {
            "quickCheck": quick, "foreignKeyCheck": foreign_keys,
            "schemaSha256": hashlib.sha256(json.dumps(schema, separators=(",", ":")).encode()).hexdigest(),
            "tableCounts": counts,
        }
        if "d1_migrations" in tables:
            names = [row[0] for row in database.execute("SELECT name FROM d1_migrations ORDER BY name")]
            require(names == migration_names, "Applied migration names must exactly match ordered code-owned SQL.")
            result["migrationNames"] = names
        if "template_versions" in tables:
            sentinels = []
            for identifier, version in ((manifest["ids"]["v1"], 1), (manifest["ids"]["v2"], 2)):
                rows = database.execute(
                    "SELECT id,name,version,initial_state_hash FROM template_versions WHERE id=?", [identifier]
                ).fetchall()
                expected = (identifier, manifest["familyName"], version, manifest["initialStateHash"])
                require(rows == [expected], "Physically applied random template sentinel does not match its manifest.")
                sentinels.append({"id": identifier, "version": version, "initialStateHash": rows[0][3]})
            result["templateSentinels"] = sentinels
        return result
    finally:
        database.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-copy", required=True)
    parser.add_argument("--fixture-directory", required=True)
    parser.add_argument("--stage", required=True, choices=["before-api", "after-shutdown"])
    args = parser.parse_args()
    source = canonical_temporary_directory(args.source_copy)
    fixture = canonical_temporary_directory(args.fixture_directory)
    require(not source.is_relative_to(fixture) and not fixture.is_relative_to(source),
            "Source copy and fixture evidence must be separate private roots.")
    isolation_path = regular_file(source, "isolation-receipt.json")
    isolation = read_json(source, "isolation-receipt.json")
    manifest_path = regular_file(fixture, "process-fixture.json")
    manifest = read_json(fixture, "process-fixture.json")
    isolation_hash = sha256(isolation_path)
    manifest_hash = sha256(manifest_path)
    require(isolation.get("copiedState") is False and isolation.get("sourceCopyRoot") == str(source),
            "Diagnostics require the exact fresh-state isolation receipt.")
    require(manifest.get("sourceCopyRoot") == str(source)
            and manifest.get("sourceHead") == isolation.get("sourceHead")
            and manifest.get("isolationReceiptSha256") == isolation_hash
            and manifest.get("loopbackPort") == 4219,
            "Fixture manifest must match this isolated source and receipt hash.")
    require(sha256(regular_file(fixture, "process-fixture.sql")) == manifest.get("sqlSha256"),
            "Synthetic SQL must match the immutable fixture manifest.")
    dependency = Path(isolation["nodeModulesRoot"])
    require(dependency.is_absolute() and dependency.resolve(strict=True) == dependency and dependency.is_dir(),
            "Shared dependency root must remain canonical and present.")
    require((source / "node_modules").is_symlink()
            and (source / "node_modules").resolve(strict=True) == dependency,
            "The single shared-dependency symlink must match its isolation receipt.")
    inspect_tree(source, allowed_dependency=dependency)
    inspect_tree(fixture)
    copied_hashes = {**isolation["trackedFiles"], **isolation["copiedArtifactFiles"]}
    for relative, expected in copied_hashes.items():
        require(sha256(regular_file(source, relative)) == expected,
                "Copied source or build artifact bytes changed since isolation.")
    migration_paths = sorted((source / "migrations").glob("*.sql"))
    migrations = [{"name": path.name, "sha256": sha256(regular_file(source, path.relative_to(source).as_posix()))}
                  for path in migration_paths]
    require(migrations and migrations == isolation.get("migrationFiles"),
            "Current copied migrations must match the ordered code-owned hashes.")
    migration_names = [entry["name"] for entry in migrations]
    receipt_path = fixture / ("physical-sqlite-" + args.stage + ".json")
    require(not receipt_path.exists() and not receipt_path.is_symlink(),
            "Physical diagnostic receipt already exists; preserve original evidence.")
    receipt = {
        "version": 2, "status": "failed", "stage": args.stage,
        "sourceRoot": isolation["sourceRoot"], "sourceCopyRoot": str(source),
        "fixtureDirectory": str(fixture), "sourceHead": isolation["sourceHead"], "copiedState": False,
        "isolationReceiptSha256": isolation_hash, "fixtureManifestSha256": manifest_hash,
        "helperSha256": sha256(Path(__file__).resolve()), "results": {},
        "scope": "Read-only quiescent physical isolated SQLite diagnostics; not D1 API PRAGMA, remote Access or provider qualification.",
    }
    failure = None
    try:
        if args.stage == "before-api":
            forbidden = ["isolated-server-session.json", "isolated-server-receipt.json",
                         "isolated-server-stop-receipt.json", "actual-api-fixture-receipt.json"]
            require(not any((fixture / name).exists() or (fixture / name).is_symlink() for name in forbidden),
                    "before-api must precede every server session and API seed receipt.")
        else:
            session = read_json(fixture, "isolated-server-session.json")
            server = read_json(fixture, "isolated-server-receipt.json")
            stopped = read_json(fixture, "isolated-server-stop-receipt.json")
            session_id = session.get("sessionId")
            require(isinstance(session_id, str) and str(uuid.UUID(session_id)) == session_id,
                    "Server session ID must be a canonical UUID.")
            for item in (session, server, stopped):
                require(item.get("sessionId") == session_id
                        and item.get("sessionPid") == session.get("sessionPid")
                        and item.get("sourceRoot") == isolation["sourceRoot"]
                        and item.get("sourceCopyRoot") == str(source)
                        and item.get("fixtureDirectory") == str(fixture)
                        and item.get("isolationReceiptSha256") == isolation_hash
                        and item.get("fixtureManifestSha256") == manifest_hash,
                        "Server lifecycle receipts must bind the same session, roots and hashes.")
            require(server.get("status") == "ready" and stopped.get("status") == "stopped",
                    "A ready service and separately recorded awaited stop are required.")
            receipt["sessionId"] = session_id
            receipt["serverReceiptSha256"] = sha256(regular_file(fixture, "isolated-server-receipt.json"))
            receipt["stopReceiptSha256"] = sha256(regular_file(fixture, "isolated-server-stop-receipt.json"))
            receipt["processQuiescence"] = dead_pid(session["sessionPid"])
        receipt["loopbackQuiescence"] = port_refused()
        state = source / ".wrangler/state/v3"
        require(state.is_dir() and not state.is_symlink(), "Expected isolated physical D1/R2 state.")
        state_files = inspect_tree(state)
        state_hashes = {path.relative_to(source).as_posix(): sha256(path) for path in state_files}
        sqlite_paths = [path for path in state_files if path.suffix == ".sqlite"]
        require(sqlite_paths, "No isolated SQLite files found.")
        receipt["physicalSqliteCategories"] = {
            "d1": sum(path.is_relative_to(state / "d1") for path in sqlite_paths),
            "r2": sum(path.is_relative_to(state / "r2") for path in sqlite_paths),
        }
        require(receipt["physicalSqliteCategories"]["d1"] >= 1,
                "Physical diagnostics require at least one isolated D1 SQLite file.")
        for path in sqlite_paths:
            relative = path.relative_to(source).as_posix()
            try:
                receipt["results"][relative] = diagnose(path, manifest, migration_names)
            except (ValueError, OSError, sqlite3.Error, KeyError, TypeError) as error:
                receipt["results"][relative] = {"error": str(error)}
                raise
        diagnoses = list(receipt["results"].values())
        require(sum("migrationNames" in result for result in diagnoses) == 1
                and sum("templateSentinels" in result for result in diagnoses) == 1,
                "Exactly one isolated migrated application database with sentinel templates is required.")
        if args.stage == "before-api":
            application = next(result for result in diagnoses if "templateSentinels" in result)
            require(application["tableCounts"].get("samples") == 0
                    and application["tableCounts"].get("projects") == 0
                    and application["tableCounts"].get("runs") == 0,
                    "before-api must contain only SQL fixtures, without seeded application owners.")
            receipt["scope"] += " Applied synthetic template SQL and migrations checked before API writes."
        else:
            blobs = {path.relative_to(source).as_posix(): {"byteSize": path.stat().st_size, "sha256": sha256(path)}
                     for path in state_files if path.is_relative_to(state / "r2") and "blobs" in path.relative_to(state).parts}
            receipt["objectBlobByteReceipts"] = blobs
            seed_path = fixture / "actual-api-fixture-receipt.json"
            if seed_path.exists():
                seed = read_json(fixture, "actual-api-fixture-receipt.json")
                require(seed.get("status") == "prepared" and seed.get("sourceRoot") == isolation["sourceRoot"]
                        and seed.get("sourceCopyRoot") == str(source) and seed.get("fixtureDirectory") == str(fixture)
                        and seed.get("sourceHead") == isolation["sourceHead"]
                        and seed.get("isolationReceiptSha256") == isolation_hash
                        and seed.get("fixtureManifestSha256") == manifest_hash
                        and seed.get("sessionId") == receipt["sessionId"],
                        "Prepared API seed must match the isolated session and evidence hashes.")
                project = seed["project"]
                require(any(blob["sha256"] == project["attachmentSha256"]
                            and blob["byteSize"] == project["attachmentByteSize"] for blob in blobs.values()),
                        "Physical object bytes do not match the actual API attachment receipt.")
                require(any(path.is_relative_to(state / "r2") for path in sqlite_paths),
                        "Seeded attachment proof requires physical R2 SQLite diagnostics.")
                receipt["seedReceiptSha256"] = sha256(regular_file(fixture, "actual-api-fixture-receipt.json"))
                receipt["seededProjectAttachmentPhysicalBytesMatched"] = True
            else:
                receipt["seededProjectAttachmentPhysicalBytesMatched"] = False
                receipt["scope"] += " Start/stop lifecycle only: no API seed or attachment byte proof."
        require(state_hashes == {path.relative_to(source).as_posix(): sha256(path) for path in inspect_tree(state)},
                "Physical state bytes changed during diagnostics; read-only quiescence is unproven.")
        port_refused()
        if args.stage == "after-shutdown":
            dead_pid(session["sessionPid"])
        require(sha256(isolation_path) == isolation_hash and sha256(manifest_path) == manifest_hash,
                "Isolation or fixture evidence changed during diagnostics.")
        require(all(sha256(regular_file(source, relative)) == expected
                    for relative, expected in copied_hashes.items()),
                "Copied source or build artifact bytes changed during diagnostics.")
        if args.stage == "after-shutdown":
            require(sha256(regular_file(fixture, "isolated-server-receipt.json")) == receipt["serverReceiptSha256"]
                    and sha256(regular_file(fixture, "isolated-server-stop-receipt.json")) == receipt["stopReceiptSha256"],
                    "Server lifecycle evidence changed during diagnostics.")
            if "seedReceiptSha256" in receipt:
                require(sha256(regular_file(fixture, "actual-api-fixture-receipt.json")) == receipt["seedReceiptSha256"],
                        "API seed evidence changed during diagnostics.")
        receipt["status"] = "passed"
    except (ValueError, OSError, sqlite3.Error, KeyError, TypeError) as error:
        failure = error
        receipt["error"] = str(error)
    # Exclusive creation retains the original failed attempt as well as passes.
    with receipt_path.open("x", encoding="utf-8") as output:
        json.dump(receipt, output, indent=2)
        output.write("\n")
    print(json.dumps({"receipt": str(receipt_path), "status": receipt["status"],
                      "sqliteFiles": len(receipt["results"]), "error": receipt.get("error")}))
    if failure is not None:
        raise SystemExit(1)


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, sqlite3.Error, KeyError, TypeError) as error:
        raise SystemExit(str(error)) from error
