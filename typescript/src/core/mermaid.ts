/**
 * Machine.toMermaid() — static structure export (spec §6.1, design §9).
 *
 * Honest about its limits: handlers are opaque closures, so the only
 * statically extractable transitions are string shorthands. Everything
 * else is summarized per state — the events it listens to and its
 * `after` delay — as the state's description. The dynamic trace (the
 * transition log) is the tool for actual paths.
 *
 * The summary is a description and not a `note` on purpose. Mermaid 11
 * (the renderer GitHub and mermaid.live use) fails the whole diagram with
 * "No such shape: undefined" when a note is attached to a state that
 * appears in no transition — and that is the common case here, since a
 * machine whose handlers are all closures yields no extractable edges at
 * all. Descriptions render everywhere.
 */

import type { InternalDef } from "./instance.js";

/** Mermaid node ids must be identifier-like; alias anything else. */
function mermaidId(name: string): string {
  return name.replace(/\W/g, "_");
}

export function renderMermaid(def: InternalDef): string {
  const decls: string[] = [];
  const edges: string[] = [];
  const descs: string[] = [];

  for (const [name, sd] of Object.entries(def.states)) {
    const id = mermaidId(name);

    const listened: string[] = [];
    for (const [evType, clause] of Object.entries(sd.on ?? {})) {
      if (typeof clause === "string") {
        // the one statically known edge shape
        edges.push(`  ${id} --> ${mermaidId(clause)}: ${evType}`);
      } else if (clause !== undefined) {
        listened.push(evType);
      }
    }
    const summary: string[] = [];
    if (listened.length > 0) summary.push(`on: ${listened.join(", ")}`);
    if (sd.after !== undefined) summary.push(`after ${sd.after.delay} ms`);
    for (const line of summary) descs.push(`  ${id} : ${line}`);

    // Declare every state explicitly, in declaration order (spec §3.1):
    // the printed machine must show them all, edges or not. A described
    // state needs the quoted form — mermaid drops a bare `state x`
    // declaration's own label as soon as a description is attached, so
    // `state x` + `x : on: …` would print the summary and lose the name.
    const bare = id === name && summary.length === 0;
    decls.push(bare ? `  state ${name}` : `  state "${name}" as ${id}`);
  }

  return [
    "stateDiagram-v2",
    ...decls,
    `  [*] --> initial_state`,
    ...edges,
    ...descs,
  ].join("\n");
}
