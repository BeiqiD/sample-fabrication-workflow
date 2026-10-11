# Default Docker six capacity source scope

This test workflow selects the exact published f883 source, separately
from the reviewed acceptance-code commit. It is source only until that commit
is reviewed and its one push to the exact `codex/default-docker-six-capacity-f883-one`
branch is authorized. The same branch also permits a separately authorized
manual dispatch. This narrow push trigger lets a new workflow run without first
registering it on the default branch. It deploys nothing and
pushes no image.

The original six cases and all 21 named nested ownership/control functions are
unchanged. Container UID 1000, private bind volumes, original TERM/wait outcomes,
the 600-second image build and other original case budgets stay unchanged.
Only source paths, fresh private client/configuration observations and the
GitHub network prerequisite replace the cloud environment bindings.

The CI runner must prove that the Docker root and private workspace use the
same backing filesystem with at least 8 GiB available. This is conservative
admission headroom, not a measured exact image size. It downloads only the
pinned amd64 base, verifies its actual immutable ID, then runs one independent
strict-TLS npm registry ping with retries disabled. It does not reuse the cloud
proxy observation or infer why the historical 600-second build failed.

Only dedicated ephemeral checkout/QA ownership is assigned to UID 1000. No
production account, provider, credential, default File activation or runtime
permission changes. Any first failure stops later commands; unproved daemon or
build closure stays failed. Original stopped containers/state are retained in
the ephemeral runner, without forced cleanup or pruning.

Uploaded evidence is limited to bounded original logs, receipts, source/context
pin maps and image ID. Database files, keyrings, runtime configuration, volume
contents, private stdin and usable credentials are excluded. The image runs its
own frontend and four-bundle build; those bytes are a new image producer and are
not retagged host f883 frontend/distribution artifacts. Enabled File/jobs and a
V5 restored target runtime are outside these original six cases.
