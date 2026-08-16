import { describe, expect, it } from "vitest";
import { defineMachine, failure, goto, stay } from "../src/index.js";

type Ev =
  | { type: "ui:call"; number: string }
  | { type: "sip:registered" }
  | { type: "sip:ended"; cause: string };

const M = defineMachine<Record<string, never>, Ev>()({
  name: "Diagram",
  context: () => ({}),
  states: {
    initial_state: {
      enter() {
        return goto("registering");
      },
    },
    registering: {
      on: {
        "sip:registered": () => goto("ready"),
        "sip:ended": () => stay(),
      },
      after: { delay: 30_000, then: () => failure("no registrar") },
    },
    ready: {
      on: { "ui:call": () => goto("call_failed") },
    },
    call_failed: {
      on: { "ui:call": "ready" }, // the one statically extractable edge
    },
  },
});

describe("§6.1 toMermaid — static structure export", () => {
  const out = M.toMermaid();
  const lines = out.split("\n");

  it("emits a stateDiagram with every state in declaration order", () => {
    expect(lines[0]).toBe("stateDiagram-v2");
    const decls = lines.filter((l) => l.startsWith("  state "));
    expect(decls).toEqual([
      // `initial_state` only has an `enter`, so nothing to describe
      "  state initial_state",
      '  state "registering" as registering',
      '  state "ready" as ready',
      "  state call_failed",
    ]);
    expect(lines).toContain("  [*] --> initial_state");
  });

  it("renders string shorthands as labeled edges", () => {
    expect(lines).toContain("  call_failed --> ready: ui:call");
  });

  it("summarizes opaque handlers and after in the state description", () => {
    const own = lines.filter((l) => l.startsWith("  registering : "));
    expect(own).toEqual([
      "  registering : on: sip:registered, sip:ended",
      "  registering : after 30000 ms",
    ]);
  });

  /**
   * Regression: mermaid 11 (GitHub, mermaid.live) throws "No such shape:
   * undefined" on a `note` attached to a state that appears in no
   * transition — the common case, since handlers are opaque closures.
   */
  it("never emits notes, and keeps described states named", () => {
    const closuresOnly = defineMachine<Record<string, never>, Ev>()({
      name: "NoEdges",
      context: () => ({}),
      states: {
        initial_state: { on: { "sip:registered": () => goto("waiting") } },
        waiting: { on: { "ui:call": () => stay() } },
      },
    });
    const out2 = closuresOnly.toMermaid();
    expect(out2).not.toContain("note");
    // every described state keeps a declaration carrying its own label
    expect(out2).toContain('  state "initial_state" as initial_state');
    expect(out2).toContain('  state "waiting" as waiting');
    expect(out2).toContain("  waiting : on: ui:call");
  });

  it("aliases state names that are not identifier-safe", () => {
    const W = defineMachine<Record<string, never>, Ev>()({
      name: "Weird",
      context: () => ({}),
      states: {
        initial_state: { on: { "ui:call": "on hold" } },
        "on hold": {},
      },
    });
    const w = W.toMermaid();
    expect(w).toContain('  state "on hold" as on_hold');
    expect(w).toContain("  initial_state --> on_hold: ui:call");
  });
});
