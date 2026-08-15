/**
 * Type-level tests (plan M2): compile-time behaviour is tested, not
 * assumed. Every deliberate misuse of the spec §1.1 promises must fail
 * to compile; every legitimate shape must pass.
 */
import { describe, expectTypeOf, it } from "vitest";
import {
  aborted,
  defineMachine,
  failure,
  goto,
  loop,
  next,
  stay,
  success,
  type DoneResult,
  type Instance,
  type Snapshot,
  type TerminalStateName,
  type Transition,
} from "../src/index.js";

interface Ctx {
  callee?: string;
  attempts: number;
}

type Ev =
  | { type: "ui:call"; number: string }
  | { type: "sip:accepted" }
  | { type: "sip:ended"; cause: string };

const M = defineMachine<Ctx, Ev>()({
  name: "Typed",
  context: () => ({ attempts: 0 }),
  states: {
    initial_state: {
      enter() {
        return goto("ready");
      },
    },
    ready: {
      on: {
        "ui:call": (ev, ctx) => {
          // §1.1: the compiler checks the payload read in each clause
          expectTypeOf(ev.number).toEqualTypeOf<string>();
          ctx.callee = ev.number;
          return goto("calling");
        },
      },
    },
    calling: {
      on: {
        "sip:ended": (ev) => failure(ev.cause),
        "sip:accepted": "ready",
      },
    },
  },
});

describe("§1.1 state names become types", () => {
  it("goto to a declared state compiles; goto to a typo does not", () => {
    defineMachine<Ctx, Ev>()({
      name: "T",
      context: () => ({ attempts: 0 }),
      states: {
        initial_state: {
          on: {
            // @ts-expect-error — "connectd" is not a state
            "ui:call": () => goto("connectd"),
          },
        },
        connected: {},
      },
    });
  });

  it("a string shorthand routing to an unknown state does not compile", () => {
    defineMachine<Ctx, Ev>()({
      name: "T",
      context: () => ({ attempts: 0 }),
      states: {
        initial_state: {
          // @ts-expect-error — "nowhere" is not a state
          on: { "ui:call": "nowhere" },
        },
      },
    });
  });

  it("enter returns are checked like handler returns", () => {
    defineMachine<Ctx, Ev>()({
      name: "T",
      context: () => ({ attempts: 0 }),
      states: {
        initial_state: {
          // @ts-expect-error — enter cannot goto an unknown state
          enter: () => goto("elsewhere"),
        },
      },
    });
  });

  it("initial_state is required at the type level", () => {
    defineMachine<Ctx, Ev>()({
      name: "T",
      context: () => ({ attempts: 0 }),
      // @ts-expect-error — initial_state is missing
      states: { only: {} },
    });
  });

  it("target-free transitions are usable in any machine", () => {
    expectTypeOf(next()).toExtend<Transition<"whatever">>();
    expectTypeOf(loop()).toExtend<Transition<"whatever">>();
    expectTypeOf(stay()).toExtend<Transition<"whatever">>();
    expectTypeOf(success()).toExtend<Transition<"whatever">>();
    expectTypeOf(failure()).toExtend<Transition<"whatever">>();
    expectTypeOf(aborted()).toExtend<Transition<"whatever">>();
  });
});

describe("§1.1 events become a discriminated union", () => {
  it("on keys are restricted to the event union (plus '*')", () => {
    defineMachine<Ctx, Ev>()({
      name: "T",
      context: () => ({ attempts: 0 }),
      states: {
        initial_state: {
          on: {
            // @ts-expect-error — "sip:banana" is not an event type
            "sip:banana": () => stay(),
          },
        },
      },
    });
  });

  it("handlers narrow the event payload; wrong fields do not compile", () => {
    defineMachine<Ctx, Ev>()({
      name: "T",
      context: () => ({ attempts: 0 }),
      states: {
        initial_state: {
          on: {
            "sip:ended": (ev) => {
              expectTypeOf(ev.cause).toEqualTypeOf<string>();
              // @ts-expect-error — "number" belongs to ui:call, not sip:ended
              void ev.number;
              return stay();
            },
            "*": (ev) => {
              expectTypeOf(ev).toEqualTypeOf<Ev>();
              return stay();
            },
          },
        },
      },
    });
  });

  it("send is checked on the sender side", () => {
    const m = M.start();
    m.send({ type: "ui:call", number: "sip:alice@example.com" });
    // @ts-expect-error — unknown event type
    m.send({ type: "ui:frob" });
    // @ts-expect-error — missing payload field
    m.send({ type: "ui:call" });
    // @ts-expect-error — wrong payload field type
    m.send({ type: "ui:call", number: 42 });
  });

  it("fx.send is checked like machine.send", () => {
    defineMachine<Ctx, Ev>()({
      name: "T",
      context: () => ({ attempts: 0 }),
      states: {
        initial_state: {
          enter(_ctx, fx) {
            fx.send({ type: "sip:accepted" });
            // @ts-expect-error — unknown event type
            fx.send({ type: "nope" });
          },
        },
      },
    });
  });
});

describe("§1.1 the context becomes typed", () => {
  it("handlers see the declared context shape", () => {
    defineMachine<Ctx, Ev>()({
      name: "T",
      context: () => ({ attempts: 0 }),
      states: {
        initial_state: {
          enter(ctx) {
            ctx.attempts++;
            // @ts-expect-error — not a Ctx field
            ctx.frobnicate = true;
          },
        },
      },
    });
  });

  it("the context factory must produce a Ctx", () => {
    defineMachine<Ctx, Ev>()({
      name: "T",
      // @ts-expect-error — attempts is missing
      context: () => ({}),
      states: { initial_state: {} },
    });
  });

  it("start args are a Partial of Ctx", () => {
    M.start({ args: { callee: "sip:bob@example.com" } });
    // @ts-expect-error — unknown context field
    M.start({ args: { calee: "typo" } });
  });
});

describe("§6 instance surface typing", () => {
  it("state is the inferred name union plus the terminal states", () => {
    const m = M.start();
    expectTypeOf(m.state).toEqualTypeOf<
      "initial_state" | "ready" | "calling" | TerminalStateName
    >();
    expectTypeOf(m).toExtend<
      Instance<Ctx, Ev, "initial_state" | "ready" | "calling">
    >();
  });

  it("matches only accepts known state names", () => {
    const m = M.start();
    m.matches("ready");
    m.matches("terminal_success_state");
    // @ts-expect-error — unknown state name
    m.matches("redy");
  });

  it("snapshot and done are typed", () => {
    const m = M.start();
    const snap = m.getSnapshot();
    expectTypeOf(snap).toExtend<
      Snapshot<Ctx, Ev, "initial_state" | "ready" | "calling">
    >();
    expectTypeOf(snap.context.attempts).toEqualTypeOf<number>();
    expectTypeOf(snap.pending).toEqualTypeOf<readonly Ev[]>();
    expectTypeOf(m.done).toEqualTypeOf<Promise<DoneResult>>();
  });
});
