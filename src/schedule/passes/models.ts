import { Option } from "effect";

import type { PipelineConfig } from "../../config";
import type { ScheduleArtifact } from "../../planning/generate";

type Workflow = PipelineConfig["workflows"][string];
type WorkflowNode = Workflow["nodes"][number];
type NodeTemplate =
  PipelineConfig["scheduler"]["node_catalogs"][string]["nodes"][string];

const nodeModelsOrCatalog = (
  node: WorkflowNode & { kind: "agent" },
  template: NodeTemplate
) =>
  node.models !== undefined && node.models.length > 0
    ? node.models
    : template.models;

const nodeCatalogTemplateFor = (
  node: WorkflowNode & { kind: "agent" },
  templates: PipelineConfig["scheduler"]["node_catalogs"][string]["nodes"]
): Option.Option<NodeTemplate> => {
  if (Object.hasOwn(templates, node.id)) {
    return Option.some(templates[node.id]);
  }
  const byCategory = Object.values(templates).find((candidate) =>
    node.id.includes(candidate.category)
  );
  if (byCategory !== undefined) {
    return Option.some(byCategory);
  }
  return Option.fromUndefinedOr(
    Object.values(templates).find(
      (candidate) => candidate.profile === node.profile
    )
  );
};

const applyNodeCatalogModelsToAgentNode = (
  node: WorkflowNode & { kind: "agent" },
  templates: PipelineConfig["scheduler"]["node_catalogs"][string]["nodes"]
): WorkflowNode => {
  const template = nodeCatalogTemplateFor(node, templates);
  return Option.match(template, {
    onNone: () => node,
    onSome: (resolved) => ({
      ...node,
      category: node.category ?? resolved.category,
      models: nodeModelsOrCatalog(node, resolved),
      reasoning_effort: node.reasoning_effort ?? resolved.reasoning_effort,
    }),
  });
};

const applyNodeCatalogModelsToNode = (
  node: WorkflowNode,
  templates: PipelineConfig["scheduler"]["node_catalogs"][string]["nodes"]
): WorkflowNode => {
  if (node.kind === "agent") {
    return applyNodeCatalogModelsToAgentNode(node, templates);
  }
  if (node.kind !== "parallel") {
    return node;
  }
  return {
    ...node,
    nodes: node.nodes.map((child) =>
      applyNodeCatalogModelsToNode(child, templates)
    ),
  };
};

export const applyNodeCatalogModelFallbacks = (
  config: PipelineConfig,
  catalogId: Option.Option<string>,
  artifact: ScheduleArtifact
): ScheduleArtifact =>
  Option.match(catalogId, {
    onNone: () => artifact,
    onSome: (resolvedCatalogId) => {
      if (!Object.hasOwn(config.scheduler.node_catalogs, resolvedCatalogId)) {
        return artifact;
      }
      const catalog = config.scheduler.node_catalogs[resolvedCatalogId];
      return {
        ...artifact,
        workflows: Object.fromEntries(
          Object.entries(artifact.workflows).map(([workflowId, workflow]) => [
            workflowId,
            {
              ...workflow,
              nodes: workflow.nodes.map((node) =>
                applyNodeCatalogModelsToNode(node, catalog.nodes)
              ),
            },
          ])
        ),
      };
    },
  });
