import { describe, expect, it } from "vitest";
import { defineMachine, goto, stay } from "../src/index.js";

type Ev = { type: "a" } | { type: "b" } | { type: "go" } | { type: "ui:retry" };

describe("§4.1 delivery semantics (run-to-completion)", () => {
  it("an event sent during a handler is processed after the full transition", () => {
    const order: string[] = [];
    const M = defineMachine<Record<string, never>, Ev>()({
      name: "T",
      context: () => ({}),
      states: {
        initial_state: {
          on: {
            a: (_ev, _ctx, fx) => {
              order.push("handler:a");
              fx.send({ type: "b" });
              order.push("handler:a:after-send");
              return goto("second");
            },
          },
        },
        second: {
          enter() {
            order.push("enter:second");
          },
          on: {
            b: () => {
              order.push("handler:b");
            },
          },
        },
      },
    });
    M.start().send({ type: "a" });
    expect(order).toEqual([
      "handler:a",
      "handler:a:after-send",
      "enter:second",
      "handler:b",
    ]);
  });

  it("an event sent from a subscriber during notification is queued, not re-entrant", () => {
    const order: string[] = [];
    const M = defineMachine<Record<string, never>, Ev>()({
      name: "T",
      context: () => ({}),
      states: {
        initial_state: {
          on: { a: () => goto("second", "moving") },
        },
        second: {
          on: {
            b: () => {
              order.push("handler:b");
            },
          },
        },
      },
    });
    const m = M.start();
    m.subscribe((n) => {
      order.push(`notified:${n.state}`);
      if (n.state === "second") m.send({ type: "b" });
    });
    m.send({ type: "a" });
    // handler:b runs after the notification completed, and its own
    // void result produces no notification
    expect(order).toEqual(["notified:second", "handler:b"]);
  });

  it("subscribers see every hop of a synchronous transition chain", () => {
    const M = defineMachine<Record<string, never>, Ev>()({
      name: "T",
      context: () => ({}),
      states: {
        initial_state: { on: { go: () => goto("hop1") } },
        hop1: {
          enter() {
            return goto("hop2");
          },
        },
        hop2: {},
      },
    });
    const m = M.start();
    const seen: string[] = [];
    m.subscribe((n) => seen.push(n.state));
    m.send({ type: "go" });
    expect(seen).toEqual(["hop1", "hop2"]);
  });
});

describe("§3.2 string shorthand (re-dispatch, design §11.2)", () => {
  it("moves to the target state and re-dispatches the event there", () => {
    const dialed: string[] = [];
    const M = defineMachine<Record<string, never>, Ev>()({
      name: "T",
      context: () => ({}),
      states: {
        initial_state: { on: { go: () => goto("call_failed") } },
        ready: {
          on: {
            "ui:retry": () => {
              dialed.push("dialing");
              return goto("calling");
            },
          },
        },
        call_failed: {
          on: { "ui:retry": "ready" },
        },
        calling: {},
      },
    });
    const m = M.start();
    m.send({ type: "go" });
    expect(m.state).toBe("call_failed");
    m.send({ type: "ui:retry" });
    // moved to ready, re-dispatched, ready's handler dialed
    expect(dialed).toEqual(["dialing"]);
    expect(m.state).toBe("calling");
  });

  it("a re-dispatched event unmatched in the target state pends normally", () => {
    const M = defineMachine<Record<string, never>, Ev>()({
      name: "T",
      context: () => ({}),
      states: {
        initial_state: { on: { "ui:retry": "quiet" } },
        quiet: { on: { a: () => stay() } },
      },
    });
    const m = M.start();
    m.send({ type: "ui:retry" });
    expect(m.state).toBe("quiet");
    expect(m.pending.map((e) => e.type)).toEqual(["ui:retry"]);
  });
});
