FROM node:24-bookworm-slim AS builder

ENV NPM_CONFIG_AUDIT=false
ENV NPM_CONFIG_FUND=false
ENV NPM_CONFIG_UPDATE_NOTIFIER=false

WORKDIR /app
COPY package.json tsconfig.json tsdown.config.ts ./
COPY src ./src
COPY defaults ./defaults
COPY docs ./docs
COPY README.md ./README.md

RUN npm install --include=dev \
  && npm run build:cli \
  && npm pack --ignore-scripts --pack-destination /tmp

FROM alpine/helm:4.2.0@sha256:af08f75a3130d666a50b9fc150f40987ef20b885cf67659aabf4b83a5f2c5501 AS helm

FROM ghcr.io/astral-sh/uv:0.9.17@sha256:5cb6b54d2bc3fe2eb9a8483db958a0b9eebf9edff68adedb369df8e7b98711a2 AS uv

FROM node:24-bookworm-slim AS runner

ARG PIPELINE_PACKAGE_VERSION=local
ARG RUNNER_JOB_CONTRACT_VERSION=1
ARG CODEX_PACKAGE_VERSION=0.137.0
ARG OPENCODE_PACKAGE_VERSION=1.15.13
ARG CLAUDE_CODE_PACKAGE_VERSION=2.1.162
ARG PNPM_PACKAGE_VERSION=10.24.0
ARG BUN_PACKAGE_VERSION=1.3.14

LABEL pipeline.oisin.dev.pipeline-package-version=${PIPELINE_PACKAGE_VERSION}
LABEL pipeline.oisin.dev.runner-contract-version=${RUNNER_JOB_CONTRACT_VERSION}

ENV HOME=/root
ENV CODEX_HOME=/root/.codex
ENV NPM_CONFIG_AUDIT=false
ENV NPM_CONFIG_FUND=false
ENV NPM_CONFIG_UPDATE_NOTIFIER=false

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates gh git openssh-client \
  && rm -rf /var/lib/apt/lists/*

COPY --from=helm /usr/bin/helm /usr/local/bin/helm
COPY --from=uv /uv /uvx /usr/local/bin/
COPY --from=builder /tmp/oisincoveney-pipeline-*.tgz /tmp/pipeline-package.tgz
RUN npm install -g \
    /tmp/pipeline-package.tgz \
    "pnpm@${PNPM_PACKAGE_VERSION}" \
    "@openai/codex@${CODEX_PACKAGE_VERSION}" \
    "opencode-ai@${OPENCODE_PACKAGE_VERSION}" \
    "@anthropic-ai/claude-code@${CLAUDE_CODE_PACKAGE_VERSION}" \
    "bun@${BUN_PACKAGE_VERSION}" \
  && rm -f /tmp/pipeline-package.tgz \
  && npm cache clean --force \
  && command -v oisin-pipeline \
  && command -v bun \
  && command -v pnpm \
  && command -v codex \
  && command -v opencode \
  && command -v claude \
  && command -v helm \
  && command -v uvx \
  && command -v gh

ENTRYPOINT ["oisin-pipeline"]
CMD ["runner-job"]
