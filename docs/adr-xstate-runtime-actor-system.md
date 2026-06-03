# ADR: XState Runtime Actor System

Status: Accepted

Date: 2026-06-03

## Decision

Pipeline runtime lifecycle behavior is owned by an XState v5 actor system. Workflow scheduling, node execution, retry, gate evaluation, and hook invocation are modeled as explicit machines created with `setup(...).createMachine(...)`.

Raw XState inspection is diagnostic. CLI, console, and runner integrations consume stable domain runtime events and the existing public `PipelineRuntimeEvent` variants unless a future ticket extends those contracts with tests.

## Rationale

The former runtime mixed scheduling loops, node state reducers, hook/gate helpers, and `p-retry` orchestration in one large module. That made lifecycle states implicit and made retry a side effect of an external helper instead of an observable runtime phase.

XState v5 gives the runtime:

- explicit lifecycle states for workflow, node, hook, and gate actors;
- invoked actors for awaited work rather than async actions;
- explicit retry states with guard-based retry eligibility;
- actor inspection for diagnostics without making raw inspection the public contract;
- stable actor IDs for pipeline, workflow, node, gate, and hook diagnostics.

## Consequences

Runtime code should integrate through machine actors and typed runtime observability events. New lifecycle behavior must be represented as machine states or events before it is wired into `runPipelineFromConfig`.

Retries are modeled by `nodeExecutionMachine` and runtime retry policy. New retry behavior must not reintroduce `p-retry` orchestration.

## References

- XState setup: https://stately.ai/docs/setup
- XState invoke: https://stately.ai/docs/invoke
- XState actors: https://stately.ai/docs/actors
- XState inspection: https://stately.ai/docs/inspection
- XState system: https://stately.ai/docs/system
- XState tags: https://stately.ai/docs/tags
