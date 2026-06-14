import type { PipelineConfig } from "../../config";
import type { ScheduleArtifact } from "../../planning/generate";

type Workflow = PipelineConfig["workflows"][string];
type WorkflowNode = Workflow["nodes"][number];

export function applyNodeCatalogModelFallbacks(
  config: PipelineConfig,
  catalogId: string | undefined,
  artifact: ScheduleArtifact
): ScheduleArtifact {
  if (!catalogId) {
    return artifact;
  }
  const catalog = config.scheduler.node_catalogs[catalogId];
  if (!catalog) {
    return artifact;
  }
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
}

function applyNodeCatalogModelsToNode(
  node: WorkflowNode,
  templates: PipelineConfig["scheduler"]["node_catalogs"][string]["nodes"]
): WorkflowNode {
  switch (node.kind) {
    case "agent":
      return applyNodeCatalogModelsToAgentNode(node, templates);
    case "parallel":
      return applyNodeCatalogModelsToParallelNode(node, templates);
    default:
      return node;
  }
}

function applyNodeCatalogModelsToParallelNode(
  node: WorkflowNode & { kind: "parallel" },
  templates: PipelineConfig["scheduler"]["node_catalogs"][string]["nodes"]
): WorkflowNode {
  return {
    ...node,
    nodes: node.nodes.map((child) =>
      applyNodeCatalogModelsToNode(child, templates)
    ),
  };
}

function applyNodeCatalogModelsToAgentNode(
  node: WorkflowNode & { kind: "agent" },
  templates: PipelineConfig["scheduler"]["node_catalogs"][string]["nodes"]
): WorkflowNode {
  const template = nodeCatalogTemplateFor(node, templates);
  if (!template) {
    return node;
  }
  return {
    ...node,
    category: node.category ?? template.category,
    models: nodeModelsOrCatalog(node, template),
  };
}

function nodeModelsOrCatalog(
  node: WorkflowNode & { kind: "agent" },
  template: PipelineConfig["scheduler"]["node_catalogs"][string]["nodes"][string]
): string[] | undefined {
  return node.models?.length ? node.models : template.models;
}

function nodeCatalogTemplateFor(
  node: WorkflowNode & { kind: "agent" },
  templates: PipelineConfig["scheduler"]["node_catalogs"][string]["nodes"]
) {
  return (
    templates[node.id] ??
    Object.values(templates).find((candidate) =>
      node.id.includes(candidate.category)
    ) ??
    Object.values(templates).find(
      (candidate) => candidate.profile === node.profile
    )
  );
}
