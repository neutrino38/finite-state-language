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
  namespace: "call",
  returns: {
    connected: "the callee answered",
    timeout: "nobody answered in time",
  },
  data: () => ({ tries: 0 }),
  timeout: { delay: 30_000 },
  states: {
    initial_state: {
      enter: () => goto("ringing"),
    },
    ringing: {
      on: {
        "sip:180": () => stay("still ringing"),
        "sip:200": (ev, _c, fx) => fx.sbbReturn("connected", { uri: ev.uri }),
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

const SHARED_CLAUSES = `
import { defineMachine, goto, stay } from "finite-state-language";

function interruptions(target) {
  return {
    "sys:sleep": () => goto("sleeping", "veille"),
    "net:lost": () => goto("recovering", "lien perdu"),
    // la cible vient d'un paramètre : rien à extraire, comme partout
    "ui:back": () => goto(target),
    "ui:noop": () => undefined,
  };
}

const M = defineMachine<Ctx, Ev>()({
  name: "Shared",
  context: () => ({}),
  states: {
    initial_state: {
      on: {
        ...interruptions("recovering"),
        "ui:go": () => goto("working"),
      },
    },
    working: {
      on: {
        ...interruptions("recovering"),
        // celle-ci l'emporte sur le fragment, comme à l'exécution
        "sys:sleep": () => stay("on finit d'abord"),
      },
    },
    recovering: {},
    sleeping: {},
  },
});
`;

describe("clauses partagées entre états (`...fragment()` dans `on`)", () => {
  const [graph] = machineGraphs(SHARED_CLAUSES) as [MachineGraph];

  it("dessine les clauses qu'un fragment apporte à chaque état", () => {
    const hops = graph.edges.map((e) => `${e.from}->${e.to}`);
    expect(hops).toContain("initial_state->sleeping");
    expect(hops).toContain("initial_state->recovering");
    expect(hops).toContain("working->recovering");
  });

  it("ne devine pas une cible que le fragment reçoit en paramètre", () => {
    // `goto(target)` n'a pas de valeur statique : aucune arête. Le clause
    // retombe alors dans « consommé sans effet », l'approximation que
    // l'extracteur fait partout où il ne voit pas de transition.
    const labels = graph.edges.flatMap((e) => e.labels);
    expect(labels.some((l) => l.startsWith("ui:back"))).toBe(false);
    expect(
      graph.consumed.find((c) => c.state === "initial_state")?.events,
    ).toContain("ui:back");
  });

  it("laisse la clause propre de l'état l'emporter sur celle du fragment", () => {
    // `working` redéfinit sys:sleep : self edge, et pas d'arête vers sleeping
    expect(graph.edges.map((e) => `${e.from}->${e.to}`)).not.toContain(
      "working->sleeping",
    );
    const self = graph.edges.find(
      (e) => e.from === "working" && e.to === "working",
    );
    expect(self?.labels).toEqual(["sys:sleep (on finit d'abord)"]);
  });

  it("compte comme consommé ce que le fragment consomme sans effet", () => {
    const consumed = graph.consumed.find((c) => c.state === "recovering");
    expect(consumed).toBeUndefined(); // recovering n'a pas de `on`
    expect(
      graph.consumed.find((c) => c.state === "initial_state")?.events,
    ).toContain("ui:noop");
  });
});

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
    // A bounded block with no `then` leaves by returning its `timeout`
    // outcome, so the edge says which event the host will see.
    expect(timeouts.every((e) => e.to === "[*]")).toBe(true);
    expect(timeouts[0]?.labels).toContain("after 30 s (call:timeout)");
  });

  it("draws nothing for a block that declares delay: infinity", () => {
    const [endless] = machineGraphs(`
      const Bridge = defineSbb<Ctx, Ev, Data, Ret>()({
        name: "Bridge",
        namespace: "bridge",
        returns: { ended: "the dialog ended" },
        data: () => ({}),
        timeout: { delay: "infinity" },
        states: {
          initial_state: {
            on: { "sip:bye": (_e, _c, fx) => fx.sbbReturn("ended", {}) },
          },
        },
      });
    `) as [MachineGraph];
    expect(endless.edges.map((e) => e.labels)).toEqual([
      ["sip:bye (bridge:ended)"],
    ]);
  });

  it("names the block on the state that enters it", () => {
    expect(renderMermaid(host)).toContain("placing : sbb Establish");
  });
});
