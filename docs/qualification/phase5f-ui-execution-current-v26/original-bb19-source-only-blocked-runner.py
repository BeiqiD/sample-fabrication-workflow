"""Run only the frozen combined six-stage plan after explicit parent GO.

Do not invoke during source-only review. No service/browser/remote operations.
All case budgets, assertions and arguments are those in the frozen plan.
"""
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import time

HEAD = "98d81a170394a140fb63e970b31d1985bd56f68d"
ROOT = Path("/workspace/remaining-5f-ui-execution-currente108-source-integration")
REVIEW = Path("/tmp/phase5f-ui-execution-currente108-source-reconciliation")
RUNTIME = Path("/tmp/phase5f-ui-execution-currente108-runtime-98d81a1-attempt1")
PLAN_SHA = "17c2984c99f3850074fc69cdcdaef1984c9ac6a4febdcd55e89d92d5c995ffd5"
SOURCE_SHA = "7e46f73ac538f30ef0dc59c8fe165fa2f675869f4fff1e9eddb2f980cd292b8b"


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def utc():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def git(*args):
    return subprocess.check_output(["git", *args], cwd=ROOT, text=True).strip()


def write(name, value):
    with (RUNTIME / name).open("x") as file:
        json.dump(value, file, indent=2)
        file.write("\n")


def group_members(group):
    members = []
    for process in Path("/proc").iterdir():
        if not process.name.isdecimal():
            continue
        try:
            stat = (process / "stat").read_text()
            fields = stat[stat.rfind(")") + 2 :].split()
            if int(fields[2]) != group:
                continue
            fds = list((process / "fd").iterdir())
            members.append({"pid": int(process.name), "state": fields[0], "openFdCount": len(fds)})
        except FileNotFoundError:
            continue
        except (PermissionError, ProcessLookupError):
            members.append({"pid": int(process.name), "state": "UNREADABLE_OWNED_MEMBER"})
    return members


def active_members(members):
    return [member for member in members if member["state"] not in {"Z", "X"} or member.get("openFdCount", 0)]


def close_owned_group(group):
    before = group_members(group)
    actions = []
    # Cleanup only the newly launched owned process group, never other owners.
    if active_members(before):
        for sig in [signal.SIGTERM, signal.SIGKILL]:
            try:
                os.killpg(group, sig)
                actions.append(signal.Signals(sig).name)
            except ProcessLookupError:
                break
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline and active_members(group_members(group)):
                time.sleep(0.1)
            if not active_members(group_members(group)):
                break
    after = group_members(group)
    return {"before": before, "after": after, "ownedCleanupSignals": actions,
            "noActiveOwnedProcessOrFd": not active_members(after),
            "unexpectedLingeringOwner": bool(active_members(before))}


def verify_source(source):
    assert git("rev-parse", "HEAD") == HEAD
    assert not git("status", "--porcelain")
    assert git("rev-parse", "HEAD^{tree}") == source["tree"]
    for path, digest in source["candidatePathHashes"].items():
        assert sha(ROOT / path) == digest, path
    for path, record in source["actualV26Delta"].items():
        assert sha(ROOT / path) == record["sha256"], path
    provenance = source["dependencyProvenance"]
    for path, digest in provenance["manifestHashes"].items():
        assert sha(ROOT / path) == sha(Path("/workspace/sample-fabrication-workflow") / path) == digest
    assert (ROOT / "node_modules").is_symlink()
    assert str((ROOT / "node_modules").resolve()) == provenance["nodeModulesRealRoot"]
    assert sha(ROOT / "node_modules/.package-lock.json") == provenance["hiddenLockSha256"]


assert sys.argv[1:] == ["--exclusive-go-exact-98d81a1-17c2984"], "Requires exact coordinator GO argument."
plan_path = REVIEW / "current-e108-ui-execution90-finite-affected-plan.json"
source_path = REVIEW / "current-e108-ui-execution90-source-reconciliation-receipt.json"
assert sha(plan_path) == PLAN_SHA and sha(source_path) == SOURCE_SHA
plan = json.loads(plan_path.read_bytes())
source = json.loads(source_path.read_bytes())
assert plan["head"] == source["head"] == HEAD and len(plan["commands"]) == 6
verify_source(source)
RUNTIME.mkdir(mode=0o700)
for name, original in [("frozen-approved-finite-plan.json", plan_path), ("source-reconciliation-receipt.json", source_path)]:
    with (RUNTIME / name).open("xb") as file:
        file.write(original.read_bytes())
write("exclusive-runtime-start.json", {"status": "STARTED", "head": HEAD, "tree": source["tree"],
      "startedAt": utc(), "runnerPid": os.getpid(), "planSha256": PLAN_SHA,
      "sourceReceiptSha256": SOURCE_SHA, "serviceBrowserProcessesStarted": 0, "remoteMutation": False})
print(json.dumps({"status": "STARTED", "head": HEAD, "runtime": str(RUNTIME)}), flush=True)
commands = []
first_failure = None
for index, step in enumerate(plan["commands"]):
    assert step["cwd"] == str(ROOT)
    log = RUNTIME / (step["stage"] + ".log")
    started = utc()
    with log.open("xb") as file:
        process = subprocess.Popen(step["argv"], cwd=ROOT, stdout=file, stderr=subprocess.STDOUT,
                                   env=os.environ.copy(), start_new_session=True)
        exit_code = process.wait()
    closure = close_owned_group(process.pid)
    item = {**step, "startedAt": started, "endedAt": utc(), "pid": process.pid,
            "processGroup": process.pid, "exitCode": exit_code, "log": str(log),
            "logSha256": sha(log), "ownedClosure": closure}
    if "expectedStaticCases" in step:
        plain = re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", log.read_text())
        item["actualSummaryLines"] = [line.strip() for line in plain.splitlines()
                                      if re.match(r"^\s*(Test Files|Tests)\s+", line)]
        match = re.search(r"^\s*Tests\s+(\d+) passed\s+\((\d+)\)", plain, re.MULTILINE)
        item["actualPassedCountMatchesFinitePlan"] = bool(match and int(match[1]) == int(match[2]) == step["expectedStaticCases"])
    failed = bool(exit_code or closure["unexpectedLingeringOwner"] or not closure["noActiveOwnedProcessOrFd"]
                  or item.get("actualPassedCountMatchesFinitePlan") is False)
    item["status"] = "FAILED" if failed else "PASS"
    write(step["stage"] + "-command.json", item)
    commands.append(item)
    print(json.dumps(item), flush=True)
    print(log.read_text()[-1600:], flush=True)
    if failed:
        first_failure = step["stage"]
        break
source_error = None
try:
    verify_source(source)
except Exception as error:
    source_error = repr(error)
final_groups = {str(item["processGroup"]): group_members(item["processGroup"]) for item in commands}
closed = all(not active_members(members) for members in final_groups.values())
receipt = {"kind": "phase5f-ui-execution-combined-six-stage-actual/1", "status": "PASS" if not first_failure and not source_error and closed else "FAIL",
           "sourceHead": HEAD, "sourceTree": source["tree"], "completedAt": utc(),
           "planSha256": PLAN_SHA, "sourceReceiptSha256": SOURCE_SHA, "commands": commands,
           "firstFailedStage": first_failure, "remainingUnrunStages": [step["stage"] for step in plan["commands"][len(commands):]],
           "sourcePinsRechecked": source_error is None, "sourcePostCheckError": source_error,
           "allOwnedGroupsFinal": final_groups, "noActiveOwnedProcessOrFd": closed,
           "serviceBrowserProcessesStarted": 0, "scope": "Only actual boundary/ownedstrict/clock6/mounted37/source38/freshbuild. Original case budgets and assertions unchanged. No old browser/performance rerun, fresh combined Execution12, complete own CI, provider or physical device claim.",
           "runtimeReleased": "Parent observes actual runner tool exit and this bounded owned closure before assigning another runner."}
write("finite-runtime-completion-receipt.json", receipt)
print(json.dumps({"status": receipt["status"], "receipt": str(RUNTIME / "finite-runtime-completion-receipt.json"),
                  "receiptSha256": sha(RUNTIME / "finite-runtime-completion-receipt.json"),
                  "firstFailedStage": first_failure, "remainingUnrunStages": receipt["remainingUnrunStages"]}), flush=True)
sys.exit(0 if receipt["status"] == "PASS" else 1)
