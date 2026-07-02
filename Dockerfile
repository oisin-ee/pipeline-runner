FROM alpine/helm:4.2.0@sha256:af08f75a3130d666a50b9fc150f40987ef20b885cf67659aabf4b83a5f2c5501 AS helm

FROM ghcr.io/astral-sh/uv:0.9.17@sha256:5cb6b54d2bc3fe2eb9a8483db958a0b9eebf9edff68adedb369df8e7b98711a2 AS uv

FROM node:24-bookworm-slim AS runner

ARG PIPELINE_PACKAGE_VERSION=latest
ARG RUNNER_COMMAND_CONTRACT_VERSION=1
ARG OPENCODE_PACKAGE_VERSION=1.17.3
ARG CLAUDE_CODE_PACKAGE_VERSION=2.1.162
ARG PNPM_PACKAGE_VERSION=10.24.0
ARG BUN_PACKAGE_VERSION=1.3.14
ARG NUB_PACKAGE_VERSION=0.2.7
ARG FALLOW_PACKAGE_VERSION=2.90.0
ARG MISE_VERSION=2026.4.11
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

# mise: per-repo toolchain manager. Target repos pin their toolchain (e.g. Go)
# in mise.toml; their .moka/bootstrap.sh runs `mise install`, and the shims dir
# on PATH then exposes the pinned tools to every runner shell — setup commands,
# gate builtins, and the agent — without per-shell activation.
RUN curl -fsSL https://mise.run | MISE_VERSION="${MISE_VERSION}" MISE_INSTALL_PATH=/usr/local/bin/mise sh \
  && command -v mise \
  && mise --version
ENV MISE_DATA_DIR=/root/.local/share/mise
ENV PATH="/root/.local/share/mise/shims:${PATH}"

COPY --from=helm /usr/bin/helm /usr/local/bin/helm
COPY --from=uv /uv /uvx /usr/local/bin/
RUN npm install -g \
    "@oisincoveney/pipeline@${PIPELINE_PACKAGE_VERSION}" \
    "pnpm@${PNPM_PACKAGE_VERSION}" \
    "opencode-ai@${OPENCODE_PACKAGE_VERSION}" \
    "@anthropic-ai/claude-code@${CLAUDE_CODE_PACKAGE_VERSION}" \
    "bun@${BUN_PACKAGE_VERSION}" \
    "@nubjs/nub@${NUB_PACKAGE_VERSION}" \
    "fallow@${FALLOW_PACKAGE_VERSION}" \
  && npm cache clean --force \
  && command -v moka \
  && command -v bun \
  && command -v nub \
  && command -v pnpm \
  && command -v opencode \
  && command -v claude \
  && command -v helm \
  && command -v uvx \
  && command -v gh \
  && command -v fallow \
  && command -v thv \
  && thv version

# chezmoi: provisions the shared agent harness (skills, agent hooks, global
# instruction rules) plus the dotfiles toolchain from the PUBLIC
# oisincoveney/dotfiles. The dotfiles' .chezmoiexternal clones the PRIVATE
# oisin-ee/agent repo, and its run_onchange scripts install the mise tool set and
# run the agent harness installer — both need GitHub auth. That auth is passed as
# a BuildKit secret so the token is never baked into an image layer. The dotfiles
# templates name/email from CHEZMOI_NAME / CHEZMOI_EMAIL (defaulted in the
# source), so the apply is fully non-interactive.
RUN curl -fsLS get.chezmoi.io | sh -s -- -b /usr/local/bin \
  && command -v chezmoi \
  && chezmoi --version

# GIT_CONFIG_GLOBAL points git at a build-only config carrying the token-rewrite
# rule, so authenticating the private clone never writes the token into
# /root/.gitconfig (which chezmoi itself overwrites from dot_gitconfig.tmpl during
# apply). The build config lives under /tmp and is removed in the same layer, so
# the token never persists. GITHUB_TOKEN also authenticates chezmoi's github.com
# archive/API fetches and mise's github/aqua backends.
RUN --mount=type=secret,id=gh_token \
  set -eu; \
  GITHUB_TOKEN="$(cat /run/secrets/gh_token)"; \
  export GITHUB_TOKEN; \
  export GIT_CONFIG_GLOBAL=/tmp/gitconfig-build; \
  git config --file "$GIT_CONFIG_GLOBAL" \
    url."https://x-access-token:${GITHUB_TOKEN}@github.com/".insteadOf "https://github.com/"; \
  git config --file "$GIT_CONFIG_GLOBAL" \
    url."https://x-access-token:${GITHUB_TOKEN}@github.com/".insteadOf "git@github.com:"; \
  chezmoi init --apply --force oisincoveney/dotfiles; \
  rm -f "$GIT_CONFIG_GLOBAL"

# Install moka's own slash-command adapters (/moka-execute|inspect|quick) + the
# singleton MCP gateway host config AFTER the harness is laid down by chezmoi.
# moka no longer installs the harness itself (that moved to oisin-ee/agent via
# chezmoi above); this step only adds the /moka-* entrypoints on top.
RUN moka init \
  && test -f /root/.config/opencode/commands/moka-execute.md \
  && test -f /root/.claude/commands/moka-execute.md

ENTRYPOINT ["moka"]
CMD ["runner-command"]
