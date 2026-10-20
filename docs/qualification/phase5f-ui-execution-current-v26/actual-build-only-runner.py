"""Run only the frozen one-build continuation after explicit parent GO.

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
RUNTIME = Path("/tmp/phase5f-ui-execution-currente108-build-only-98d81a1-attempt2")
PLAN_SHA = "c626b3001c9d2b2a238240884eb3c1c26be0296563f80f934ab3bbc94eba7444"
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
            member = {"pid": int(process.name), "state": fields[0],
                      "ppid": int(fields[1]), "processGroup": int(fields[2])}
            if fields[0] in {"Z", "X"}:
                member["kernelResourcesExited"] = True
            try:
                member["openFdCount"] = len(list((process / "fd").iterdir()))
            except PermissionError:
                # Preserve the genuine kernel state already read above.
                # Inaccessible FD metadata is not an observed zero FD count.
                member["fdInspection"] = "PermissionError"
            members.append(member)
        except FileNotFoundError:
            continue
        except (PermissionError, ProcessLookupError):
            members.append({"pid": int(process.name), "state": "UNREADABLE_PROCESS_STAT"})
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


class RunnerInterrupted(BaseException):
    pass


def interrupt_handler(signum, _frame):
    raise RunnerInterrupted("received " + signal.Signals(signum).name)


def close_and_reap(process):
    # A second SIGTERM/SIGINT cannot bypass cleanup of this owned child.
    previous = {sig: signal.getsignal(sig) for sig in (signal.SIGTERM, signal.SIGINT)}
    for sig in previous:
        signal.signal(sig, signal.SIG_IGN)
    try:
        closure = close_owned_group(process.pid)
        try:
            code = process.wait(timeout=5)
            closure["directChildExitCode"] = code
            closure["directChildReaped"] = True
        except subprocess.TimeoutExpired:
            closure["directChildExitCode"] = None
            closure["directChildReaped"] = False
        closure["afterDirectChildReap"] = group_members(process.pid)
        closure["noActiveOwnedProcessOrFd"] = not active_members(closure["afterDirectChildReap"])
        return closure
    finally:
        for sig, handler in previous.items():
            signal.signal(sig, handler)


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


assert sys.argv[1:] == ["--exclusive-go-exact-98d81a1-build-only-c626b30"], "Requires exact coordinator GO argument."
plan_path = REVIEW / "current-e108-ui-execution98-build-only-plan.json"
source_path = REVIEW / "current-e108-ui-execution90-source-reconciliation-receipt.json"
assert sha(plan_path) == PLAN_SHA and sha(source_path) == SOURCE_SHA
plan = json.loads(plan_path.read_bytes())
source = json.loads(source_path.read_bytes())
assert plan["head"] == source["head"] == HEAD and len(plan["commands"]) == 1
for evidence in [plan["priorImmutableWrapperFailure"], plan["actualPostFailureDiagnosis"], plan["independentRootOwnerReconciliation"]]:
    assert sha(Path(evidence["path"])) == evidence["sha256"]
for prior in plan["historicalFiveActualCommandCarry"]:
    assert prior["exitCode"] == 0 and prior["directChildReaped"]
    assert sha(Path(prior["log"])) == prior["logSha256"]
assert plan["commands"][0]["argv"] == ["npm", "run", "build"]
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
runner_error = None
source_error = None
active_process = None
active_item = None
signal.signal(signal.SIGTERM, interrupt_handler)
signal.signal(signal.SIGINT, interrupt_handler)
try:
    for index, step in enumerate(plan["commands"]):
        assert step["cwd"] == str(ROOT)
        log = RUNTIME / (step["stage"] + ".log")
        item = {**step, "startedAt": utc(), "status": "RUNNING", "log": str(log)}
        commands.append(item)
        active_item = item
        try:
            with log.open("xb") as file:
                # Defer supported termination while Popen returns ownership.
                # Callable handlers reset normally on child exec; no inherited
                # blocked/ignored signal mask is introduced.
                launch_signals = []
                launch_previous = {sig: signal.getsignal(sig) for sig in (signal.SIGTERM, signal.SIGINT)}
                for sig in launch_previous:
                    signal.signal(sig, lambda signum, _frame: launch_signals.append(signum))
                try:
                    active_process = subprocess.Popen(step["argv"], cwd=ROOT, stdout=file, stderr=subprocess.STDOUT,
                                                      env=os.environ.copy(), start_new_session=True)
                    item["pid"] = item["processGroup"] = active_process.pid
                finally:
                    for sig, handler in launch_previous.items():
                        signal.signal(sig, handler)
                if launch_signals:
                    raise RunnerInterrupted("received during launch: " + ", ".join(signal.Signals(sig).name for sig in launch_signals))
                item["exitCode"] = active_process.wait()
        finally:
            if active_process is not None:
                item["ownedClosure"] = close_and_reap(active_process)
                item.setdefault("exitCode", item["ownedClosure"]["directChildExitCode"])
                active_process = None
        item["endedAt"] = utc()
        item["logSha256"] = sha(log)
        closure = item["ownedClosure"]
        if "expectedStaticCases" in step:
            plain = re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", log.read_text())
            item["actualSummaryLines"] = [line.strip() for line in plain.splitlines()
                                          if re.match(r"^\s*(Test Files|Tests)\s+", line)]
            match = re.search(r"^\s*Tests\s+(\d+) passed\s+\((\d+)\)", plain, re.MULTILINE)
            item["actualPassedCountMatchesFinitePlan"] = bool(match and int(match[1]) == int(match[2]) == step["expectedStaticCases"])
        failed = bool(item["exitCode"] or closure["unexpectedLingeringOwner"] or not closure["noActiveOwnedProcessOrFd"]
                      or not closure["directChildReaped"] or item.get("actualPassedCountMatchesFinitePlan") is False)
        item["status"] = "FAILED" if failed else "PASS"
        write(step["stage"] + "-command.json", item)
        print(json.dumps(item), flush=True)
        print(log.read_text()[-1600:], flush=True)
        active_item = None
        if failed:
            first_failure = step["stage"]
            break
except BaseException as error:
    runner_error = {"kind": type(error).__name__, "message": str(error), "at": utc()}
    first_failure = active_item["stage"] if active_item is not None else "runner-between-stages"
    if active_item is not None:
        active_item["status"] = "INTERRUPTED" if isinstance(error, (RunnerInterrupted, KeyboardInterrupt)) else "FAILED"
        active_item["runnerError"] = runner_error
        active_item["endedAt"] = utc()
        log = Path(active_item["log"])
        if log.is_file():
            active_item["logSha256"] = sha(log)
finally:
    # Covers wait/log/unexpected exceptions and supported termination signals.
    # Only the direct child started above and its original group may be closed.
    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, signal.SIG_IGN)
    if active_process is not None:
        closure = close_and_reap(active_process)
        if active_item is not None:
            active_item["ownedClosure"] = closure
            active_item.setdefault("exitCode", closure["directChildExitCode"])
        active_process = None
    try:
        verify_source(source)
    except BaseException as error:
        source_error = repr(error)
    final_groups = {str(item["processGroup"]): group_members(item["processGroup"])
                    for item in commands if "processGroup" in item}
    closed = all(not active_members(members) for members in final_groups.values())
    reaped = all(item.get("ownedClosure", {}).get("directChildReaped", False)
                 for item in commands if "processGroup" in item)
    receipt = {"kind": "phase5f-ui-execution-combined-build-only-continuation-actual/1",
               "status": "PASS" if not first_failure and not runner_error and not source_error and closed and reaped else "FAIL",
               "sourceHead": HEAD, "sourceTree": source["tree"], "completedAt": utc(),
               "planSha256": PLAN_SHA, "sourceReceiptSha256": SOURCE_SHA, "commands": commands,
               "firstFailedStage": first_failure, "runnerError": runner_error,
               "remainingUnrunStages": [step["stage"] for step in plan["commands"][len(commands):]],
               "sourcePinsRechecked": source_error is None, "sourcePostCheckError": source_error,
               "allOwnedGroupsFinal": final_groups, "allDirectChildrenActuallyReaped": reaped,
               "noActiveOwnedProcessOrFd": closed, "serviceBrowserProcessesStarted": 0,
               "scope": "Only actual fresh npm run build. Previous five actual command passes carry original98d attempt1 and independent root owner reconciliation; first wrapperFAIL remains immutable. No tests rerun, fresh combined browser/Execution12, complete own CI, provider or physical device claim.",
               "priorWrapperFailure": plan["priorImmutableWrapperFailure"],
               "rootOwnerReconciliation": plan["independentRootOwnerReconciliation"],
               "runtimeReleased": "Parent observes actual runner tool exit and bounded owned closure before assigning another runner; any interrupted stage is unqualified."}
    if runner_error is not None:
        write("runner-interruption-or-exception.json", {"error": runner_error, "firstFailedStage": first_failure,
              "partialCommands": commands, "remainingUnrunStages": receipt["remainingUnrunStages"]})
    write("finite-runtime-completion-receipt.json", receipt)
print(json.dumps({"status": receipt["status"], "receipt": str(RUNTIME / "finite-runtime-completion-receipt.json"),
                  "receiptSha256": sha(RUNTIME / "finite-runtime-completion-receipt.json"),
                  "firstFailedStage": first_failure, "remainingUnrunStages": receipt["remainingUnrunStages"]}), flush=True)
sys.exit(0 if receipt["status"] == "PASS" else 1)
