#!/usr/bin/env python3
"""Physical copies only, after the genuine two-local-R2 helper's original exit.

The existing physical reader functions are loaded from the byte-pinned copied
source. This does not invent the disabled seed-server lifecycle that this
fixture deliberately never starts, nor qualify a failed native browser case.
"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import socket
import stat


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--domain", required=True, choices=["storage", "package"])
    parser.add_argument("--source-copy", required=True)
    parser.add_argument("--fixture-directory", required=True)
    parser.add_argument("--runtime-directory", required=True)
    args = parser.parse_args()
    domain = args.domain
    stem = "genuine-storage-settings-refresh-keyboard" if domain == "storage" else "genuine-package-status-refresh-keyboard"
    stage = "original-one-current-storage-settings-refresh-keyboard" if domain == "storage" else "original-one-current-package-status-refresh-keyboard"
    browser_name = "browser-current-coherent-storage-settings-refresh-keyboard.mjs" if domain == "storage" else "browser-current-package-file-focus-package-status-refresh-keyboard-mobile.mjs"
    permit = "--exclusive-go-one-current-coherent-storage-settings-refresh-keyboard" if domain == "storage" else "--exclusive-go-one-current-coherent-package-status-refresh-keyboard"
    source = Path(args.source_copy).absolute()
    # Validate without importing any unpinned source or executing its main.
    helper = source / "scripts/qa/phase5f/check-isolated-state.py"
    for component in (helper, *helper.parents):
        if component.is_symlink():
            raise ValueError("Physical reader source must not traverse symlinks.")
    isolation_path = source / "isolation-receipt.json"
    isolation = json.loads(isolation_path.read_text())
    expected = isolation["trackedFiles"]["scripts/qa/phase5f/check-isolated-state.py"]
    if hashlib.sha256(helper.read_bytes()).hexdigest() != expected:
        raise ValueError("The original physical reader is not byte-pinned.")
    specification = importlib.util.spec_from_file_location("original_two_r2_physical_reader", helper)
    common = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(common)
    source = common.canonical_temporary_directory(args.source_copy)
    fixture = common.canonical_temporary_directory(args.fixture_directory)
    runtime = common.canonical_temporary_directory(args.runtime_directory)
    common.require(len({source, fixture, runtime}) == 3, "Three distinct private roots are required.")
    common.require(all(not left.is_relative_to(right) for left in (source, fixture, runtime)
                       for right in (source, fixture, runtime) if left != right), "Private roots must not contain each other.")
    isolation_hash = common.sha256(isolation_path)
    manifest_path = common.regular_file(fixture, "process-fixture.json")
    manifest = common.read_json(fixture, "process-fixture.json")
    common.require(isolation["sourceHead"] == "2d07b57c4e79403099261528ae8988c0072d28c6"
                   and isolation["copiedState"] is False and isolation["sourceCopyRoot"] == str(source)
                   and manifest["sourceCopyRoot"] == str(source) and manifest["fixtureDirectory"] == str(fixture)
                   and manifest["sourceHead"] == isolation["sourceHead"]
                   and manifest["isolationReceiptSha256"] == isolation_hash
                   and common.sha256(common.regular_file(fixture, "process-fixture.sql")) == manifest["sqlSha256"],
                   "Original copied source and pure metadata manifest must match.")
    dependency = Path(isolation["nodeModulesRoot"])
    common.require(dependency.is_dir() and dependency.resolve(strict=True) == dependency
                   and (source / "node_modules").is_symlink()
                   and (source / "node_modules").resolve(strict=True) == dependency, "Original installed alias changed.")
    common.inspect_tree(source, allowed_dependency=dependency)
    common.inspect_tree(fixture)
    copied = {**isolation["trackedFiles"], **isolation["copiedArtifactFiles"]}
    common.require(all(common.sha256(common.regular_file(source, name)) == value for name, value in copied.items()),
                   "Original copied source or artifacts changed.")
    migrations = [{"name": p.name, "sha256": common.sha256(p)} for p in sorted((source / "migrations").glob("*.sql"))]
    common.require(migrations == isolation["migrationFiles"] and len(migrations) == 24,
                   "Exactly the original current24 migration bytes are required.")
    command_path = common.regular_file(runtime, stage + "-command.json")
    command = common.read_json(runtime, command_path.name)
    closed = command["ownedClosure"]
    common.require(command["stage"] == stage
                   and closed["directChildReaped"] is True and closed["directChildExitCode"] == command["exitCode"]
                   and closed["noActiveOwnedProcessOrFd"] is True and not closed["unexpectedLingeringOwner"]
                   and not closed["ownedCleanupSignals"], "Await the original supervised child exit; do not kill it to qualify cleanup.")
    receipt_path = fixture / ("physical-sqlite-after-current-" + domain + "-status-refresh-keyboard.json")
    common.require(not receipt_path.exists() and not receipt_path.is_symlink(), "Preserve every previous physical receipt.")
    receipt = {"version": 1, "status": "failed", "sourceHead": isolation["sourceHead"], "sourceCopyRoot": str(source),
               "fixtureDirectory": str(fixture), "isolationReceiptSha256": isolation_hash,
               "helperSha256": common.sha256(Path(__file__).resolve()), "originalPhysicalReaderSha256": expected,
               "originalNativeCommandSha256": common.sha256(command_path), "nativeCommandStatus": command["status"],
               "results": {}, "scope": "Byte-identical private physical SQLite/WAL/SHM copies only. Genuine Access/two-R2 original lifecycle; no disabled seed server, production/provider qualification or failed-browser waiver."}
    failure = None
    try:
        receipt["originalChildQuiescence"] = common.dead_pid(command["pid"])
        receipt["loopbackQuiescence"] = common.port_refused()
        report_path = fixture / (stem + "-report.json")
        report = None
        if report_path.exists():
            report = common.read_json(fixture, report_path.name)
            stop_path = common.regular_file(fixture, stem + "-stop.json")
            browser_helper = Path(__file__).resolve().parent / browser_name
            common.require(report["sessionPid"] == command["pid"] and report["sourceHead"] == isolation["sourceHead"]
                           and report["helperSha256"] == common.sha256(browser_helper)
                           and command["argv"] == ["node", str(browser_helper), str(source), str(fixture), isolation["sourceHead"],
                                                   permit]
                           and report["sourceCopyRoot"] == str(source) and report["fixtureDirectory"] == str(fixture)
                           and report["isolationReceiptSha256"] == isolation_hash
                           and common.read_json(fixture, stop_path.name) == report["ownedClosure"], "Original report/closure must bind this child and physical fixture.")
            receipt["nativeReportSha256"] = common.sha256(report_path)
            receipt["nativeStopSha256"] = common.sha256(stop_path)
            receipt["nativeCaseStatus"] = report["status"]
            receipt["normalOwnerClosureObserved"] = report["ownedClosure"]["status"] == "closed"
            prepared = report.get("genuinePreparation")
            if prepared and prepared.get("jwksOwner"):
                jwks = prepared["jwksOwner"]
                common.require(jwks["host"] == "127.0.0.1" and isinstance(jwks["port"], int)
                               and 0 < jwks["port"] < 65536, "Original local JWKS owner has invalid coordinates.")
                connection = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
                connection.settimeout(1.0)
                try:
                    result = connection.connect_ex((jwks["host"], jwks["port"]))
                finally:
                    connection.close()
                import errno
                common.require(result == errno.ECONNREFUSED, "Original JWKS port must refuse connections.")
                receipt["jwksPortRefused"] = True
        else:
            receipt["nativeReportObserved"] = False
            receipt["scope"] += " Original child is reaped, but no application lifecycle report was created; physical cleanup does not qualify any browser case or normal finally."
        state = source / ".wrangler/state/v3"
        receipt["originalStateQuiescenceBeforeCopy"] = common.no_open_state_files(state)
        files = common.inspect_tree(state)
        state_hashes = {p.relative_to(source).as_posix(): common.sha256(p) for p in files}
        databases = [p for p in files if p.suffix == ".sqlite"]
        common.require(databases and any(p.is_relative_to(state / "d1") for p in databases), "Actual isolated D1 state is required.")
        paths, receipt["physicalSnapshot"] = common.snapshot_sqlite_files(state, fixture, "after-current-" + domain + "-status-refresh-keyboard", source, databases, state_hashes)
        receipt["originalStateInputSha256"] = state_hashes
        for p in databases:
            receipt["results"][p.relative_to(source).as_posix()] = common.diagnose(paths[p], manifest, [m["name"] for m in migrations])
        applications = [value for value in receipt["results"].values() if "templateSentinels" in value]
        common.require(len(applications) == 1, "Exactly one current24 application with the original pure sentinels is required.")
        before = common.read_json(fixture, "physical-sqlite-before-api.json")
        original_application = next(value for value in before["results"].values() if "templateSentinels" in value)
        common.require(before["status"] == "passed" and applications[0]["schemaSha256"] == original_application["schemaSha256"],
                       "Application schema must stay byte-pinned through real activation/upload/preview.")
        blobs = {p.relative_to(source).as_posix(): {"bytes": p.stat().st_size, "sha256": common.sha256(p)}
                 for p in files if p.is_relative_to(state / "r2") and "blobs" in p.relative_to(state).parts}
        receipt["physicalObjectReceipts"] = blobs
        if report and report.get("genuinePreparation", {}).get("sourceFile"):
            source_file = report["genuinePreparation"]["sourceFile"]
            common.require(any(value["bytes"] == source_file["byteSize"] and value["sha256"] == source_file["sha256"]
                               for value in blobs.values()), "The actual native upload PNG must exist in original physical R2 state.")
            receipt["genuineUploadPhysicalPNGMatched"] = True
        common.require(state_hashes == {p.relative_to(source).as_posix(): common.sha256(p) for p in common.inspect_tree(state)},
                       "Original physical bytes changed during private snapshot reads.")
        receipt["originalStateBytesUnchanged"] = True
        receipt["originalStateQuiescenceAfterReads"] = common.no_open_state_files(state)
        common.dead_pid(command["pid"])
        common.port_refused()
        common.require(common.sha256(command_path) == receipt["originalNativeCommandSha256"]
                       and common.sha256(isolation_path) == isolation_hash
                       and all(common.sha256(common.regular_file(source, name)) == value for name, value in copied.items()),
                       "Original command/source/artifact evidence changed during physical reads.")
        if report:
            common.require(common.sha256(report_path) == receipt["nativeReportSha256"]
                           and common.sha256(stop_path) == receipt["nativeStopSha256"], "Original native records changed during physical reads.")
        receipt["status"] = "passed"
    except (ValueError, OSError, KeyError, TypeError, StopIteration, common.sqlite3.Error) as error:
        failure = error
        receipt["error"] = str(error)
    with receipt_path.open("x", encoding="utf8") as stream:
        os.chmod(receipt_path, stat.S_IRUSR | stat.S_IWUSR)
        json.dump(receipt, stream, indent=2)
        stream.write("\n")
    print(json.dumps({"receipt": str(receipt_path), "status": receipt["status"], "error": receipt.get("error")}))
    if failure:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
