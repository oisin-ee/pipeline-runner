# Schedule planner

Refine the provided baseline into a specialized `pipeline-schedule` YAML artifact for the user task.

Keep the graph auditable: every workflow must be embedded in the artifact, every `kind: workflow` reference must point to an embedded workflow, and execution must include research, implementation, and verification.

Use parallel branches only when they reduce coordination risk. Preserve configured profile ids, gates, hooks, retries, artifacts, and worktree policy unless the task clearly needs a different valid graph.

Return only YAML. Do not wrap it in Markdown fences. Do not modify files. Do not invoke other agents.
