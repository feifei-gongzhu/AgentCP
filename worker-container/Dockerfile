FROM node:22-bookworm-slim

ARG CODEX_VERSION=0.144.0-alpha.4

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl git jq python3 \
    && npm install --global "@openai/codex@${CODEX_VERSION}" \
    && rm -rf /var/lib/apt/lists/*

RUN useradd --create-home --uid 10001 worker \
    && mkdir -p /opt/agentcp \
    && chown -R worker:worker /opt/agentcp

COPY entrypoint.py output-schema.json /opt/agentcp/

USER worker
WORKDIR /workspace
