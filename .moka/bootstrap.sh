#!/bin/sh
# moka environment bootstrap (repo-owned, run by the moka runner before any node).
# moka itself uses nub; install with the committed lockfile.
set -e
nub ci
