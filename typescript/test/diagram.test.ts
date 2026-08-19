import { describe, expect, it } from "vitest";
import { machineGraphs, renderMermaid } from "../src/diagram/index.js";
import type { Edge, MachineGraph } from "../src/diagram/index.js";

/**
 * The case `Machine.toMermaid()` cannot see: every handler is a closure
 * returning `goto(…)`, so the live definition exposes no edge at all.
 */
const CLOSURES = `
import { defineMachine, goto, stay, failure, success } from "finite-state-language";

function fail(ctx) {
  if (ctx.retrying) return goto("reconnecting", "auto retry");
  return goto("reg_failed");
}

function clearHistory() {
  return stay("history cleared");
}

function forward(ev, ctx, fx) {
  fx.notify("call", ev);
}

export const Phone = defineMachine<Ctx, Ev>()({
  name: "Phone",
  context: () => ({}),
  states: {
    initial_state: {
      enter(ctx, fx) {
        fx.task(ctx.store.load(), "config");
      },
      on: {
        "task:config": () => goto("home", "config loaded"),
      },
    },
    home: {
      on: {
        "ui:connect": () => goto("connecting"),
        "ui:noop": () => undefined,
        "ui:clearHistory": clearHistory,
      },
    },
    connecting: {
      on: {
        "sip:connected": () => goto("ready", "WebSocket open"),
        "sip:failed": (ev, ctx) => fail(ctx),
        "sip:dropped": (ev, ctx) => fail(ctx),
      },
      after: { delay: 10_000, then: (ctx) => fail(ctx) },
    },
    ready: {
      on: {
        "ui:hangup": forward,
        "ui:quit": () => success("bye"),
        "sip:lost": () => failure("lost"),
        "sip:aborted": () => aborted("aborted"),
      },
    },
    reconnecting: {},
    reg_failed: {},
  },
});
`;

function graph(code: string): MachineGraph {
  const [first] = machineGraphs(code, "fixture.ts");
  if (first === undefined) throw new Error("no machine found in fixture");
  return first;
}

function edge(g: MachineGraph, from: string, to: string): Edge | undefined {
  return g.edges.find((e) => e.from === from && e.to === to);
}

describe("§6.1 diagram — transition graph extracted from source", () => {
  const g = graph(CLOSURES);

  it("reads the machine name and every state in declaration order", () => {
    expect(g.name).toBe("Phone");
    expect(g.states).toEqual([
      "initial_state",
      "home",
      "connecting",
      "ready",
      "reconnecting",
      "reg_failed",
    ]);
  });

  it("recovers the goto targets that toMermaid cannot see", () => {
    expect(edge(g, "initial_state", "home")?.labels).toEqual([
      "task:config (config loaded)",
    ]);
    expect(edge(g, "home", "connecting")?.labels).toEqual(["ui:connect"]);
    expect(edge(g, "connecting", "ready")?.labels).toEqual([
      "sip:connected (WebSocket open)",
    ]);
  });

  it("merges parallel edges so one arrow carries every event that follows it", () => {
    expect(edge(g, "connecting", "reconnecting")?.labels).toEqual([
      "sip:failed (auto retry)",
      "sip:dropped (auto retry)",
      "after 10 s (auto retry)",
    ]);
  });

  it("follows module-level helpers, both branches of them", () => {
    // fail() can reach two targets; guards are ignored, so both are drawn
    expect(edge(g, "connecting", "reg_failed")?.labels).toEqual([
      "sip:failed",
      "sip:dropped",
      "after 10 s",
    ]);
  });

  it("draws stay() as a self edge", () => {
    expect(edge(g, "home", "home")?.labels).toEqual([
      "ui:clearHistory (history cleared)",
    ]);
  });

  it("sends every terminal transition to [*], labelled with its outcome", () => {
    expect(edge(g, "ready", "[*]")?.labels).toEqual([
      "ui:quit (success)",
      "sip:lost (failure)",
      "sip:aborted (aborted)",
    ]);
  });

  it("separates events relayed to a child from events merely consumed", () => {
    expect(g.forwarded).toEqual([{ state: "ready", events: ["ui:hangup"] }]);
    expect(g.consumed).toEqual([{ state: "home", events: ["ui:noop"] }]);
  });

  it("never lists enter or after as consumed events", () => {
    const inert = graph(`
      const M = defineMachine()({
        name: "Inert",
        context: () => ({}),
        states: { initial_state: { enter() {}, after: { delay: 1000, then: () => {} } } },
      });
    `);
    expect(inert.consumed).toEqual([]);
    expect(inert.edges).toEqual([]);
  });
});

describe("§6.1 diagram — next() and descriptions", () => {
  const g = graph(`
    const M = defineMachine()({
      name: "Wizard",
      context: () => ({}),
      states: {
        initial_state: { on: { "ui:go": () => next("step 1") } },
        second: { on: { "ui:go": () => next() } },
        last: { on: { "ui:go": () => next() } },
      },
    });
  `);

  it("resolves next() through declaration order", () => {
    expect(edge(g, "initial_state", "second")?.labels).toEqual([
      "ui:go (step 1)",
    ]);
    expect(edge(g, "second", "last")?.labels).toEqual(["ui:go"]);
  });

  it("draws next() from the last state as the failure the runtime settles with", () => {
    expect(edge(g, "last", "[*]")?.labels).toEqual(["ui:go (failure)"]);
  });

  it("keeps only string-literal descriptions — a template literal has no static value", () => {
    const dynamic = graph(`
      const M = defineMachine()({
        name: "Dynamic",
        context: () => ({}),
        states: {
          initial_state: { on: { "ui:go": (ev) => goto("done", \`call to \${ev.target}\`) } },
          done: {},
        },
      });
    `);
    expect(edge(dynamic, "initial_state", "done")?.labels).toEqual(["ui:go"]);
  });
});

describe("§6.1 diagram — renderMermaid", () => {
  it("emits a stateDiagram with declarations, the initial edge, then arrows", () => {
    const out = renderMermaid(graph(CLOSURES)).split("\n");
    expect(out[0]).toBe("stateDiagram-v2");
    expect(out[1]).toBe("  state initial_state");
    expect(out).toContain("  [*] --> initial_state");
    expect(out).toContain(
      "  connecting --> ready: sip:connected (WebSocket open)",
    );
  });

  it("aliases state names that are not identifier-safe", () => {
    const g = graph(`
      const M = defineMachine()({
        name: "Weird",
        context: () => ({}),
        states: {
          initial_state: { on: { "ui:hold": () => goto("on hold") } },
          "on hold": {},
        },
      });
    `);
    const out = renderMermaid(g);
    expect(out).toContain('  state "on hold" as on_hold');
    expect(out).toContain("  initial_state --> on_hold: ui:hold");
  });

  it("leaves forwarded and consumed events out of the diagram", () => {
    const out = renderMermaid(graph(CLOSURES));
    expect(out).not.toContain("ui:noop");
    expect(out).not.toContain("ui:hangup");
  });
});

describe("§6.1 diagram — several machines per file", () => {
  it("returns one graph per definition, in source order", () => {
    const graphs = machineGraphs(`
      const A = defineMachine()({ name: "A", context: () => ({}), states: { initial_state: {} } });
      const B = defineMachine()({ name: "B", context: () => ({}), states: { initial_state: {} } });
    `);
    expect(graphs.map((g) => g.name)).toEqual(["A", "B"]);
  });

  it("returns nothing for a file that defines no machine", () => {
    expect(machineGraphs("export const x = 1;")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Service Building Blocks (spec §8.4)
// ---------------------------------------------------------------------------

const WITH_BLOCK = `
import { defineMachine, defineSbb, goto, failure, stay } from "finite-state-language";

const Establish = defineSbb<Ctx, Ev, Data, Ret>()({
  name: "Establish",
  data: () => ({ tries: 0 }),
  timeout: { delay: 30_000, then: (_c, fx) => fx.sbbReturn({ type: "call:timeout" }) },
  states: {
    initial_state: {
      enter: () => goto("ringing"),
    },
    ringing: {
      on: {
        "sip:180": () => stay("still ringing"),
        "sip:200": (ev, _c, fx) => fx.sbbReturn({ type: "call:connected", uri: ev.uri }),
        "ui:hangup": () => aborted("caller gave up"),
      },
    },
  },
});

const Host = defineMachine<Ctx, Ev>()({
  name: "Host",
  context: () => ({}),
  states: {
    initial_state: { on: { "ui:dial": () => goto("placing") } },
    placing: {
      enter: (ctx, fx) => { fx.sbb(Establish, { args: { dest: ctx.uri } }); },
      on: {
        "call:connected": () => goto("talking"),
        "call:timeout": () => failure("no answer"),
      },
    },
    talking: {},
  },
});
`;

describe("§8.4 diagram — service building blocks", () => {
  const graphs = machineGraphs(WITH_BLOCK);
  const block = graphs.find((g) => g.name === "Establish") as MachineGraph;
  const host = graphs.find((g) => g.name === "Host") as MachineGraph;

  it("extracts a block alongside the machine, and tells the two apart", () => {
    expect(graphs.map((g) => [g.name, g.kind])).toEqual([
      ["Establish", "block"],
      ["Host", "machine"],
    ]);
  });

  it("records which states enter which block", () => {
    expect(host.blocks).toEqual([{ state: "placing", events: ["Establish"] }]);
    // …and does not also call that enter a consumed event
    expect(host.consumed).toEqual([]);
  });

  it("draws sbbReturn as the way out of the block, labelled by the event", () => {
    const out = block.edges.find(
      (e) => e.from === "ringing" && e.to === "[*]",
    ) as Edge;
    // Leaving a block is leaving its diagram, whether by a return or by
    // a terminal; the label says which, and by which event.
    expect(out.labels).toContain("sip:200 (call:connected)");
    expect(out.labels).toContain("ui:hangup (aborted)");
  });

  it("applies the block's own deadline to each of its states", () => {
    const timeouts = block.edges.filter((e) =>
      e.labels.some((l) => l.startsWith("after 30 s")),
    );
    expect(timeouts.map((e) => e.from).sort()).toEqual([
      "initial_state",
      "ringing",
    ]);
  });

  it("names the block on the state that enters it", () => {
    expect(renderMermaid(host)).toContain("placing : sbb Establish");
  });
});
