#!/usr/bin/env bash
# Dedicate your SECOND codex sub to the cluster (ipA3jy), keep the first
# (MDsLN1) for local opencode. Uses both subscriptions, no new purchase, and
# stops the token-rotation conflict (each account is used in exactly one place,
# so codex never revokes a token out from under the other consumer).
#
# Codex OAuth refresh ROTATES + REVOKES the prior token, so a single account
# cannot be shared across local opencode and the cluster: whoever refreshes last
# kills the other's token. Splitting the two subs (one per consumer) removes the
# conflict entirely.
#
# STEPS (this agent cannot do the interactive OAuth or bao login):
#   1. ! opencode auth login        # log in your SECOND codex account (ipA3jy)
#   2. ! bao login                  # or: export BAO_TOKEN=...   (BAO_ADDR=https://openbao.momokaya.ee)
#   3. bash scripts/dedicate-codex-to-cluster.sh ipA3jy
#
# Pass the label substring of the account to dedicate to the cluster (default
# ipA3jy). The script: copies that account's fresh tokens into OpenBao as the
# cluster's ACTIVE account, disables the other account in the cluster copy,
# removes the dedicated account from your LOCAL pool (so local keeps only the
# other sub and never rotates the cluster's), and force-syncs the ExternalSecret.
set -euo pipefail

CLUSTER_ACCT="${1:-ipA3jy}"
export BAO_ADDR="${BAO_ADDR:-https://openbao.momokaya.ee}"
MOUNT="kv"
SECRET_PATH="agent-runtime/pipeline-runner/codex-multiauth-accounts"
LOCAL_ACCOUNTS="${HOME}/.opencode/oc-codex-multi-auth-accounts.json"
NS="momokaya-pipeline"

command -v bao >/dev/null || { echo "bao CLI not found"; exit 1; }
bao token lookup >/dev/null 2>&1 || { echo "Not authenticated to OpenBao. Run: bao login"; exit 1; }
[ -f "${LOCAL_ACCOUNTS}" ] || { echo "Missing ${LOCAL_ACCOUNTS}"; exit 1; }

work="$(mktemp -d)"; trap 'rm -rf "${work}"' EXIT
bao kv get -mount="${MOUNT}" -field=accounts.json "${SECRET_PATH}" >"${work}/cluster.json"

python3 - "${work}/cluster.json" "${LOCAL_ACCOUNTS}" "${CLUSTER_ACCT}" "${work}/cluster-next.json" "${work}/local-next.json" <<'PY'
import json, sys
cluster_path, local_path, label, cluster_out, local_out = sys.argv[1:6]
cluster = json.load(open(cluster_path))
local = json.load(open(local_path))

def find(accounts, label):
    return next((a for a in accounts if label in (a.get("accountLabel") or "") or label in (a.get("accountId") or "")), None)

local_acct = find(local.get("accounts", []), label)
if not (local_acct and local_acct.get("refreshToken") and local_acct.get("accessToken")):
    sys.exit(f"Account '{label}' not found / unauthenticated in local opencode. Run: opencode auth login")

# Cluster: refresh the dedicated account's tokens, enable+activate it, disable the rest.
dedicated_idx = None
for i, a in enumerate(cluster["accounts"]):
    if a.get("accountId") == local_acct["accountId"] or label in (a.get("accountLabel") or ""):
        a["refreshToken"] = local_acct["refreshToken"]
        a["accessToken"]  = local_acct["accessToken"]
        a["expiresAt"]    = local_acct["expiresAt"]
        a["enabled"] = True
        dedicated_idx = i
    else:
        a["enabled"] = False
if dedicated_idx is None:
    # Account not already in the cluster set — add it.
    cluster["accounts"].append({**local_acct, "enabled": True})
    dedicated_idx = len(cluster["accounts"]) - 1
cluster["activeIndex"] = dedicated_idx
cluster["activeIndexByFamily"] = {k: dedicated_idx for k in cluster.get("activeIndexByFamily", {})}
json.dump(cluster, open(cluster_out, "w"))

# Local: drop the dedicated account so local never rotates the cluster's token.
local["accounts"] = [a for a in local.get("accounts", []) if a.get("accountId") != local_acct["accountId"]]
if local.get("accounts"):
    local["activeIndex"] = 0
    local["activeIndexByFamily"] = {k: 0 for k in local.get("activeIndexByFamily", {})}
json.dump(local, open(local_out, "w"))
print(f"cluster active -> {label} (fresh); other cluster accounts disabled; removed {label} from local pool")
PY

bao kv put -mount="${MOUNT}" "${SECRET_PATH}" "accounts.json=@${work}/cluster-next.json"
cp "${work}/local-next.json" "${LOCAL_ACCOUNTS}"
echo "OpenBao + local updated."

if command -v kubectl >/dev/null && [ -n "${KUBECONFIG:-}" ]; then
  kubectl -n "${NS}" annotate externalsecret opencode-openai-accounts-1 force-sync="$(date +%s)" --overwrite >/dev/null \
    && echo "ExternalSecret reconcile triggered."
fi
echo "Done. The cluster now owns ${CLUSTER_ACCT}; local keeps the other sub."
