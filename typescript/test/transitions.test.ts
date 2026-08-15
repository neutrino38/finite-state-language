import { describe, expect, it } from "vitest";
import {
  aborted,
  defineMachine,
  failure,
  goto,
  loop,
  next,
  stay,
  success,
  TERMINAL_STATES,
} from "../src/index.js";

type Ev =
  | { type: "go" }
  | { type: "hop" }
  | { type: "tick" }
  | { type: "boom" }
  | { type: "end" };

describe("§3.3 transitions", () => {
  it("goto moves to a named state", () => {
    const M = defineMachine<Record<string, never>, Ev>()({
      name: "T",
      context: () => ({}),
      states: {
        initial_state: { on: { go: () => goto("b") } },
        b: {},
      },
    });
    const m = M.start();
    m.send({ type: "go" });
    expect(m.state).toBe("b");
  });

  it("next moves to the state declared after the current one (§3.1)", () => {
    const M = defineMachine<Record<string, never>, Ev>()({
      name: "T",
      context: () => ({}),
      states: {
        initial_state: { on: { go: () => next() } },
        second: { on: { go: () => next("onward") } },
        third: {},
      },
    });
    const m = M.start();
    m.send({ type: "go" });
    expect(m.state).toBe("second");
    m.send({ type: "go" });
    expect(m.state).toBe("third");
  });

  it("next() from the last declared state is a failure", async () => {
    const M = defineMachine<Record<string, never>, Ev>()({
      name: "T",
      context: () => ({}),
      states: {
        initial_state: { on: { go: () => next() } },
      },
    });
    const m = M.start();
    m.send({ type: "go" });
    const r = await m.done;
    expect(r.outcome).toBe("failure");
    expect(r.reason).toMatch(/next\(\) from last declared state/);
  });

  it("loop re-enters the current state and re-runs enter", () => {
    const M = defineMachine<{ entries: number }, Ev>()({
      name: "T",
      context: () => ({ entries: 0 }),
      states: {
        initial_state: { on: { go: () => goto("work") } },
        work: {
          enter(ctx) {
            ctx.entries++;
          },
          on: { tick: () => loop("again") },
        },
      },
    });
    const m = M.start();
    m.send({ type: "go" });
    expect(m.context.entries).toBe(1);
    m.send({ type: "tick" });
    m.send({ type: "tick" });
    expect(m.context.entries).toBe(3);
    expect(m.state).toBe("work");
  });

  it("stay remains in the state without re-running enter", () => {
    const M = defineMachine<{ entries: number; ticks: number }, Ev>()({
      name: "T",
      context: () => ({ entries: 0, ticks: 0 }),
      states: {
        initial_state: {
          enter(ctx) {
            ctx.entries++;
          },
          on: {
            tick: (_ev, ctx) => {
              ctx.ticks++;
              return stay("ticked");
            },
          },
        },
      },
    });
    const m = M.start();
    m.send({ type: "tick" });
    m.send({ type: "tick" });
    expect(m.context.entries).toBe(1);
    expect(m.context.ticks).toBe(2);
  });

  it("explicit stay() notifies subscribers; returning void does not", () => {
    const M = defineMachine<Record<string, never>, Ev>()({
      name: "T",
      context: () => ({}),
      states: {
        initial_state: {
          on: {
            tick: () => stay("repaint"),
            hop: () => undefined,
          },
        },
      },
    });
    const m = M.start();
    const seen: (string | undefined)[] = [];
    m.subscribe((n) => seen.push(n.desc));
    m.send({ type: "hop" }); // void ⇒ silent
    expect(seen).toEqual([]);
    m.send({ type: "tick" }); // stay ⇒ notified with desc
    expect(seen).toEqual(["repaint"]);
  });

  it("success / failure / aborted settle done and land in the terminal states", async () => {
    const make = (t: () => ReturnType<typeof success>) =>
      defineMachine<Record<string, never>, Ev>()({
        name: "T",
        context: () => ({}),
        states: { initial_state: { on: { end: () => t() } } },
      }).start();

    const s = make(() => success("all good"));
    s.send({ type: "end" });
    expect(await s.done).toEqual({ outcome: "success", reason: "all good" });
    expect(s.state).toBe(TERMINAL_STATES.success);

    const f = make(() => failure("oops"));
    f.send({ type: "end" });
    expect(await f.done).toEqual({ outcome: "failure", reason: "oops" });
    expect(f.state).toBe(TERMINAL_STATES.failure);

    const a = make(() => aborted("bye"));
    a.send({ type: "end" });
    expect(await a.done).toEqual({ outcome: "aborted", reason: "bye" });
    expect(a.state).toBe(TERMINAL_STATES.aborted);
  });

  it("enter may return a transition directly (initial_state as main())", () => {
    const M = defineMachine<Record<string, never>, Ev>()({
      name: "T",
      context: () => ({}),
      states: {
        initial_state: {
          enter() {
            return goto("armed");
          },
        },
        armed: {},
      },
    });
    expect(M.start().state).toBe("armed");
  });
});

describe("§5 exception ⇒ failure contract", () => {
  it("an exception in a handler becomes failure(String(err))", async () => {
    const M = defineMachine<Record<string, never>, Ev>()({
      name: "T",
      context: () => ({}),
      states: {
        initial_state: {
          on: {
            boom: () => {
              throw new Error("kaboom");
            },
          },
        },
      },
    });
    const m = M.start({ logger: () => {} });
    m.send({ type: "boom" });
    expect(await m.done).toEqual({
      outcome: "failure",
      reason: "Error: kaboom",
    });
  });

  it("an exception in enter becomes failure", async () => {
    const M = defineMachine<Record<string, never>, Ev>()({
      name: "T",
      context: () => ({}),
      states: {
        initial_state: {
          on: { go: () => goto("bad") },
        },
        bad: {
          enter() {
            throw new Error("broken enter");
          },
        },
      },
    });
    const m = M.start({ logger: () => {} });
    m.send({ type: "go" });
    expect((await m.done).outcome).toBe("failure");
  });

  it("a synchronous transition livelock is converted to failure (design §4.8)", async () => {
    const M = defineMachine<Record<string, never>, Ev>()({
      name: "T",
      context: () => ({}),
      states: {
        initial_state: {
          enter() {
            return goto("pong");
          },
        },
        pong: {
          enter() {
            return goto("ping");
          },
        },
        ping: {
          enter() {
            return goto("pong");
          },
        },
      },
    });
    const m = M.start({ logger: () => {} });
    const r = await m.done;
    expect(r.outcome).toBe("failure");
    expect(r.reason).toMatch(/livelock/);
  });
});

describe("§3.1 definition validation", () => {
  it("rejects a missing initial_state", () => {
    expect(() =>
      defineMachine<Record<string, never>, Ev>()({
        name: "T",
        context: () => ({}),
        // @ts-expect-error — initial_state is required at the type level
        // too; this exercises the runtime guard for plain-JS consumers
        states: { lonely: {} },
      }),
    ).toThrow(/initial_state/);
  });

  it("rejects reserved terminal state names", () => {
    expect(() =>
      defineMachine<Record<string, never>, Ev>()({
        name: "T",
        context: () => ({}),
        states: { initial_state: {}, terminal_success_state: {} },
      }),
    ).toThrow(/reserved/);
  });

  it("rejects a string shorthand routing to an unknown state", () => {
    expect(() =>
      defineMachine<Record<string, never>, Ev>()({
        name: "T",
        context: () => ({}),
        // @ts-expect-error — deliberately invalid target
        states: { initial_state: { on: { go: "nowhere" } } },
      }),
    ).toThrow(/unknown state 'nowhere'/);
  });

  it("terminal states are immutable: events after done are dropped", async () => {
    const M = defineMachine<Record<string, never>, Ev>()({
      name: "T",
      context: () => ({}),
      states: {
        initial_state: { on: { end: () => success() } },
      },
    });
    const m = M.start();
    m.send({ type: "end" });
    await m.done;
    m.send({ type: "go" });
    expect(m.state).toBe(TERMINAL_STATES.success);
    expect(m.pending).toEqual([]);
  });
});
