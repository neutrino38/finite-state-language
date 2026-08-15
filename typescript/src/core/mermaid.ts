/**
 * Machine.toMermaid() — static structure export (spec §6.1, design §9).
 *
 * Honest about its limits: handlers are opaque closures, so the only
 * statically extractable transitions are string shorthands. Everything
 * else is summarized per state — the events it listens to and its
 * `after` delay — as a note. The dynamic trace (the transition log) is
 * the tool for actual paths.
 */

import type { InternalDef } from "./instance.js";

/** Mermaid node ids must be identifier-like; alias anything else. */
function mermaidId(name: string): string {
  return name.replace(/\W/g, "_");
}

export function renderMermaid(def: InternalDef): string {
  const lines: string[] = ["stateDiagram-v2"];

  // Declare every state explicitly, in declaration order (spec §3.1):
  // the printed machine must show them all, edges or not.
  for (const name of Object.keys(def.states)) {
    const id = mermaidId(name);
    lines.push(id === name ? `  state ${name}` : `  state "${name}" as ${id}`);
  }

  lines.push(`  [*] --> initial_state`);

  for (const [name, sd] of Object.entries(def.states)) {
    const id = mermaidId(name);
    const listened: string[] = [];
    for (const [evType, clause] of Object.entries(sd.on ?? {})) {
      if (typeof clause === "string") {
        // the one statically known edge shape
        lines.push(`  ${id} --> ${mermaidId(clause)}: ${evType}`);
      } else if (clause !== undefined) {
        listened.push(evType);
      }
    }
    const note: string[] = [];
    if (listened.length > 0) note.push(`on: ${listened.join(", ")}`);
    if (sd.after !== undefined) note.push(`after ${sd.after.delay} ms`);
    if (note.length > 0) {
      lines.push(`  note right of ${id}`);
      for (const l of note) lines.push(`    ${l}`);
      lines.push(`  end note`);
    }
  }

  return lines.join("\n");
}
