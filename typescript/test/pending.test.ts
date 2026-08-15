import { describe, expect, it } from "vitest";
import { defineMachine, goto, stay } from "../src/index.js";

type Ev =
  | { type: "move" }
  | { type: "tick" }
  | { type: "x1" }
  | { type: "x2" }
  | { type: "x3" }
  | { type: "ui:stale" }
  | { type: "sip:keep" };

describe("§4.2 the pending queue (selective receive)", () => {
  it("an unmatched event is pended, not dropped, and is inspectable", () => {
    const M = defineMachine<Record<string, never>, Ev>()({
      name: "T",
      context: () => ({}),
      states: {
        initial_state: { on: { move: () => goto("second") } },
        second: {},
      },
    });
    const m = M.start();
    m.send({ type: "x1" });
    expect(m.pending.map((e) => e.type)).toEqual(["x1"]);
    expect(m.getSnapshot().pending.map((e) => e.type)).toEqual([]);
    m.send({ type: "move" });
    // snapshot is rebuilt on transition and now shows the queue
    expect(m.getSnapshot().pending.map((e) => e.type)).toEqual(["x1"]);
  });

  it("pended events are replayed in arrival order on state entry", () => {
    const handled: string[] = [];
    const M = defineMachine<Record<string, never>, Ev>()({
      name: "T",
      context: () => ({}),
      states: {
        initial_state: { on: { move: () => goto("collector") } },
        collector: {
          on: {
            x1: () => {
              handled.push("x1");
            },
            x2: () => {
              handled.push("x2");
            },
          },
        },
      },
    });
    const m = M.start();
    m.send({ type: "x2" });
    m.send({ type: "x1" });
    expect(handled).toEqual([]);
    m.send({ type: "move" });
    expect(handled).toEqual(["x2", "x1"]);
    expect(m.pending).toEqual([]);
  });

  it("still-unmatched events stay queued across entries", () => {
    const M = defineMachine<Record<string, never>, Ev>()({
      name: "T",
      context: () => ({}),
      states: {
        initial_state: { on: { move: () => goto("second") } },
        second: { on: { tick: () => stay() } },
      },
    });
    const m = M.start();
    m.send({ type: "x3" });
    m.send({ type: "move" });
    expect(m.pending.map((e) => e.type)).toEqual(["x3"]);
  });

  it("a replayed event may itself transition; the rest replays in the new state", () => {
    const handled: string[] = [];
    const M = defineMachine<Record<string, never>, Ev>()({
      name: "T",
      context: () => ({}),
      states: {
        initial_state: { on: { move: () => goto("stage1") } },
        stage1: {
          on: {
            x1: () => {
              handled.push("x1@stage1");
              return goto("stage2");
            },
          },
        },
        stage2: {
          on: {
            x2: () => {
              handled.push("x2@stage2");
            },
          },
        },
      },
    });
    const m = M.start();
    m.send({ type: "x1" });
    m.send({ type: "x2" });
    m.send({ type: "move" });
    expect(handled).toEqual(["x1@stage1", "x2@stage2"]);
    expect(m.state).toBe("stage2");
    expect(m.pending).toEqual([]);
  });

  it("stay() does not replay the pending queue (same clauses)", () => {
    const M = defineMachine<Record<string, never>, Ev>()({
      name: "T",
      context: () => ({}),
      states: {
        initial_state: { on: { tick: () => stay("tick") } },
      },
    });
    const m = M.start();
    m.send({ type: "x1" });
    m.send({ type: "tick" });
    expect(m.pending.map((e) => e.type)).toEqual(["x1"]);
  });

  it("the queue is bounded; overflow drops the oldest with a warning", () => {
    const warnings: string[] = [];
    const M = defineMachine<Record<string, never>, Ev>()({
      name: "T",
      context: () => ({}),
      pending: { max: 2 },
      states: { initial_state: {} },
    });
    const m = M.start({ logger: (line) => warnings.push(line) });
    m.send({ type: "x1" });
    m.send({ type: "x2" });
    m.send({ type: "x3" });
    expect(m.pending.map((e) => e.type)).toEqual(["x2", "x3"]);
    expect(warnings.join("\n")).toMatch(/overflow.*'x1'/);
  });

  it('"*" is the flush point: it drains the whole queue', () => {
    const drained: string[] = [];
    const M = defineMachine<Record<string, never>, Ev>()({
      name: "T",
      context: () => ({}),
      states: {
        initial_state: { on: { move: () => goto("flush") } },
        flush: {
          on: {
            "*": (ev) => {
              drained.push(ev.type);
            },
          },
        },
      },
    });
    const m = M.start();
    m.send({ type: "x1" });
    m.send({ type: "x2" });
    m.send({ type: "move" });
    expect(drained).toEqual(["x1", "x2"]);
    expect(m.pending).toEqual([]);
  });

  it("fx.dropPending purges by type or by predicate", () => {
    const M = defineMachine<Record<string, never>, Ev>()({
      name: "T",
      context: () => ({}),
      states: {
        initial_state: {
          on: {
            tick: (_ev, _ctx, fx) => {
              fx.dropPending("ui:stale");
              return stay();
            },
            move: (_ev, _ctx, fx) => {
              fx.dropPending((e) => e.type.startsWith("x"));
              return stay();
            },
          },
        },
      },
    });
    const m = M.start();
    m.send({ type: "ui:stale" });
    m.send({ type: "sip:keep" });
    m.send({ type: "x1" });
    m.send({ type: "tick" });
    expect(m.pending.map((e) => e.type)).toEqual(["sip:keep", "x1"]);
    m.send({ type: "move" });
    expect(m.pending.map((e) => e.type)).toEqual(["sip:keep"]);
  });
});
