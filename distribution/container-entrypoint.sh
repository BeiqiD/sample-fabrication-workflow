#!/bin/sh
set -eu
# Check only trusted immutable image artifacts here. Installation admission,
# physical writer ownership, identity, keyring, and readiness belong to main.
node /opt/sample/tools/verify-node-distribution.mjs /opt/sample --runtime
exec node /opt/sample/server/main.mjs --config /run/sample/runtime.json "$@"
