import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { VERSION } from "../src/index.js";

// Read the manifest rather than a second literal: the two had already
// drifted once (VERSION said 0.1.1 through the whole 0.1.2 release, and
// this test was pinning the wrong one of the pair).
const pkg = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { version: string };

describe("package surface", () => {
  it("exposes the package version", () => {
    expect(VERSION).toBe(pkg.version);
  });
});
