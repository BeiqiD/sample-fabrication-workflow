# Shared code ownership

`contracts/` owns public request/response DTOs, stable enums and limits, input
validators, and Reference URL codecs. `domain/` owns deterministic algorithms
used by both the Web client and Worker. Neither directory owns Worker services,
database queries, provider access, React components, or application retry policy.

| Canonical directory | Modules |
| --- | --- |
| `contracts/` | `template`, `types`, `comment-submissions`, `project-api`, `project-types`, `project-copy-paste-api`, `reference-types`, `reference-search`, `reference-children`, `reference-destinations`, `export`, `export-protocol`, `export-compatibility`, `export-blob-plan` |
| `domain/` | `content-addressing`, `reference-comment-preview`, `sample-records`, `tiff`, `mime-type`, `sqlite-table-columns` |

New imports use the canonical directories. Matching files directly under
`shared/` are supported compatibility re-exports, so existing consumers and test
entry points retain the same symbols and module identities without maintaining
another implementation. Tests beside those compatibility paths exercise the
canonical code through the re-exports.

Contract validators may use the pure MIME and TIFF classifiers in `domain/`.
The domain algorithms have no dependency on application code or the contracts.
Content-addressing schemes, Reference codecs, validation limits, response shapes,
and error strings stay unchanged by this relocation.

Plan alignment has only Worker consumers. Its algorithm and tests live in
`worker/execution/plan-alignment.ts` and
`worker/execution/plan-alignment.test.ts`; it has no shared compatibility export.
Execution request/response DTOs remain shared contracts because the Web client
also consumes them.

Template serializers in `worker/process-definition/routes.ts` and client API types
use the same `contracts/template.ts` DTOs. These compile-time checks add no
runtime validation of trusted outputs and do not change response fields.

The existing CI and deployment gates enforce this boundary. The
`verification-scripts` leaf runs `scripts/verify-shared-boundary.mjs`, which parses
TypeScript imports and re-exports, including type-only and dynamic dependencies.
Canonical files can only depend on canonical shared files; domain files can only
depend on domain files. Root compatibility paths cannot contain implementations.
Ambient reference directives and nonliteral dependency loading are rejected.

The existing build leaf runs `tsconfig.shared.json` through `tsc -b`, separately
from the Web and Worker projects. It uses standard ECMAScript and Web API types
with `types: []`, so shared code cannot inherit Node, React or Cloudflare ambient
types from either application. This ownership check already has a verification
leaf; new modules must keep it enforced.

## File/data portability boundary

The proposed FP track reuses this ownership split. File/profile/job DTOs and
versioned package validators may belong in `contracts/`; deterministic algorithms
with no contract dependency may belong in `domain/`. Storage SDKs, SQL repositories,
credential encryption services, schedulers, browser downloads and archive I/O do
not move into `shared/` merely because several features use them. Its dependency
gate forbids external imports, including provider SDKs and ZIP libraries.
Keep reusable application services outside this pure client/Worker boundary and
compose runtime adapters explicitly. See the
[repository compatibility audit](../docs/FILE_DATA_PORTABILITY_REPOSITORY_COMPATIBILITY.md).
This clarification adds no FP implementation or runtime adapter.
