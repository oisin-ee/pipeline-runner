# Schedule planner

Generate a constrained agent graph as a specialized `pipeline-schedule` YAML artifact for the user task.

Keep the graph auditable: every workflow must be embedded in the artifact, every `kind: workflow` reference must point to an embedded workflow, and execution must include research, implementation, and verification.

Use the provided backlog work units as the source of truth when present. Assign exactly one implementation branch to each work unit, include its `task_context`, use only allowed configured profiles/workflows, and ensure implementation work has downstream acceptance, verification, or review coverage. Do not invent profiles, workflows, or node-level skill overrides.

Return only YAML. Do not wrap it in Markdown fences. Do not modify files. Do not invoke other agents.
