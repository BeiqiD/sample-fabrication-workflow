# Registry metadata and separate historical primitive observations are retained
# in docs/NODE_DISTRIBUTION_BASE_IMAGE_RECEIPTS.json. This current full build and
# current28 main/File graph remain pending their independent qualification.
FROM node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df AS build
WORKDIR /build
COPY package.json package-lock.json ./
RUN --mount=type=secret,id=environment-proxy-ca,target=/run/secrets/environment-proxy-ca.crt \
    if [ -f /run/secrets/environment-proxy-ca.crt ]; then \
      export NODE_EXTRA_CA_CERTS=/run/secrets/environment-proxy-ca.crt; \
    fi; npm ci --no-audit --no-fund
COPY . .
# Independent client only: no generated Cloudflare bindings or Worker build.
# Missing genuine main/identity/installation executable fails this build.
# A successfully packaged partial app remains restricted-development.
RUN npm run verify:node-client && node scripts/build-node.mjs

FROM node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df AS runtime
ENV NODE_ENV=production
WORKDIR /opt/sample
# util-linux flock is a physical lease dependency, never a shell PID lock.
RUN test "$(node --version)" = "v24.19.0" && test -x /usr/bin/flock \
    && test "$(id -u node)" = "1000" && test "$(id -g node)" = "1000" \
    && mkdir -p /var/lib/sample/state /var/lib/sample/objects \
       /var/lib/sample/volumes/a /var/lib/sample/volumes/b /run/sample /run/secrets/sample \
    && chown 1000:1000 /var/lib/sample/state /var/lib/sample/objects \
       /var/lib/sample/volumes/a /var/lib/sample/volumes/b \
    && chmod 0700 /var/lib/sample/state /var/lib/sample/objects \
       /var/lib/sample/volumes/a /var/lib/sample/volumes/b
COPY --from=build --chown=0:0 /build/dist-node/distribution/ /opt/sample/
# No node_modules, image-time database, account, keyring, automatic volume
# provisioning or provider/default selection enters the runtime image.
RUN node tools/verify-node-distribution.mjs /opt/sample --runtime \
    && find /opt/sample -type d -exec chmod 0555 {} + \
    && find /opt/sample -type f -exec chmod 0444 {} +
USER 1000:1000
STOPSIGNAL SIGTERM
ENTRYPOINT ["/bin/sh", "/opt/sample/tools/container-entrypoint.sh"]
