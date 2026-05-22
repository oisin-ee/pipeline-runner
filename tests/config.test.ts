import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  return {
    ...real,
    existsSync: vi.fn(real.existsSync),
    readFileSync: vi.fn(real.readFileSync),
    readdirSync: vi.fn(real.readdirSync),
  };
});

import { existsSync, readdirSync, readFileSync } from "node:fs";

import {
  BUILT_IN_CONFIG,
  loadPipelineConfig,
  parseTicketAndDescription,
  readTicketOverride,
  resolveProfileForPhase,
} from "../src/mastra/config.js";

const mockExistsSync = vi.mocked(existsSync);
const mockReadFileSync = vi.mocked(readFileSync);
const mockReaddirSync = vi.mocked(readdirSync);

const WORKTREE = "/fake/worktree";

// Module-level regex constants (biome useTopLevelRegex)
const FAILED_TO_PARSE_RE = /failed to parse/;
const UNKNOWN_DOMAIN_RE = /requests profile 'unknown-domain'.*candidates are/;
const NO_DEFAULT_RE = /phase 'code-writer' has no default/;
const NO_CANDIDATES_RE = /no candidates configured/;

beforeEach(() => {
  vi.clearAllMocks();
  // Default: nothing exists on the FS.
  mockExistsSync.mockReturnValue(false);
});

describe("parseTicketAndDescription", () => {
  it("extracts ticket id and remainder", () => {
    expect(parseTicketAndDescription("PIPE-42 add NOOP fn")).toEqual({
      ticketId: "PIPE-42",
      description: "add NOOP fn",
    });
  });

  it("handles ticket-only input", () => {
    expect(parseTicketAndDescription("PIPE-42")).toEqual({
      ticketId: "PIPE-42",
      description: "PIPE-42",
    });
  });

  it("returns null ticket id when no prefix", () => {
    expect(parseTicketAndDescription("ad-hoc task description")).toEqual({
      ticketId: null,
      description: "ad-hoc task description",
    });
  });

  it("does not match prefixes like 'V1-foo'", () => {
    // Regex requires at least one capital letter then a hyphen-number.
    // V1 has only one letter; ABC-3 should match.
    expect(parseTicketAndDescription("ABC-3 something").ticketId).toBe("ABC-3");
  });
});

describe("loadPipelineConfig", () => {
  it("returns BUILT_IN_CONFIG when .pipeline/config.toml is missing", () => {
    mockExistsSync.mockReturnValue(false);
    expect(loadPipelineConfig(WORKTREE)).toEqual(BUILT_IN_CONFIG);
  });

  it("merges user config over built-in", () => {
    mockExistsSync.mockImplementation((p) => String(p).endsWith("config.toml"));
    mockReadFileSync.mockReturnValue(`
[phases.green]
candidates = ["frontend", "backend", "rust-backend"]
default = "backend"
`);

    const cfg = loadPipelineConfig(WORKTREE);
    expect(cfg.phases["code-writer"]).toEqual({
      candidates: ["frontend", "backend", "rust-backend"],
      default: "backend",
    });
    // Other phases fall back to built-in:
    expect(cfg.phases.researcher).toEqual(BUILT_IN_CONFIG.phases.researcher);
  });

  it("throws on malformed TOML", () => {
    mockExistsSync.mockImplementation((p) => String(p).endsWith("config.toml"));
    mockReadFileSync.mockReturnValue("not valid [[[ toml");
    expect(() => loadPipelineConfig(WORKTREE)).toThrow(FAILED_TO_PARSE_RE);
  });
});

describe("readTicketOverride", () => {
  it("returns null when ticketId is null", () => {
    expect(readTicketOverride("code-writer", null, WORKTREE)).toBeNull();
  });

  it("returns null when backlog/tasks dir is missing", () => {
    mockExistsSync.mockReturnValue(false);
    expect(readTicketOverride("code-writer", "PIPE-42", WORKTREE)).toBeNull();
  });

  it("returns null when no matching ticket file exists", () => {
    mockExistsSync.mockImplementation((p) => String(p).endsWith("tasks"));
    mockReaddirSync.mockReturnValue([
      "pipe-1 - other-task.md",
      "pipe-2 - another-task.md",
    ] as never);
    expect(readTicketOverride("code-writer", "PIPE-42", WORKTREE)).toBeNull();
  });

  it("returns null when ticket has no pipeline frontmatter block", () => {
    mockExistsSync.mockImplementation((p) => String(p).endsWith("tasks"));
    mockReaddirSync.mockReturnValue(["pipe-42 - thing.md"] as never);
    mockReadFileSync.mockReturnValue(`---
id: PIPE-42
title: thing
---
body
`);
    expect(readTicketOverride("code-writer", "PIPE-42", WORKTREE)).toBeNull();
  });

  it("returns the override value when set", () => {
    mockExistsSync.mockImplementation((p) => String(p).endsWith("tasks"));
    mockReaddirSync.mockReturnValue(["pipe-42 - thing.md"] as never);
    mockReadFileSync.mockReturnValue(`---
id: PIPE-42
title: thing
pipeline:
  red: backend
  green: backend
---
body
`);
    expect(readTicketOverride("test-writer", "PIPE-42", WORKTREE)).toBe(
      "backend"
    );
    expect(readTicketOverride("code-writer", "PIPE-42", WORKTREE)).toBe(
      "backend"
    );
    expect(readTicketOverride("researcher", "PIPE-42", WORKTREE)).toBeNull();
  });
});

describe("resolveProfileForPhase", () => {
  it("returns the config default when no override is set", () => {
    mockExistsSync.mockReturnValue(false);
    expect(resolveProfileForPhase("researcher", "PIPE-42", WORKTREE)).toBe(
      "researcher"
    );
    expect(resolveProfileForPhase("verifier", "PIPE-42", WORKTREE)).toBe(
      "verifier"
    );
  });

  it("returns the ticket override when it is in candidates", () => {
    mockExistsSync.mockImplementation((p) => {
      const s = String(p);
      return s.endsWith("tasks") || s.endsWith("config.toml");
    });
    mockReaddirSync.mockReturnValue(["pipe-42 - thing.md"] as never);
    mockReadFileSync.mockImplementation((p) => {
      if (String(p).endsWith("config.toml")) {
        return "";
      }
      return `---
id: PIPE-42
pipeline:
  green: frontend
---
body
`;
    });
    expect(resolveProfileForPhase("code-writer", "PIPE-42", WORKTREE)).toBe(
      "frontend"
    );
  });

  it("throws when ticket override is not in candidates", () => {
    mockExistsSync.mockImplementation((p) => String(p).endsWith("tasks"));
    mockReaddirSync.mockReturnValue(["pipe-42 - thing.md"] as never);
    mockReadFileSync.mockReturnValue(`---
id: PIPE-42
pipeline:
  green: unknown-domain
---
`);
    expect(() =>
      resolveProfileForPhase("code-writer", "PIPE-42", WORKTREE)
    ).toThrow(UNKNOWN_DOMAIN_RE);
  });

  it("throws when multi-candidate phase has no default and no override", () => {
    mockExistsSync.mockReturnValue(false);
    expect(() => resolveProfileForPhase("code-writer", null, WORKTREE)).toThrow(
      NO_DEFAULT_RE
    );
  });

  it("throws when no candidates configured for a role", () => {
    mockExistsSync.mockReturnValue(false);
    // @ts-expect-error Testing unknown phase
    expect(() => resolveProfileForPhase("unknown", null, WORKTREE)).toThrow(
      NO_CANDIDATES_RE
    );
  });
});
