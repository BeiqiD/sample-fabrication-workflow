from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected one replacement, found {count}")
    file.write_text(text.replace(old, new, 1))


replace_once(
    "worker/blob-lifecycle-review-fixes.test.ts",
    '''    assetPut?: ReturnType<typeof vi.fn>;\n    assetDelete?: ReturnType<typeof vi.fn>;''',
    '''    assetPut?: ReturnType<typeof vi.fn>;\n    assetDelete?: ReturnType<typeof vi.fn>;\n    assetHead?: ReturnType<typeof vi.fn>;''',
)
replace_once(
    "worker/blob-lifecycle-review-fixes.test.ts",
    '''      put: options.assetPut ?? vi.fn(async () => undefined),\n      delete: options.assetDelete ?? vi.fn(async () => undefined),\n      get: vi.fn(async () => null),''',
    '''      put: options.assetPut ?? vi.fn(async () => undefined),\n      delete: options.assetDelete ?? vi.fn(async () => undefined),\n      head: options.assetHead ?? vi.fn(async () => null),\n      get: vi.fn(async () => null),''',
)
replace_once(
    "worker/blob-lifecycle-review-fixes.test.ts",
    '''      assetPut,\n      assetDelete,\n      beforeExecute: (query, bindings) => {''',
    '''      assetPut,\n      assetDelete,\n      assetHead: vi.fn(async (key: string) => key === "metrology/winner.bin" ? {\n        size: 4,\n        httpEtag: '\"winner-etag\"',\n        writeHttpMetadata(headers: Headers) {\n          headers.set("content-type", "application/octet-stream");\n        },\n      } : null),\n      beforeExecute: (query, bindings) => {''',
)

replace_once(
    "worker/deployment-routing.test.ts",
    '''      "npm run test:blob-lifecycle && npm run test:reference-foundation && npm run test:project-foundation && npm run verify:project-persistence && npm run verify:project-map && npm run verify:project-reference-placement && npm run verify:project-owned-content && npm run verify:project-edges && npm run verify:project-reading && npm run verify:d1-migrations && npm run verify:reference-worker && npm run verify:reference-search-worker && npm test && npm run build:deploy",''',
    '''      "npm run test:blob-lifecycle && npm run test:storage-integrity && npm run test:reference-foundation && npm run test:project-foundation && npm run verify:project-persistence && npm run verify:project-map && npm run verify:project-reference-placement && npm run verify:project-owned-content && npm run verify:project-edges && npm run verify:project-reading && npm run verify:d1-migrations && npm run verify:reference-worker && npm run verify:reference-search-worker && npm test && npm run build:deploy",''',
)
