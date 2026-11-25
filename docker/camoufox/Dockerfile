# Camoufox has no official server image. This installs the PyPI package, fetches
# its Firefox build, and exposes a Playwright server (Camoufox does not speak CDP).
# Playwright is pinned to 1.50: Camoufox 0.4.11's server launcher needs an internal
# file that later Playwright releases no longer ship. The client must match (1.50.x).
FROM python:3.12-slim-bookworm
ARG CAMOUFOX_VERSION=0.4.11
RUN apt-get update && apt-get install -y --no-install-recommends libatomic1 \
 && pip install --no-cache-dir "camoufox[geoip]==${CAMOUFOX_VERSION}" "playwright==1.50.0" \
 && python -m playwright install-deps firefox \
 && python -m camoufox fetch \
 && rm -rf /var/lib/apt/lists/*
COPY server.py /server.py
EXPOSE 9305
CMD ["python", "/server.py"]
