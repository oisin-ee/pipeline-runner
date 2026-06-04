FROM node:24-bookworm-slim AS runner

ARG PIPELINE_PACKAGE_VERSION=1.11.1
ARG CODEX_PACKAGE_VERSION=0.137.0
ARG OPENCODE_PACKAGE_VERSION=1.15.13
ARG CLAUDE_CODE_PACKAGE_VERSION=2.1.162

ENV NODE_ENV=production
ENV NPM_CONFIG_AUDIT=false
ENV NPM_CONFIG_FUND=false
ENV NPM_CONFIG_UPDATE_NOTIFIER=false

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git openssh-client \
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g \
    "@oisincoveney/pipeline@${PIPELINE_PACKAGE_VERSION}" \
    "@openai/codex@${CODEX_PACKAGE_VERSION}" \
    "opencode-ai@${OPENCODE_PACKAGE_VERSION}" \
    "@anthropic-ai/claude-code@${CLAUDE_CODE_PACKAGE_VERSION}" \
  && npm cache clean --force \
  && command -v oisin-pipeline \
  && command -v codex \
  && command -v opencode \
  && command -v claude

COPY docker/runner-entrypoint.sh /usr/local/bin/runner-entrypoint
RUN chmod 0755 /usr/local/bin/runner-entrypoint

ENTRYPOINT ["runner-entrypoint", "oisin-pipeline"]
CMD ["runner-job"]
