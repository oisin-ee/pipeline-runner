import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("runtime observability adapter removal", () => {
  it("deletes the legacy inspection bridge in favour of direct runtime/gate/hook/pipeline emits", () => {
    const legacyBridgePath = join(
      process.cwd(),
      "src",
      "runtime-observability-inspection.ts"
    );

    expect(existsSync(legacyBridgePath)).toBe(false);
  });
});
