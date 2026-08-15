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
      "  state initial_state",
      "  state registering",
      "  state ready",
      "  state call_failed",
    ]);
    expect(lines).toContain("  [*] --> initial_state");
  });

  it("renders string shorthands as labeled edges", () => {
    expect(lines).toContain("  call_failed --> ready: ui:call");
  });

  it("summarizes opaque handlers and after in a per-state note", () => {
    const i = lines.indexOf("  note right of registering");
    expect(i).toBeGreaterThan(-1);
    expect(lines.slice(i, i + 4)).toEqual([
      "  note right of registering",
      "    on: sip:registered, sip:ended",
      "    after 30000 ms",
      "  end note",
    ]);
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
