# Shared client build for the Node runtime

`npm run build:node-client` builds the existing React client into
`dist-node/client` without loading the Cloudflare Vite plugin or generating
Worker/deployment configuration. It retains the existing Temml compatibility
plugin, React transformation and lazy route/Map ownership. No dependency or
second domain model is introduced.

On base `7cdee5198188bcafc0b9e8703ac77451d0179234`, the actual command exited 0
and produced 112 client artifacts. The Node-only configuration typecheck passed.
The real bundle verifier passed on those artifacts: six initial chunks and
seventeen lazy Map chunks, with React Flow absent from the initial dependency
graph. A CLI `--client-directory PATH` option reuses that verifier; its default
continues to inspect the existing Worker client build.

`verify:node-client` combines the client build and the actual bundle check. Its
mandatory `node-client` leaf joins the canonical CI/development-deployment plan,
bringing that plan to fifteen unique leaves while retaining the fifteen public
status contexts. Verification/bundle contracts passed ten tests. The combined
script and the final complete plan still require their own observed execution;
this record preserves the separate build, configuration-type and bundle checks.

This is frontend build capability only. No Node app startup, login/cookies,
current application migrations, local file-role defaults, Docker image/volume,
upgrade or cross-deployment recovery is established. RT1–RT6 remain unfinished.
The draft foundation PR's fourteen-leaf complete-gate failures are historical
and are not overwritten by this new plan.
