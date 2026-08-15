import { describe, expect, it } from "vitest";
import { VERSION } from "../src/index.js";

describe("M0 scaffold", () => {
  it("exposes an importable (empty) public API", () => {
    expect(VERSION).toBe("0.0.0");
  });
});
