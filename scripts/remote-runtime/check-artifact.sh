#!/bin/sh
# Disposable container only; mounts contain an archive and verification scripts, never the checkout.
set -eu
artifact_arch="$(node -p process.arch)"
tar -xzf "/artifacts/percho-runtime-linux-${artifact_arch}.tar.gz" -C /runtime
mkdir -p /state/tmp
export TMPDIR=/state/tmp
export PI_OFFLINE=1
export PERCHO_RUNTIME_TEST_ENTRY=/runtime/entry.mjs
exec node /verify/verify-remote-runtime-artifact.mjs
