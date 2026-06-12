# Architecture Review: oisin-pipeline + pipeline-console + infra

*2026-06-12 — full three-repo audit + library/OSS alternatives research*

## The honest top-line

Your instinct is right: the system is denser than its goal. The goal is "spawn tickets/tasks against opencode with quick / graph / custom execution," but what exists is **2 planners × 2 runtimes × 2 submission layers × 2 event systems**, plus a console that re-derives run state that Argo already knows. None of the individual pieces is bad — the pieces are actually well-built — but the *count* of pieces is the complexity. The fixes below are mostly about deleting parallel paths, not rewriting anything.

## What's actually there (verified sizes)

**oisin-pipeline** (~26k LOC): quick/execute/inspect modes are really **two planning strategies** (deterministic `workflow-planner.ts` — 607 lines — vs AI-driven `schedule/planner.ts` — 907 lines) feeding **two runtimes** (local `pipeline-runtime.ts` — 1263 lines — + scheduler, vs Argo compilation via `argo-workflow.ts` (589) + `argo-submit.ts` (305) + `moka-submit.ts` (780)). "Custom" is just workflow YAML — not a third execution method. Real hotspots: `pipeline-runtime.ts` (1263), `config/schemas.ts` (997), `schedule/planner.ts` (907).

**pipeline-console**: Hono + Drizzle/Postgres + React/TanStack + XYFlow, shared Zod contracts. Sound stack. Hotspots: `server/src/routes/pipeline.ts` (1,848 lines, 40+ endpoints in one file) and `runner-run-control.service.ts` (2,309 lines — it manually reconstructs run timelines from raw events).

**infra**: genuinely in good shape post-refactor. Full GitOps (ArgoCD app-of-apps on k3s over Tailscale), Kueue, Argo Workflows, OpenBao + external-secrets + sealed-secrets, auto-rotated runner event token. No brokenness found.

## The one strategic decision

Everything else is tactical. The strategic question is: **do you keep the Argo Workflows + Kueue + custom console execution stack, or consolidate onto one engine?**

The strongest research finding: **[Hatchet](https://github.com/hatchet-dev/hatchet)** (MIT, active — v0.89.0 released 2026-06-10, Postgres-only, self-hosted Helm chart, full dashboard included, TS SDK with DAGs/retries/concurrency-keys/durable tasks, explicitly aimed at AI-agent orchestration). Adopting it would delete:

- the local scheduler + retry + state store
- the entire Argo compiler/submit layer
- Kueue
- the runner event sink
- the console's SSE + sequence-replay machinery
- the console's run-timeline reconstruction (its dashboard does that)

moka becomes "compile YAML DAG → Hatchet workflow"; quick mode is the same engine with a local worker. What it *doesn't* cover: pod-per-agent isolation (you'd have a task spawn a K8s Job for heavy isolation, or run per-repo worker containers), and your gates/goal-loop — which stay as plain task code either way.

**Recommendation**, given the infra refactor just finished and the one-engine refactor (PIPE-57–69) is in flight: **don't swap platforms mid-refactor.** Finish unifying the moka runtime, then run a 1–2 day spike of Hatchet on the cluster with one real ticket end-to-end. If the spike feels right, the migration deletes far more code than it adds. If not, the keep-Argo cleanup below gets you most of the simplification.

**Runner-ups evaluated and rejected:**

| Candidate | Why not |
|---|---|
| Temporal | Multi-service ops overhead, overkill for one user |
| Inngest | Lowest-ops single binary, but step-functions, not DAG-native — viable runner-up |
| Restate | BUSL-1.1 license, journal-style not DAG-native |
| Windmill | Good platform, but flows live in *its* format/UI — trades one compiler for another |
| Trigger.dev v4 | Bundles ClickHouse + Postgres + Redis + object storage — heavy |
| Dagger | Wants to own execution inside its BuildKit engine — wrong shape |
| vibe-kanban (BloopAI) | **Sunsetting** after Bloop's shutdown; local-worktree-only anyway |
| claude-squad | Local tmux/worktree TUI only — complements, doesn't replace |
| OpenHands | Most complete "agents on k8s with UI" — but runs *its* agent, means abandoning opencode |
| [Centaur](https://github.com/paradigmxyz/centaur) (Paradigm) | Closest in spirit — CLI agents in k8s sandboxes, k3s-friendly — but Slack-native, Python, young. **Watch it.** |

## Do these regardless of that decision

1. **Adopt `opencode serve` + `@opencode-ai/sdk` for agent nodes.** The clearest library win. `agent-node.ts` (609 lines) spawns opencode subprocesses and scrapes output; opencode has a headless server with typed SDK (`createOpencodeClient()`), session lifecycle, async prompting, and a structured event stream. In runner pods: start `opencode serve`, drive via SDK, forward its events. Replaces the most fragile code in the runtime with maintained vendor code.

2. **Export the run-event schema from `@oisincoveney/pipeline` and consume it in console's contracts.** Today the runner emits events and the console independently defines `PipelineRunEventDto` (`contracts/src/pipeline/run.ts`) — nothing prevents drift except integration tests. One Zod schema, owned by the pipeline package, imported by the console. **Biggest cross-repo correctness risk.**

3. **Fix the version-field confusion.** The npm registry has **2.1.1** published; the repo's `package.json` says **1.5.6** (stale — semantic-release doesn't commit the bump back). Console pins 2.1.0. Not broken, but the repo lying about its own version will keep confusing you and your agents. Either let semantic-release commit the version back or add a comment in package.json noting the registry is authoritative.

4. **Collapse the planner naming.** `schedule-planner.ts` is a 12-line facade over `schedule/planner.ts`; `workflow-planner.ts` vs `schedule/planner.ts` is the deterministic-vs-AI split, which is legitimate, but nothing names that distinction. Suggestion: `planning/compile.ts` (deterministic DAG compile — runs always) and `planning/generate.ts` (AI decomposition — produces input for compile). One mental model: *generate is optional, compile is the engine's front door.*

5. **Split the two monster console files.** `routes/pipeline.ts` (1,848) by domain → `runs.route.ts` / `tasks.route.ts` / `settings.route.ts` / `infra.route.ts`. `runner-run-control.service.ts` (2,309) → extract `RunDetailBuilder` / `RunTimelineBuilder`. Also question whether the timeline reconstruction should exist at all — Argo's own UI/API already provides per-node timelines and log streaming for Argo-executed runs; the console could deep-link for forensics and keep only the summary view.

6. **Question Kueue.** For a single user, Argo Workflows' own parallelism/semaphores likely suffice. Kueue is one more controller, one more label contract (`kueue.x-k8s.io/queue-name`), one more thing the console models (`k8s_queue_name`, `k8s_workload_name` columns). Unless a concrete multi-tenant/quota need is coming, removing it deletes real surface area.

## Smaller library swaps (worth it / not worth it)

| Hand-rolled | Replacement | Verdict |
|---|---|---|
| Argo manifest building (`argo-workflow.ts`) | [`@kubernetes-models/argo-workflows`](https://www.npmjs.com/package/@kubernetes-models/argo-workflows) — typed Workflow classes with `.validate()` | **Yes** if keeping Argo (no Hera-for-TS exists; this is the closest) |
| Console SSE + sequence replay | tRPC v11 `httpSubscriptionLink` + `tracked()` — automatic `lastEventId` resume, exactly the hand-rolled mechanism | **Yes if** the console keeps growing; skip if Hatchet/Argo UI absorbs it |
| K8s watch/reconnect in `runner-job-client.service.ts` (1,133) | `@kubernetes/client-node` Informers (already a dep) or [`kubernetes-fluent-client`](https://github.com/defenseunicorns/kubernetes-fluent-client) | **Use the Informers already there** |
| Zod + AJV dual validation | — | **Keep.** Zod for config shapes, AJV for arbitrary user/agent JSON-schema gates is a legitimate split |
| Retry logic (`runtime/retry.ts`) | p-retry etc. | **Keep** — small and yours |
| Gates, hooks, goal-loop, YAML schedule format | — | **Keep** — actual domain logic; no framework provides it |
| Pod-per-agent lifecycle (future) | [kubernetes-sigs/agent-sandbox](https://agent-sandbox.sigs.k8s.io/) — official SIG, Sandbox CRDs + warm pools | **Watch** — standards-track replacement if agents stay as pods |

## Cross-repo integration gaps (infra ↔ console ↔ pipeline)

The integration is fundamentally healthy (SHA-pinned runner image, rotated event-auth token via OpenBao, proper RBAC split). Remaining drift points:

1. **Runner image SHA is hand-bumped** in `infra/k8s/apps/platform/pipeline-console.yaml:65`. Automate with Renovate (regex manager on the SHA) or ArgoCD Image Updater.
2. **`infra-dev-workspace` uses `:latest`** while everything else is SHA-pinned — inconsistent; pin it.
3. **pipeline-console chart tracks repo HEAD** (no `targetRevision`) — a chart restructure breaks infra's inline values silently. Pin to a tag or at least a branch with CI gating.
4. **Sealed-secrets + external-secrets hybrid** — two sealing/rotation paths. Already deep in OpenBao + external-secrets; migrating the remaining sealed secrets there retires the kubeseal scripts and the keypair-backup ritual in `secrets-backups/`.
5. **Console's Helm chart defines a `pipeline-runner` SA** while infra defines ServiceAccounts in `k8s/manifests/kueue/pipeline-runner-serviceaccounts.yaml` — document ownership explicitly so they don't collide.
6. Console dev mode runs with **auth disabled** and production relies on network isolation — fine on Tailscale-only ingress, but `pipeline-console.momokaya.ee` is internet-facing TLS; confirm there's an auth layer (Zitadel is right there in infra) in front of it.

## Cleanups inside oisin-pipeline

- Vestigial xstate assertions in `runtime/gates/gates.test.ts:225` and `runtime/hooks/hooks.test.ts:228`; stale Codex-compatibility mentions in README.
- `config/defaults.ts` (541 lines) holds defaults as inline YAML strings — move them to actual files under `defaults/` (which already exists and ships in `files`) and load at build time.
- The merge logic in `opencode-project-config.ts` and the uncommitted `claude-settings-config.ts` duplicate the same projection/merge pattern — extract one shared `mergeProjectionConfig()` before the Claude Code host work lands, or there'll be a third copy when the next host arrives.
- Naming sprawl: four types for agent output (`AgentResult` / `RunnerOutputEvent` / `RuntimeNormalizedOutput` / `RuntimeStructuredOutput`), three for runtime options. Worth a naming pass during the one-engine refactor since it touches everything anyway.

## Suggested sequence

1. **Finish PIPE-57–69** (one-engine refactor) — don't add scope.
2. **Land the cheap, high-leverage items:** shared event schema export, opencode SDK adoption in agent-node, version-field fix, planner renames, shared merge logic for the uncommitted Claude Code host work.
3. **Infra hygiene:** pin dev-workspace + chart revision, Renovate rule for the runner SHA, decide on Kueue.
4. **Then spike Hatchet** for 1–2 days with one real ticket. That spike decides whether the Argo compiler + console event machinery lives or dies — and either answer simplifies your life: adopt it and delete ~40% of the system, or reject it knowing the custom stack earned its keep.

---

## Appendix: research sources

[Hatchet](https://github.com/hatchet-dev/hatchet) · [opencode server docs](https://opencode.ai/docs/server/) · [opencode SDK docs](https://opencode.ai/docs/sdk/) · [@opencode-ai/sdk npm](https://www.npmjs.com/package/@opencode-ai/sdk) · [Inngest self-hosting](https://www.inngest.com/docs/self-hosting) · [Restate](https://github.com/restatedev/restate) · [Temporal self-hosted guide](https://docs.temporal.io/self-hosted-guide) · [Trigger.dev k8s self-hosting](https://trigger.dev/docs/self-hosting/kubernetes) · [Windmill](https://github.com/windmill-labs/windmill) · [Argo Workflows releases](https://github.com/argoproj/argo-workflows/releases) · [@kubernetes-models/argo-workflows](https://www.npmjs.com/package/@kubernetes-models/argo-workflows) · [vibe-kanban](https://github.com/BloopAI/vibe-kanban) · [claude-squad](https://github.com/smtg-ai/claude-squad) · [OpenHands](https://github.com/OpenHands/OpenHands) · [Centaur](https://github.com/paradigmxyz/centaur) · [agent-sandbox](https://github.com/kubernetes-sigs/agent-sandbox) · [K8s blog: Agent Sandbox](https://kubernetes.io/blog/2026/03/20/running-agents-on-kubernetes-with-agent-sandbox/) · [Claude Agent SDK TS](https://github.com/anthropics/claude-agent-sdk-typescript) · [Dagger AI agents](https://docs.dagger.io/ai-agents) · [tRPC subscriptions](https://trpc.io/docs/server/subscriptions) · [ElectricSQL](https://github.com/electric-sql/electric) · [oRPC](https://github.com/unnoq/orpc) · [kubernetes-fluent-client](https://github.com/defenseunicorns/kubernetes-fluent-client)
