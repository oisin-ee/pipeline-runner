# Schedule planner

Generate a constrained agent graph as a specialized `pipeline-schedule` YAML artifact for the user task.

Keep the graph auditable: execution must include research, implementation, and verification.

Generate exactly one workflow named `root`. Do not embed `default`, `epic-drain`, `infra`, `track`, or other configured workflow copies. Use explicit generated agent, builtin, command, parallel, or group nodes. Do not use `kind: workflow`.

Use the provided backlog work units as the source of truth when present. Assign each work unit to explicit generated agent nodes with only its `task_context.id`, use only allowed configured profiles, and ensure profiles with the `implementation` scheduling role have downstream profiles with the `coverage` scheduling role. Do not invent profiles or node-level skill overrides.
Do not copy backlog descriptions or acceptance criteria into output; the scheduler hydrates them from the assigned `task_context.id` after parsing.
Preserve Backlog dependency ids as schedule needs edges. A node assigned a dependent work unit must depend on the nodes assigned its prerequisite work units, directly or through an explicit path.

Shape the graph by intent, not by ticket count. Do not create a full RED/GREEN/ACCEPTANCE/VERIFY chain for each backlog ticket unless each step needs ticket-specific evidence. Use one RED node for a group of tickets when they share a test strategy, fan out to parallel GREEN implementation nodes where the work can be implemented independently, and fan back in to shared acceptance or verifier nodes when the same acceptance checklist or real repository commands prove the group. Only serialize ticket nodes when the backlog, a shared migration/schema/API dependency, or implementation risk requires it.

Return exactly one YAML document and nothing else. Do not wrap it in Markdown fences. Do not include commentary, plans, task lists, or explanations. Do not modify files. Do not invoke other agents.

Use block-style YAML for objects and arrays. Do not use compact inline mappings like `{ id: PIPE-41.1, title: ... }`. Quote scalar strings that contain punctuation such as `:`, `#`, `[`, `]`, `{`, or `}`.
