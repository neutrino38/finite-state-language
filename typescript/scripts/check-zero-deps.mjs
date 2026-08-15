// CI guard: the core must keep zero runtime dependencies (spec §1.4).
import { readFileSync } from "node:fs";

const pkg = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);
const deps = Object.keys(pkg.dependencies ?? {});

if (deps.length > 0) {
  console.error(
    `finite-state-language must have zero runtime dependencies; found: ${deps.join(", ")}`,
  );
  process.exit(1);
}
console.log("zero runtime dependencies: OK");
