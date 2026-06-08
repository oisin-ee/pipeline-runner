import { vi } from "vitest";

export function cleanGitClient(overrides: Record<string, unknown> = {}) {
  return {
    add: vi.fn(async () => undefined),
    addConfig: vi.fn(async () => undefined),
    branch: vi.fn(async () => ({ current: "pipeline/run-123" })),
    branchLocal: vi.fn(async () => ({ branches: { "pipeline/run-123": {} } })),
    commit: vi.fn(async () => undefined),
    push: vi.fn(async () => undefined),
    revparse: vi.fn(async () => "abc123\n"),
    status: vi.fn(async () => ({ files: [] })),
    ...overrides,
  };
}

export function cleanSimpleGitMock(overrides: Record<string, unknown> = {}) {
  return vi.fn(() => cleanGitClient(overrides));
}
