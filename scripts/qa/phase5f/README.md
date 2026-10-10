# Phase 5F isolated actual API qualification

These staged helpers reproduce the finite local Chromium matrix with fresh synthetic owners. They use the production Worker and route chunks, actual local D1/R2 requests, and the supported UI. They never deploy, log in, install dependencies, copy existing database state, or modify the source installation. `AUTH_MODE=disabled` deliberately proves system administrator denial; it cannot qualify Cloudflare Access or authenticated administrator operations.

The predecessor `/tmp` helpers qualified source `af8f374` (20 browser cases and two Metrology pending cases). Those receipts remain historical evidence. The adopted helpers below add portable paths, immutable receipts, lifecycle control, and a named search-input check. The adopted pipeline passed a fresh committed build at `c06cb71`: all 20 matrix cases, both named Metrology cases, awaited stop and final physical SQLite/PNG checks. See [current receipts](../../../docs/PHASE_5F_CURRENT_BROWSER_ACCEPTANCE.md) and [the historical acceptance record](../../../docs/PHASE_5F_INTEGRATED_BROWSER_ACCEPTANCE.md) for exact identities and limits. Later application/helper changes require their own qualification; syntax checks alone do not qualify them.

## Prerequisites and boundaries

Use a clean, reviewed committed checkout and its freshly completed local build (`npm run build`). The normal local configuration must already exist. The helpers require its sole dummy D1 binding, sole local R2 binding, `local-r2` namespace, and matching installation identity; they reject remote bindings. Building is a separate developer action and does not imply authorization to run provider migrations or deploy.

Python 3, Node, repository-installed esbuild/Wrangler/Miniflare, an already installed Playwright module, and a Chromium executable are needed. No helper downloads missing dependencies. Set `PLAYWRIGHT_MODULE_PATH` only when Playwright is not resolvable from the repository, and set `CHROMIUM_PATH` to the available executable. No automatic browser CI job is added.

Choose **new, nonexistent** copy and fixture directories directly below the OS temporary directory. Existing private parent directories are supported. Each root must be owned by the current user and private (0700 on POSIX); descendant symlinks are rejected. The one attested read-only dependency reference is the copied `node_modules` symlink. The copy excludes Git metadata, credentials and existing Wrangler state. The helpers accept the OS temporary-directory alias and its canonical path, rather than assuming `/tmp` on every machine.

The isolation receipt pins committed source/tree hashes, every copied tracked file, selected artifact bytes and exact ordered SQL migration names/hashes. It does **not** establish independent build-to-HEAD provenance: the build currently contains no source-HEAD attestation. Perform and record the fresh build before copying. Helpers subsequently verify byte identity, local configuration, random template sentinels and Step 0, immutable live-server identity, and fixed loopback port **4219** before accepted writes.

## Independent stages

Run each stage separately and inspect its exit status/receipt before continuing. The snippets use shell variables solely for paths, and do not form an unverified all-in-one wrapper. Replace the two unique destination names before each new run.

```sh
qa_root="$PWD/scripts/qa/phase5f"
qa_temp="$(python3 -c 'import tempfile; print(tempfile.gettempdir())')"
qa_copy="$qa_temp/phase5f-copy-UNIQUE"
qa_fixture="$qa_temp/phase5f-fixture-UNIQUE"
```

1. Copy the clean committed source and current artifact. This creates the first private root and an exclusive `isolation-receipt.json`; it does not create state or start a service.

```sh
python3 "$qa_root/prepare-isolated-copy.py" --source-root "$PWD" --destination "$qa_copy"
```

2. Generate valid hashed synthetic process templates in a fresh fixture root. Shared application code computes Step 0, definition and manifest hashes. This writes SQL and a manifest only; it never fabricates Samples, Runs or accepted plan revisions.

```sh
node "$qa_root/generate-process-fixture.mjs" "$qa_copy" "$qa_fixture"
```

3. Apply the copied repository's ordinary ordered migrations and then the synthetic SQL **only to the explicit isolated persistence directory**. Run the already installed CLI in the copy; retain CLI output alongside the receipts. Never replace `--local` with a provider flag.

```sh
cd "$qa_copy"
WRANGLER_SEND_METRICS=false WRANGLER_LOG_PATH="$qa_fixture/wrangler-logs" \
  node node_modules/wrangler/bin/wrangler.js d1 migrations apply DB --local \
  --config .wrangler/deploy.jsonc --persist-to "$qa_copy/.wrangler/state"
WRANGLER_SEND_METRICS=false WRANGLER_LOG_PATH="$qa_fixture/wrangler-logs" \
  node node_modules/wrangler/bin/wrangler.js d1 execute DB --local \
  --config .wrangler/deploy.jsonc --persist-to "$qa_copy/.wrangler/state" \
  --file "$qa_fixture/process-fixture.sql"
```

4. With no service listening or observed original-state descriptors, capture byte-identical private copies of each physical SQLite file and its WAL/SHM sidecars, then run read-only diagnostics on those copies and check exact migrated schema/sentinel identity. No application owners should exist yet. This is quiescent physical snapshot evidence; original state bytes must remain unchanged. SQLite reader coordination may alter only the private diagnostic copy. It does not claim that the D1 API supports equivalent PRAGMA diagnostics.

```sh
python3 "$qa_root/check-isolated-state.py" --source-copy "$qa_copy" \
  --fixture-directory "$qa_fixture" --stage before-api
```

5. Start the selected built Worker in a terminal/session with stdin kept open. Wait for its `ready` record. The start receipt records ordinary `/api/health` and `/api/ready` results; the actual provider and Access remain outside scope.

```sh
node "$qa_root/start-built-server.mjs" "$qa_copy" "$qa_fixture"
```

6. From a second terminal with the same paths, create dedicated synthetic owners through actual APIs. Its exclusive session prevents replay after partial failure. A successful receipt has 8 mixed Runs, 6 untouched start owners, 6 compatible plan owners, Metrology/Timeline owners, and a Project with two native references and real PNG bytes.

```sh
node "$qa_root/seed-actual-api.mjs" http://127.0.0.1:4219/ "$qa_fixture"
```

7. Run the finite browser matrix serially. It covers 720/721/1200 × light/dark start confirmation, plan confirmation and mixed surfaces, plus two actual Project route-chunk delivery faults with explicit keyboard reload. Actual theme values are asserted. The matrix does not test every browser/device, remote storage, dirty/accepted reload checkpoints, or whole-roadmap completion.

```sh
node "$qa_root/browser-actual-api.mjs" http://127.0.0.1:4219/ "$qa_fixture" "$qa_copy"
```

`PHASE5F_CASE_ID` selects one explicitly named case for investigation; that receipt cannot qualify the complete 20-case matrix. Every browser fixture is single-use, including selected-case failures. Do not delete receipts or retry accepted owners; retain the failure and create a new copy/fixture.

8. Optionally run the seventh Metrology pending-stage helper **after** the base matrix releases the browser. It creates its own two fresh Sample/Run owners and preserves the base owners. Choose a fresh private output directory. It checks the actual `Search templates` textbox name (including Chromium's computed accessibility name) and pending create → add → refresh / direct add locks. Historical `af8f374` pending receipts only qualified the old placeholder-based scope.

```sh
node "$qa_root/browser-metrology-pending-actual-api.mjs" http://127.0.0.1:4219/ \
  "$qa_fixture" "$qa_copy" "$qa_temp/phase5f-metrology-UNIQUE"
```

9. In the server terminal, send the single line **`stop`** and await exit 0. The helper awaits `runtime.dispose()`, verifies the port closed, and creates a separate exclusive `isolated-server-stop-receipt.json`. The ready receipt is never rewritten. `SIGKILL`, lost control sessions, and arbitrary process termination do not establish this graceful-stop proof.

10. After the server process has exited and the port refuses connections, record final physical snapshot diagnostics. It validates lifecycle hashes/session and awaited disposal, PID absence, port closure and accessible-descriptor inspection, copies complete DB/WAL/SHM groups, verifies original bytes unchanged, and checks SQLite quick/FK results and exact uploaded PNG bytes when the seed succeeded. A lifecycle-only startup/stop run explicitly carries no attachment qualification.

```sh
python3 "$qa_root/check-isolated-state.py" --source-copy "$qa_copy" \
  --fixture-directory "$qa_fixture" --stage after-shutdown
```

## Receipts and failures

All seed, server, stop, physical and browser final receipts use exclusive creation. Browser progress is a separate append-only journal within its exclusively reserved session; it never overwrites a prior final result. Compact summaries retain actual statuses, response hashes, case assertions, source/artifact/config/helper identities and explicit limits without raw API response bodies; detailed pending receipts may retain synthetic response payloads locally. Screenshots and temporary state remain local evidence; do not commit them or credentials.

A failed reserved session remains single-use. Preserve its SQL, receipts, CLI output and physical state for diagnosis. Static preflight rejection before session reservation exits without accepted writes; terminal output is its evidence. Quiescent physical snapshots are required before and after service use; a live-file snapshot is rejected. Descriptor inspection uses `/proc` or an already installed `lsof`; any observed original-state descriptor is rejected. Inaccessible supervisor processes are recorded as a limit; this is not a claim of global descriptor absence. Missing inspection tooling fails closed, and stable original byte inventories, port refusal and owned-server PID absence remain required. The new receipts do not inherit historical diagnostic failures or manufacture a pass for them.
