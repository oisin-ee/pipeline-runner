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

FROM node:24-bookworm-slim AS runner

ARG PIPELINE_PACKAGE_VERSION=local
ARG RUNNER_JOB_CONTRACT_VERSION=1
ARG CODEX_PACKAGE_VERSION=0.137.0
ARG OPENCODE_PACKAGE_VERSION=1.15.13
ARG CLAUDE_CODE_PACKAGE_VERSION=2.1.162

LABEL pipeline.oisin.dev.pipeline-package-version=${PIPELINE_PACKAGE_VERSION}
LABEL pipeline.oisin.dev.runner-contract-version=${RUNNER_JOB_CONTRACT_VERSION}

ENV NODE_ENV=production
ENV HOME=/root
ENV CODEX_HOME=/root/.codex
ENV NPM_CONFIG_AUDIT=false
ENV NPM_CONFIG_FUND=false
ENV NPM_CONFIG_UPDATE_NOTIFIER=false

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git openssh-client \
  && rm -rf /var/lib/apt/lists/*

COPY --from=builder /tmp/oisincoveney-pipeline-*.tgz /tmp/pipeline-package.tgz
RUN npm install -g \
    /tmp/pipeline-package.tgz \
    "@openai/codex@${CODEX_PACKAGE_VERSION}" \
    "opencode-ai@${OPENCODE_PACKAGE_VERSION}" \
    "@anthropic-ai/claude-code@${CLAUDE_CODE_PACKAGE_VERSION}" \
  && rm -f /tmp/pipeline-package.tgz \
  && npm cache clean --force \
  && command -v oisin-pipeline \
  && command -v codex \
  && command -v opencode \
  && command -v claude

ENTRYPOINT ["oisin-pipeline"]
CMD ["runner-job"]
