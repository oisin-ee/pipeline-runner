FROM alpine/helm:4.2.0@sha256:af08f75a3130d666a50b9fc150f40987ef20b885cf67659aabf4b83a5f2c5501 AS helm

FROM ghcr.io/astral-sh/uv:0.9.17@sha256:5cb6b54d2bc3fe2eb9a8483db958a0b9eebf9edff68adedb369df8e7b98711a2 AS uv

FROM node:24-bookworm-slim AS runner

ARG PIPELINE_PACKAGE_VERSION=latest
ARG RUNNER_COMMAND_CONTRACT_VERSION=1
ARG OPENCODE_PACKAGE_VERSION=1.15.13
ARG CLAUDE_CODE_PACKAGE_VERSION=2.1.162
ARG PNPM_PACKAGE_VERSION=10.24.0
ARG BUN_PACKAGE_VERSION=1.3.14
ARG FALLOW_PACKAGE_VERSION=2.90.0
ARG OC_CODEX_MULTI_AUTH_VERSION=6.3.1
ARG TOOLHIVE_VERSION=0.29.1
ARG TOOLHIVE_LINUX_AMD64_SHA256=a70f9b74493c7d3d8b62187e5b838e4333b07477810b83eb5086879b9fa37bc8

LABEL pipeline.oisin.dev.pipeline-package-version=${PIPELINE_PACKAGE_VERSION}
LABEL pipeline.oisin.dev.runner-contract-version=${RUNNER_COMMAND_CONTRACT_VERSION}

ENV HOME=/root
ENV NPM_CONFIG_AUDIT=false
ENV NPM_CONFIG_FUND=false
ENV NPM_CONFIG_UPDATE_NOTIFIER=false

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl gh git openssh-client \
  && mkdir -p /root/.local/share/opencode /root/.config/gh \
  && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL -o /tmp/toolhive.tar.gz "https://github.com/stacklok/toolhive/releases/download/v${TOOLHIVE_VERSION}/toolhive_${TOOLHIVE_VERSION}_linux_amd64.tar.gz" \
  && echo "${TOOLHIVE_LINUX_AMD64_SHA256}  /tmp/toolhive.tar.gz" | sha256sum -c - \
  && tar -xzf /tmp/toolhive.tar.gz -C /usr/local/bin thv \
  && rm -f /tmp/toolhive.tar.gz

COPY --from=helm /usr/bin/helm /usr/local/bin/helm
COPY --from=uv /uv /uvx /usr/local/bin/
RUN npm install -g \
    "@oisincoveney/pipeline@${PIPELINE_PACKAGE_VERSION}" \
    "pnpm@${PNPM_PACKAGE_VERSION}" \
    "opencode-ai@${OPENCODE_PACKAGE_VERSION}" \
    "@anthropic-ai/claude-code@${CLAUDE_CODE_PACKAGE_VERSION}" \
    "bun@${BUN_PACKAGE_VERSION}" \
    "fallow@${FALLOW_PACKAGE_VERSION}" \
  && npm cache clean --force \
  && command -v moka \
  && command -v bun \
  && command -v pnpm \
  && command -v opencode \
  && command -v claude \
  && command -v helm \
  && command -v uvx \
  && command -v gh \
  && command -v fallow \
  && command -v thv \
  && thv version

RUN npx -y oc-codex-multi-auth@${OC_CODEX_MULTI_AUTH_VERSION}

ENTRYPOINT ["moka"]
CMD ["runner-command"]
