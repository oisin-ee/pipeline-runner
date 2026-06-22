#!/usr/bin/env bash
# Push fresh codex-multi-auth tokens from your freshly-authed local opencode into
# OpenBao, the source-of-truth the cluster's ExternalSecret syncs from.
#
# WHY: the cluster reads opencode-openai-accounts-1, an ExternalSecret reconciled
# (hourly) from OpenBao kv/agent-runtime/pipeline-runner/codex-multiauth-accounts.
# Its tokens are 8 days old and the provider now rejects them on refresh
# ("Token refresh failed: 401") for BOTH accounts. Manual `kubectl patch` of the
# k8s secret reverts on the next reconcile, so the fix MUST land in OpenBao.
#
# PREREQ (run yourself first; interactive auth this agent cannot do):
#   ! bao login            # or: export BAO_TOKEN=...   (BAO_ADDR=https://openbao.momokaya.ee)
# Then: bash scripts/update-openbao-codex-accounts.sh
set -euo pipefail

export BAO_ADDR="${BAO_ADDR:-https://openbao.momokaya.ee}"
MOUNT="kv"
SECRET_PATH="agent-runtime/pipeline-runner/codex-multiauth-accounts"
LOCAL_ACCOUNTS="${HOME}/.opencode/oc-codex-multi-auth-accounts.json"
NS="momokaya-pipeline"

command -v bao >/dev/null || { echo "bao CLI not found"; exit 1; }
bao token lookup >/dev/null 2>&1 || { echo "Not authenticated to OpenBao. Run: bao login"; exit 1; }
[ -f "${LOCAL_ACCOUNTS}" ] || { echo "Missing ${LOCAL_ACCOUNTS} — authenticate opencode locally first"; exit 1; }

work="$(mktemp -d)"
trap 'rm -rf "${work}"' EXIT

# Read current cluster accounts.json from OpenBao (preserves its 2-account shape).
bao kv get -mount="${MOUNT}" -field=accounts.json "${SECRET_PATH}" >"${work}/cluster.json"

# Surgically refresh the access/refresh tokens of every account whose accountId
# also exists locally (keeps the cluster's account set + workspaces intact).
python3 - "${work}/cluster.json" "${LOCAL_ACCOUNTS}" "${work}/next.json" <<'PY'
import json, sys
cluster_path, local_path, out_path = sys.argv[1:4]
cluster = json.load(open(cluster_path))
local = json.load(open(local_path))
lbyid = {a["accountId"]: a for a in local.get("accounts", [])}
updated = []
for a in cluster.get("accounts", []):
    la = lbyid.get(a["accountId"])
    if la and la.get("refreshToken") and la.get("accessToken"):
        a["refreshToken"] = la["refreshToken"]
        a["accessToken"]  = la["accessToken"]
        a["expiresAt"]    = la["expiresAt"]
        a["enabled"]      = True
        # Make the freshly-authed account the active one for every model family.
        idx = cluster["accounts"].index(a)
        cluster["activeIndex"] = idx
        cluster["activeIndexByFamily"] = {k: idx for k in cluster.get("activeIndexByFamily", {})}
        updated.append(a.get("accountLabel"))
if not updated:
    sys.exit("No cluster account matched a local accountId — nothing to update")
json.dump(cluster, open(out_path, "w"))
print("refreshed + activated:", ", ".join(updated))
PY

# Write back to OpenBao (kv v2).
bao kv put -mount="${MOUNT}" "${SECRET_PATH}" "accounts.json=@${work}/next.json"
echo "OpenBao updated."

# Force the ExternalSecret to reconcile now instead of waiting up to 1h.
if command -v kubectl >/dev/null && [ -n "${KUBECONFIG:-}" ]; then
  kubectl -n "${NS}" annotate externalsecret opencode-openai-accounts-1 \
    force-sync="$(date +%s)" --overwrite >/dev/null && echo "ExternalSecret reconcile triggered."
fi
echo "Done. Re-run: moka submit --quick --open-pr ..."
