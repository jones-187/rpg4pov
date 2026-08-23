import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";

describe("Pi write-boundary packaging", () => {
  it("copies the extension into the runtime image and sets its default path", async () => {
    const dockerfile = await fs.readFile(path.resolve(process.cwd(), "Dockerfile"), "utf8");
    expect(dockerfile).toContain("ENV PI_WRITE_BOUNDARY_EXTENSION_PATH=/app/pi-extensions/write-boundary.ts");
    expect(dockerfile).toContain("COPY --from=builder --chown=nextjs:nodejs /app/pi-extensions /app/pi-extensions");
  });
});
