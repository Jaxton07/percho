FROM ubuntu:22.04
ARG TARGETARCH
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl xz-utils git util-linux && rm -rf /var/lib/apt/lists/*
RUN set -eu; case "$TARGETARCH" in arm64) node_arch=arm64 ;; amd64) node_arch=x64 ;; *) exit 1 ;; esac; \
    archive="node-v22.19.0-linux-${node_arch}.tar.xz"; \
    mkdir /opt/node-download /opt/node; \
    cd /opt/node-download; \
    curl -fsSLO "https://nodejs.org/dist/v22.19.0/${archive}"; \
    curl -fsSLo SHASUMS256.txt "https://nodejs.org/dist/v22.19.0/SHASUMS256.txt"; \
    grep " ${archive}$" SHASUMS256.txt | sha256sum --check --strict -; \
    tar -xJf "$archive" -C /opt/node --strip-components=1; \
    rm -rf /opt/node-download
ENV PATH=/opt/node/bin:$PATH
WORKDIR /source
