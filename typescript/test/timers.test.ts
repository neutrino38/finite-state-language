import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineMachine, failure, goto, loop, stay } from "../src/index.js";

type Ev =
  | { type: "go" }
  | { type: "tick" }
  | { type: "poke" }
  | { type: "delayed"; n: number };

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("§3.2 the after clause", () => {
  const M = defineMachine<Record<string, never>, Ev>()({
    name: "T",
    context: () => ({}),
    states: {
      initial_state: { on: { go: () => goto("waiting") } },
      waiting: {
        on: {
          tick: () => loop("again"),
          poke: () => stay("poked"),
          go: () => goto("safe"),
        },
        after: { delay: 30_000, then: () => failure("nobody answered") },
      },
      safe: {},
    },
  });

  it("arms on entry and fires the transition", async () => {
    const m = M.start();
    m.send({ type: "go" });
    vi.advanceTimersByTime(30_000);
    expect((await m.done).reason).toBe("nobody answered");
  });

  it("is cancelled on state exit", () => {
    const m = M.start();
    m.send({ type: "go" });
    vi.advanceTimersByTime(29_999);
    m.send({ type: "go" }); // leave to safe just in time
    vi.advanceTimersByTime(60_000);
    expect(m.state).toBe("safe");
  });

  it("re-arms on loop()", () => {
    const m = M.start();
    m.send({ type: "go" });
    vi.advanceTimersByTime(29_000);
    m.send({ type: "tick" }); // loop: enter re-runs, after re-arms
    vi.advanceTimersByTime(29_000);
    expect(m.state).toBe("waiting"); // 58s total, but timer was reset
    vi.advanceTimersByTime(1_000);
    expect(m.state).toBe("terminal_failure_state");
  });

  it("is NOT reset by stay() (same state, same timer)", () => {
    const m = M.start();
    m.send({ type: "go" });
    vi.advanceTimersByTime(29_000);
    m.send({ type: "poke" }); // stay: timers untouched
    vi.advanceTimersByTime(1_000);
    expect(m.state).toBe("terminal_failure_state");
  });

  it("the transition log labels the hop with the after pseudo-event", () => {
    const m = M.start();
    m.send({ type: "go" });
    vi.advanceTimersByTime(30_000);
    const last = m.log[m.log.length - 1];
    expect(last).toMatchObject({
      event: "after",
      to: "terminal_failure_state",
    });
  });

  it("an enter that immediately transitions never arms the timer", () => {
    const fired: string[] = [];
    const N = defineMachine<Record<string, never>, Ev>()({
      name: "N",
      context: () => ({}),
      states: {
        initial_state: { on: { go: () => goto("bouncer") } },
        bouncer: {
          enter() {
            return goto("rest");
          },
          after: {
            delay: 1_000,
            then: () => {
              fired.push("bouncer-after");
              return failure("must not happen");
            },
          },
        },
        rest: {},
      },
    });
    const m = N.start();
    m.send({ type: "go" });
    vi.advanceTimersByTime(10_000);
    expect(fired).toEqual([]);
    expect(m.state).toBe("rest");
  });
});

describe("§4.3 fx.delay", () => {
  const D = defineMachine<{ got: number[] }, Ev>()({
    name: "D",
    context: () => ({ got: [] }),
    states: {
      initial_state: {
        on: {
          go: (_ev, _ctx, fx) => {
            fx.delay({ type: "delayed", n: 1 }, 5_000);
            return stay("armed");
          },
          tick: (_ev, _ctx, fx) => {
            fx.delay({ type: "delayed", n: 2 }, 5_000, { sticky: true });
            return stay("armed sticky");
          },
          poke: () => goto("elsewhere"),
          delayed: (ev, ctx) => {
            ctx.got.push(ev.n);
            return stay();
          },
        },
      },
      elsewhere: {
        on: {
          delayed: (ev, ctx) => {
            ctx.got.push(ev.n * 100);
            return stay();
          },
        },
      },
    },
  });

  it("delivers the event after the delay", () => {
    const m = D.start();
    m.send({ type: "go" });
    vi.advanceTimersByTime(5_000);
    expect(m.context.got).toEqual([1]);
  });

  it("is cancelled on state exit unless sticky", () => {
    const m = D.start();
    m.send({ type: "go" }); // non-sticky
    m.send({ type: "tick" }); // sticky
    m.send({ type: "poke" }); // exit initial_state
    vi.advanceTimersByTime(5_000);
    // non-sticky cancelled; sticky delivered in the new state
    expect(m.context.got).toEqual([200]);
  });

  it("the returned handle cancels it early", () => {
    let handle: { cancel(): void } | undefined;
    const H = defineMachine<{ got: number[] }, Ev>()({
      name: "H",
      context: () => ({ got: [] }),
      states: {
        initial_state: {
          on: {
            go: (_ev, _ctx, fx) => {
              handle = fx.delay({ type: "delayed", n: 9 }, 1_000);
            },
            delayed: (ev, ctx) => {
              ctx.got.push(ev.n);
            },
          },
        },
      },
    });
    const m = H.start();
    m.send({ type: "go" });
    handle!.cancel();
    vi.advanceTimersByTime(10_000);
    expect(m.context.got).toEqual([]);
  });
});
