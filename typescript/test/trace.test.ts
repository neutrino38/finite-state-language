/**
 * The trace of a run and its sequence diagram (spec §6.2): off by
 * default, started once, stamped, fed by the binding, rendered like
 * FSL Elixir's `FSL.Diagram.Mermaid`.
 */
import { describe, expect, it, vi } from "vitest";
import {
  defineMachine,
  defineSbb,
  failure,
  goto,
  stay,
  success,
  traceToMermaid,
  type ChildExit,
  type Trace,
  type TraceEvent,
} from "../src/index.js";

type Ev =
  | { type: "ui:call" }
  | { type: "sip:progress" }
  | { type: "sip:accepted" }
  | { type: "sip:bye" }
  | { type: "debug:on" };

const Phone = defineMachine<Record<string, never>, Ev>()({
  name: "Phone",
  context: () => ({}),
  states: {
    initial_state: { enter: () => goto("ready") },
    ready: {
      on: {
        "ui:call": () => goto("calling", "dialling"),
        "debug:on": (_ev, _ctx, fx) => {
          fx.startTrace();
          return stay("tracing from here");
        },
      },
    },
    calling: {
      on: {
        "sip:progress": () => stay("ringing"),
        "sip:accepted": () => goto("talking", "200 OK"),
      },
      after: { delay: 1_000, then: () => failure("no answer") },
    },
    talking: { on: { "sip:bye": () => success("hung up") } },
  },
});

const kinds = (t: Trace | undefined): string[] =>
  (t?.events ?? []).map((e) =>
    e.kind === "transition" ? `${e.from}>${e.to}` : e.kind,
  );

describe("§6.2 the trace", () => {
  it("is off by default, and record() is then a no-op", () => {
    const m = Phone.start();
    m.record({ kind: "message", dir: "out", lane: "c1", label: "INVITE" });
    expect(m.trace).toBeUndefined();
  });

  it("stamps every log entry, traced or not", () => {
    const m = Phone.start();
    for (const e of m.log) expect(typeof e.at).toBe("number");
    expect(m.log.length).toBeGreaterThan(0);
  });

  it("records the whole run from the start, with its terminal", () => {
    const m = Phone.start({ trace: true });
    m.send({ type: "ui:call" });
    m.send({ type: "sip:accepted" });
    m.send({ type: "sip:bye" });
    const t = m.trace;
    expect(t?.machine).toBe("Phone");
    expect(kinds(t)).toEqual([
      "(start)>initial_state",
      "initial_state>ready",
      "ready>calling",
      "calling>talking",
      "terminal",
    ]);
    const last = t?.events.at(-1);
    expect(last).toMatchObject({ outcome: "success", reason: "hung up" });
    // Still readable once the machine is done.
    expect(m.trace?.events).toHaveLength(5);
  });

  it("tells what the machine caused from what arrived", () => {
    vi.useFakeTimers();
    try {
      const m = Phone.start({ trace: true });
      m.send({ type: "ui:call" });
      vi.advanceTimersByTime(1_000); // the `after` fires
      const internal = (m.trace?.events ?? []).map((e) =>
        e.kind === "transition" ? e.internal : e.kind,
      );
      // start, initial_state -> ready (enter), ui:call, then the after.
      expect(internal).toEqual([true, true, false, "terminal"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("starts mid-run from a handler, at the transition it returns, once", () => {
    const m = Phone.start();
    m.send({ type: "debug:on" });
    const first = m.trace;
    expect(kinds(first)).toEqual(["ready>ready"]);
    m.send({ type: "debug:on" }); // a second start keeps the running trace
    expect(m.trace?.t0).toBe(first?.t0);
    expect(m.trace?.events).toHaveLength(2);
    m.startTrace();
    expect(m.trace?.t0).toBe(first?.t0);
  });

  it("orders by `at` a message the binding stamped on its own clock", () => {
    const m = Phone.start({ trace: true });
    const t0 = m.trace?.t0 ?? 0;
    m.send({ type: "ui:call" });
    m.record({
      kind: "message",
      dir: "out",
      lane: "c1",
      label: "INVITE",
      at: t0 - 1,
    });
    expect(m.trace?.events[0]).toMatchObject({ kind: "message" });
  });

  it("keeps at most `traceSize` events, dropping the oldest", () => {
    const m = Phone.start({ trace: true, traceSize: 3 });
    m.send({ type: "ui:call" });
    m.send({ type: "sip:progress" });
    m.send({ type: "sip:progress" });
    expect(kinds(m.trace)).toEqual([
      "ready>calling",
      "calling>calling",
      "calling>calling",
    ]);
  });

  it("marks a block's return as the machine's own doing", () => {
    type Ret = { type: "ask:done"; data: Record<string, never> };
    type BEv = { type: "go" } | { type: "sip:ok" };
    const Ask = defineSbb<
      Record<string, never>,
      BEv,
      Record<string, never>,
      Ret
    >()({
      name: "Ask",
      namespace: "ask",
      returns: { done: "asked" },
      data: () => ({}),
      timeout: { delay: "infinity" },
      states: {
        initial_state: {
          on: { "sip:ok": (_e, _c, fx) => fx.sbbReturn("done", {}) },
        },
      },
    });
    const Host = defineMachine<Record<string, never>, BEv | Ret>()({
      name: "Host",
      context: () => ({}),
      states: {
        initial_state: {
          on: {
            go: (_e, _c, fx) => fx.sbb(Ask),
            "ask:done": () => goto("asked"),
          },
        },
        asked: {},
      },
    });
    const m = Host.start({ trace: true });
    m.send({ type: "go" });
    m.send({ type: "sip:ok" });
    const byEvent = new Map(
      (m.trace?.events ?? []).flatMap((e) =>
        e.kind === "transition" && e.event !== undefined
          ? [[e.event, e.internal] as const]
          : [],
      ),
    );
    // `ask:done` is the block talking back to its host: nobody on the
    // wire sent it, whatever its namespace looks like.
    expect(byEvent.get("ask:done")).toBe(true);
  });

  it("is inherited by a child, which traces its own run", async () => {
    type CEv = { type: "stop" };
    const Child = defineMachine<Record<string, never>, CEv>()({
      name: "Child",
      context: () => ({}),
      states: { initial_state: { on: { stop: () => success("stopped") } } },
    });
    const Parent = defineMachine<Record<string, never>, ChildExit>()({
      name: "Parent",
      context: () => ({}),
      states: {
        initial_state: {
          enter: (_c, fx) => fx.spawn(Child, { as: "kid" }),
          on: { "child:exit": () => success("child gone") },
        },
      },
    });
    const m = Parent.start({ trace: true });
    await m.shutdown();
    expect(m.trace?.events.at(-1)).toMatchObject({ kind: "terminal" });
  });
});

describe("§6.2 traceToMermaid", () => {
  const at = (ms: number) => 1_000 + ms;
  const run = (events: TraceEvent[]): Trace => ({
    machine: "Phone",
    t0: 1_000,
    events,
  });
  const base: TraceEvent[] = [
    {
      kind: "transition",
      at: at(0),
      from: "(start)",
      to: "initial_state",
      internal: true,
    },
    {
      kind: "transition",
      at: at(0),
      from: "initial_state",
      to: "ready",
      internal: true,
    },
    {
      kind: "transition",
      at: at(12),
      from: "ready",
      to: "calling",
      event: "ui:call",
      desc: "dialling",
      internal: false,
    },
    {
      kind: "transition",
      at: at(412),
      from: "calling",
      to: "talking",
      event: "sip:accepted",
      desc: "200 OK",
      internal: false,
    },
    { kind: "terminal", at: at(3_000), outcome: "success", reason: "hung up" },
  ];

  it("draws an untraced run: +Nms, an arrow per peer event, notes for the rest", () => {
    const out = traceToMermaid(run(base), {
      label: "Alice",
      peer: "the proxy",
      lane: (type) => (type.startsWith("ui:") ? "local" : "peer"),
    });
    expect(out.split("\n")).toEqual([
      "%% Machine : Phone",
      "sequenceDiagram",
      "    participant local as Alice",
      "    participant peer as the proxy",
      "    Note over local: +0ms initial_state",
      "    Note over local: +0ms initial_state -> ready",
      "    Note over local: +12ms ready -> calling: dialling",
      "    peer->>local: +412ms sip:accepted",
      "    Note over local: +412ms calling -> talking: 200 OK",
      "    Note over local: +3000ms success: hung up",
    ]);
  });

  it("by default draws every event the machine did not cause as from the peer", () => {
    const out = traceToMermaid(run(base));
    expect(out).toContain("    participant local as Phone");
    expect(out).toContain("    participant peer\n");
    expect(out).toContain("    peer->>local: +12ms ui:call");
  });

  it("switches to traced mode on one message: a lane per conversation", () => {
    const out = traceToMermaid(
      run([
        ...base.slice(0, 3),
        {
          kind: "message",
          at: at(13),
          dir: "out",
          lane: "c1",
          party: "outbound",
          peer: "10.0.0.1:5060/udp",
          label: "INVITE",
        },
        {
          kind: "message",
          at: at(15),
          dir: "in",
          lane: "c1",
          label: "100 Trying",
          reply: true,
        },
        {
          kind: "message",
          at: at(20),
          dir: "out",
          lane: "c1",
          label: "INVITE",
          repeat: true,
        },
        { kind: "message", at: at(30), dir: "in", lane: "c2", label: "NOTIFY" },
        base[3] as TraceEvent,
      ]),
    ).split("\n");
    expect(out).toContain("%%   peer1: outbound 10.0.0.1:5060/udp — c1");
    expect(out).toContain(
      "    participant peer1 as outbound 10.0.0.1:5060/udp",
    );
    expect(out).toContain("    participant peer2 as peer 2");
    expect(out).not.toContain("    participant peer");
    expect(out).toContain("    local->>peer1: +13ms INVITE");
    expect(out).toContain("    peer1-->>local: +15ms 100 Trying");
    expect(out).toContain("    local-)peer1: +20ms INVITE");
    expect(out).toContain("    peer2->>local: +30ms NOTIFY");
    // the arrows are the real messages now
    expect(out.filter((l) => l.includes("sip:accepted"))).toEqual([]);
  });

  it("skips an event of a kind it does not know", () => {
    const odd = { kind: "command", at: at(5), name: "send_INVITE" };
    const out = traceToMermaid(run([base[0] as TraceEvent, odd as never]));
    expect(out).not.toContain("send_INVITE");
  });

  it("neutralises what would break a Mermaid line, and never leaves a label empty", () => {
    const out = traceToMermaid(
      run([
        {
          kind: "message",
          at: at(1),
          dir: "in",
          lane: "c#1",
          label: "a;b#c\nd",
        },
        { kind: "message", at: at(2), dir: "in", lane: "c#1", label: "" },
      ]),
    );
    expect(out).toContain("peer1->>local: +1ms a#59;b#35;c d");
    expect(out).toContain("peer1->>local: +2ms");
    expect(traceToMermaid(run([]), { label: "" })).toContain(
      "participant local as ?",
    );
  });

  it("draws a real run end to end", () => {
    const m = Phone.start({ trace: true });
    m.send({ type: "ui:call" });
    m.record({ kind: "message", dir: "out", lane: "c1", label: "INVITE" });
    m.send({ type: "sip:accepted" });
    const out = traceToMermaid(m.trace as Trace);
    expect(out).toMatch(/local->>peer1: \+\d+ms INVITE/);
    expect(out).toMatch(/Note over local: \+\d+ms calling -> talking: 200 OK/);
  });
});
