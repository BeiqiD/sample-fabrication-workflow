#!/usr/bin/env python3
"""Run the independent 200-node native case using existing isolated helpers."""

import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import time


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True)
    parser.add_argument("--root", required=True)
    parser.add_argument("--physical-python-tools", help="Hosted pinned pysqlite3-binary target for the original physical checker")
    args = parser.parse_args()
    source = Path(args.source).resolve(strict=True)
    root = Path(args.root).resolve(strict=True)
    qa = source / "scripts/qa/phase5f"
    copied = root / "copy"
    fixture = root / "fixture"
    env = {**os.environ, "WRANGLER_SEND_METRICS": "false",
           "WRANGLER_LOG_PATH": str(fixture / "wrangler-logs")}

    def run(stage, command, cwd=source, extra_env=None):
        print(f"{stage}: starting", flush=True)
        started = time.monotonic()
        result = subprocess.run(command, cwd=cwd, env={**env, **(extra_env or {})})
        print(f"{stage}: exit={result.returncode}, elapsed={time.monotonic() - started:.3f}s", flush=True)
        result.check_returncode()

    # Each helper retains its own original receipt and accepted writes. The
    # copy/generator create new roots and never reuse a previous namespace.
    run("copy", [sys.executable, str(qa / "prepare-isolated-copy.py"),
                 "--source-root", str(source), "--destination", str(copied)])
    run("templates", ["node", str(qa / "generate-process-fixture.mjs"), str(copied), str(fixture)])
    wrangler = ["node", str(copied / "node_modules/wrangler/bin/wrangler.js"), "d1"]
    local = ["DB", "--local", "--config", ".wrangler/deploy.jsonc", "--persist-to", str(copied / ".wrangler/state")]
    run("migrations", [*wrangler, "migrations", "apply", *local], cwd=copied)
    run("template SQL", [*wrangler, "execute", *local, "--file", str(fixture / "process-fixture.sql")], cwd=copied)
    physical_entry = [sys.executable, str(qa / "check-isolated-state.py")]
    if args.physical_python_tools:
        physical_entry = [sys.executable, str(qa / "check-isolated-state-modern-sqlite.py"),
                          "--python-tools", args.physical_python_tools, "--"]
    physical = [*physical_entry, "--source-copy", str(copied), "--fixture-directory", str(fixture), "--stage"]
    run("before API", [*physical, "before-api"])

    errors = []
    ready = False
    with (root / "server.log").open("xb") as output:
        server = subprocess.Popen(["node", str(qa / "start-built-server.mjs"), str(copied), str(fixture)],
                                  cwd=copied, env=env, stdin=subprocess.PIPE,
                                  stdout=output, stderr=subprocess.STDOUT, text=True)
        try:
            deadline = time.monotonic() + 90
            ready_path = fixture / "isolated-server-receipt.json"
            while True:
                if ready_path.exists():
                    try:
                        receipt = json.loads(ready_path.read_text())
                    except json.JSONDecodeError:
                        pass  # The original helper is still writing its file.
                    else:
                        if receipt["status"] != "ready":
                            raise RuntimeError("Worker published failed readiness; see server.log")
                        break
                if server.poll() is not None:
                    raise RuntimeError(f"Worker exited before readiness: {server.returncode}; see server.log")
                if time.monotonic() >= deadline:
                    raise RuntimeError("Worker did not publish readiness within 90s; see server.log")
                time.sleep(0.1)
            ready = True
            run("200-node API seed", ["node", str(qa / "seed-actual-api.mjs"),
                                      "http://127.0.0.1:4219/", str(fixture)],
                extra_env={"PHASE5F_PROJECT_NODE_COUNT": "200"})
            run("200-node native case", ["node", str(qa / "browser-actual-api.mjs"),
                                         "http://127.0.0.1:4219/", str(fixture), str(copied)],
                extra_env={"PHASE5F_CASE_ID": "project-large-1200-light"})
            summary = json.loads((fixture / "actual-api-browser-summary.json").read_text())
            if (summary["status"] != "passed" or summary["passedCount"] != 1
                    or summary["failedCount"] != 0 or not summary["browserClosed"]
                    or summary["requestedCaseIds"] != ["project-large-1200-light"]):
                raise RuntimeError("The original browser summary did not complete the selected native case")
        except BaseException as error:
            errors.append(error)
        finally:
            # Keep the original stdin owner in this process. On success and
            # failure, request the helper's awaited dispose rather than kill it.
            try:
                if server.poll() is None:
                    server.stdin.write("stop\n")
                    server.stdin.flush()
            except BaseException as error:
                errors.append(error)
            finally:
                try:
                    server.stdin.close()
                except BaseException as error:
                    errors.append(error)
            try:
                code = server.wait(timeout=60)
                if code != 0:
                    raise RuntimeError(f"Worker normal stop exited {code}; see server.log")
                closure = json.loads((fixture / "isolated-server-stop-receipt.json").read_text())
                if closure["status"] != "stopped" or not closure["disposalAwaited"] or not closure["portClosed"]:
                    raise RuntimeError("Worker did not confirm its original normal stop")
            except BaseException as error:
                errors.append(error)
            if ready and server.poll() is not None:
                try:
                    run("after normal stop", [*physical, "after-shutdown"])
                except BaseException as error:
                    errors.append(error)
    for error in errors:
        print(f"200-node qualification failed: {type(error).__name__}: {error}", file=sys.stderr)
    return 1 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
