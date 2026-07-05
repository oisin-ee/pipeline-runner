import { z } from "zod";

/**
 * Kubernetes Job manifest builder for factory lanes (create-experiment /
 * template-update). The console front door creates these Jobs directly
 * (batch/v1, NOT an Argo Workflow): a lane is a single deterministic `moka`
 * subcommand with no payload repo, no schedule and no node graph, so the
 * runner-command DAG machinery does not apply. The runner image ENTRYPOINT is
 * `entrypoint-preflight.sh moka`; the Job overrides only the container args,
 * so `args: ["create-experiment", ...]` runs `moka create-experiment ...`.
 *
 * Credential mounts replicate the runner workflow's secret storage shapes
 * (src/remote/argo/storage.ts): the git credential store dir at
 * /etc/pipeline/git-credentials (consumed by runAuthenticatedGit) and the gh
 * hosts.yml at /root/.config/gh/hosts.yml.
 */

export const factoryLaneJobOptionsSchema = z.object({
  activeDeadlineSeconds: z.number().int().positive().default(1800),
  argv: z.array(z.string().min(1)).min(1),
  generateName: z.string().min(1).default("moka-factory-"),
  gitCredentialsSecretName: z.string().min(1),
  githubAuthSecretName: z.string().min(1),
  image: z.string().min(1),
  imagePullPolicy: z.string().min(1).optional(),
  imagePullSecretName: z.string().min(1).optional(),
  labels: z.record(z.string(), z.string()).default({}),
  namespace: z.string().min(1),
  resources: z
    .object({
      limits: z.record(z.string(), z.string()).optional(),
      requests: z.record(z.string(), z.string()).optional(),
    })
    .optional(),
  serviceAccountName: z.string().min(1).optional(),
  ttlSecondsAfterFinished: z.number().int().positive().default(86_400),
});

export type FactoryLaneJobOptionsInput = z.input<
  typeof factoryLaneJobOptionsSchema
>;
export type FactoryLaneJobOptions = z.output<
  typeof factoryLaneJobOptionsSchema
>;

export const FACTORY_LANE_LABEL = "pipeline.oisin.dev/factory-lane";

export const buildFactoryLaneJob = (input: FactoryLaneJobOptionsInput) => {
  const options = factoryLaneJobOptionsSchema.parse(input);
  const lane = options.argv[0] ?? "unknown";

  return {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: {
      generateName: options.generateName,
      labels: { [FACTORY_LANE_LABEL]: lane, ...options.labels },
      namespace: options.namespace,
    },
    spec: {
      activeDeadlineSeconds: options.activeDeadlineSeconds,
      // Lanes have non-idempotent side effects (repo creation, pushed
      // commits); a blind retry could half-duplicate a birth. Fail once,
      // surface the log.
      backoffLimit: 0,
      template: {
        metadata: {
          labels: { [FACTORY_LANE_LABEL]: lane, ...options.labels },
        },
        spec: {
          containers: [
            {
              args: [...options.argv],
              image: options.image,
              ...(options.imagePullPolicy !== undefined &&
              options.imagePullPolicy.length > 0
                ? { imagePullPolicy: options.imagePullPolicy }
                : {}),
              name: "lane",
              ...(options.resources ? { resources: options.resources } : {}),
              volumeMounts: [
                {
                  mountPath: "/etc/pipeline/git-credentials",
                  name: "runner-git-credentials",
                  readOnly: true,
                },
                {
                  mountPath: "/root/.config/gh/hosts.yml",
                  name: "github-auth",
                  readOnly: true,
                  subPath: "hosts.yml",
                },
              ],
            },
          ],
          ...(options.imagePullSecretName !== undefined &&
          options.imagePullSecretName.length > 0
            ? { imagePullSecrets: [{ name: options.imagePullSecretName }] }
            : {}),
          restartPolicy: "Never",
          ...(options.serviceAccountName !== undefined &&
          options.serviceAccountName.length > 0
            ? { serviceAccountName: options.serviceAccountName }
            : {}),
          volumes: [
            {
              name: "runner-git-credentials",
              secret: {
                defaultMode: 0o400,
                secretName: options.gitCredentialsSecretName,
              },
            },
            {
              name: "github-auth",
              secret: {
                items: [{ key: "hosts.yml", path: "hosts.yml" }],
                secretName: options.githubAuthSecretName,
              },
            },
          ],
        },
      },
    },
  };
};
