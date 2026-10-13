FROM node:24.20.0-trixie-slim@sha256:50c3b2f6988dfc307b86e5301d69611af31f4789bdf232863b07d3b02fe55ae0

RUN apt-get update \
    && apt-get install --yes --no-install-recommends bash ca-certificates git python3 python3-pip python3-venv tar \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global pnpm@10.34.6 \
    && useradd --create-home --uid 10001 --shell /usr/sbin/nologin runner \
    && mkdir -p /workspace \
    && chown runner:runner /workspace

WORKDIR /workspace
USER runner
CMD ["sleep", "infinity"]
