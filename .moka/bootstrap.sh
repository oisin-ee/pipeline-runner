#!/bin/sh
# moka environment bootstrap (repo-owned, run by the moka runner before any node).
# moka itself uses bun; install with the committed lockfile.
set -e
bun install --frozen-lockfile
