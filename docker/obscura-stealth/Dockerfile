# Obscura's official Docker image is the non-stealth build. This wraps the
# project's own prebuilt stealth binary from the same release in the same base image.
FROM debian:12-slim AS fetch
ARG VERSION=v0.2.7
ARG TARGETARCH
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates && rm -rf /var/lib/apt/lists/*
RUN case "$TARGETARCH" in arm64) A=aarch64 ;; amd64) A=x86_64 ;; *) echo "unsupported $TARGETARCH"; exit 1 ;; esac \
 && curl -fsSL "https://github.com/h4ckf0r0day/obscura/releases/download/${VERSION}/obscura-${A}-linux-stealth.tar.gz" | tar -xz -C /opt

FROM gcr.io/distroless/cc-debian12:nonroot
COPY --from=fetch /opt/obscura /obscura
COPY --from=fetch /opt/obscura-worker /obscura-worker
ENTRYPOINT ["/obscura"]
