/**
 * Service Building Blocks (spec §8.4): the subroutine model — one
 * machine, one context, one mailbox, a stack of definitions.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  aborted,
  defineMachine,
  defineSbb,
  failure,
  goto,
  next,
  stay,
  success,
  type Sbb,
} from "../src/index.js";

// ---------------------------------------------------------------------------
// A block that establishes a call: the running example of the spec.
// ---------------------------------------------------------------------------

type HostCtx = { uri: string; trace: string[]; answeredBy?: string };
type Data = { tries: number; dest: string };

type Ev =
  | { type: "sip:180" }
  | { type: "sip:200"; from: string }
  | { type: "sip:486" }
  | { type: "ui:hangup" }
  | { type: "noise" }
  | Ret;

type Ret =
  | { type: "call:connected"; uri: string }
  | { type: "call:rejected"; code: number }
  | { type: "call:timeout" };

const Establish = defineSbb<HostCtx, Ev, Data, Ret>()({
  name: "Establish",
  data: () => ({ tries: 0, dest: "" }),
  timeout: {
    delay: 30_000,
    then: (_c, fx) => fx.sbbReturn({ type: "call:timeout" }),
  },
  cleanup: (ctx) => ctx.trace.push("establish cleanup"),
  states: {
    initial_state: {
      enter(ctx, fx) {
        fx.data.tries++;
        ctx.trace.push(`inviting ${fx.data.dest || ctx.uri}`);
        return goto("ringing");
      },
    },
    ringing: {
      on: {
        "sip:180": (_ev, ctx) => {
          ctx.trace.push("ringing");
          return stay();
        },
        "sip:200": (ev, ctx, fx) => {
          ctx.answeredBy = ev.from;
          fx.sbbReturn({ type: "call:connected", uri: ev.from });
        },
        "sip:486": (_ev, _ctx, fx) =>
          fx.sbbReturn({ type: "call:rejected", code: 486 }),
        "ui:hangup": () => aborted("caller gave up"),
      },
    },
  },
});

function host(opts: { after?: number } = {}) {
  return defineMachine<HostCtx, Ev>()({
    name: "Host",
    context: () => ({ uri: "sip:bob@example.com", trace: [] }),
    cleanup: (ctx) => ctx.trace.push("host cleanup"),
    states: {
      initial_state: { on: { "sip:180": () => goto("placing") } },
      placing: {
        enter(ctx, fx) {
          fx.sbb(Establish, { args: { dest: ctx.uri } });
        },
        on: {
          "call:connected": (ev, ctx) => {
            ctx.trace.push(`connected to ${ev.uri}`);
            return goto("talking");
          },
          "call:rejected": (ev, ctx) => {
            ctx.trace.push(`rejected ${ev.code}`);
            return failure(`rejected ${ev.code}`);
          },
          "call:timeout": () => failure("no answer"),
          noise: (_ev, ctx) => {
            ctx.trace.push("host saw noise");
            return stay();
          },
        },
        ...(opts.after === undefined
          ? {}
          : {
              after: {
                delay: opts.after,
                then: () => failure("host deadline"),
              },
            }),
      },
      talking: { on: { "ui:hangup": () => success("hung up") } },
    },
  });
}

/** Drive the machine into `placing`, i.e. into the block. */
function inBlock(m: ReturnType<ReturnType<typeof host>["start"]>) {
  m.send({ type: "sip:180" });
  return m;
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("entering and returning", () => {
  it("runs the block's states and hands the outcome back to the host", async () => {
    const m = inBlock(host().start());
    m.send({ type: "sip:180" }); // consumed by the block, not by the host
    m.send({ type: "sip:200", from: "sip:bob@phone" });
    expect(m.state).toBe("talking");
    expect(m.context.trace).toEqual([
      "inviting sip:bob@example.com",
      "ringing",
      "connected to sip:bob@phone",
    ]);
    m.send({ type: "ui:hangup" });
    expect((await m.done).outcome).toBe("success");
  });

  it("shares the host context and keeps the sandbox private", () => {
    const m = inBlock(host().start());
    // The block wrote to the host's context…
    m.send({ type: "sip:200", from: "sip:bob@phone" });
    expect(m.context.answeredBy).toBe("sip:bob@phone");
    // …and `tries` (its sandbox) is nowhere in it.
    expect(Object.keys(m.context)).not.toContain("tries");
  });

  it("seeds the sandbox from args, fresh on every entry", () => {
    const seen: number[] = [];
    const Counter = defineSbb<
      { n: number },
      { type: "go" } | R,
      { tries: number },
      R
    >()({
      name: "Counter",
      data: () => ({ tries: 0 }),
      states: {
        initial_state: {
          enter(_ctx, fx) {
            fx.data.tries++;
            seen.push(fx.data.tries);
            fx.sbbReturn({ type: "done" });
          },
        },
      },
    });
    type R = { type: "done" };
    const M = defineMachine<{ n: number }, { type: "go" } | R>()({
      name: "Twice",
      context: () => ({ n: 0 }),
      states: {
        initial_state: {
          enter: (_c, fx) => fx.sbb(Counter),
          on: { done: () => goto("again") },
        },
        again: {
          enter: (_c, fx) => fx.sbb(Counter),
          on: { done: () => success() },
        },
      },
    });
    M.start();
    expect(seen).toEqual([1, 1]);
  });

  it("refuses a stale fx: only the top frame may return", () => {
    const warnings: string[] = [];
    let escaped: { sbbReturn: (ev: R) => void } | undefined;
    type R = { type: "done" };
    const Leaky = defineSbb<
      Record<string, never>,
      { type: "go" } | R,
      Record<string, never>,
      R
    >()({
      name: "Leaky",
      data: () => ({}),
      states: {
        initial_state: {
          enter(_ctx, fx) {
            escaped = fx;
            fx.sbbReturn({ type: "done" });
          },
        },
      },
    });
    const M = defineMachine<Record<string, never>, { type: "go" } | R>()({
      name: "H",
      context: () => ({}),
      states: {
        initial_state: {
          enter: (_c, fx) => fx.sbb(Leaky),
          on: { done: () => goto("after") },
        },
        after: {},
      },
    });
    const m = M.start({ logger: (l) => warnings.push(l) });
    expect(m.state).toBe("after");
    escaped?.sbbReturn({ type: "done" }); // the block is long gone
    expect(warnings.join()).toContain("is not the one currently running");
    expect(m.state).toBe("after");
  });
});

describe("what the outside world sees", () => {
  it("publishes the host state, and the block position beside it", () => {
    const m = inBlock(host().start());
    expect(m.state).toBe("placing");
    expect(m.matches("placing")).toBe(true);
    expect(m.sbb).toEqual({
      block: "Establish",
      state: "ringing",
      depth: 1,
      meta: undefined,
    });
    expect(m.getSnapshot().sbb?.state).toBe("ringing");
    m.send({ type: "sip:200", from: "x" });
    expect(m.sbb).toBeUndefined();
  });

  it("qualifies the block's states in the transition log", () => {
    const m = inBlock(host().start());
    m.send({ type: "sip:200", from: "x" });
    const hops = m.log.map((e) => `${e.from}->${e.to}`);
    expect(hops).toContain("placing->Establish/initial_state");
    expect(hops).toContain("Establish/initial_state->Establish/ringing");
    expect(hops).toContain("Establish/ringing->placing");
  });
});

describe("the mailbox is one mailbox", () => {
  it("pends what the block ignores and replays it before the return event", () => {
    const m = inBlock(host().start());
    m.send({ type: "noise" }); // the block has no clause for it
    expect(m.pending.map((e) => e.type)).toEqual(["noise"]);
    m.send({ type: "sip:200", from: "x" });
    // "host saw noise" lands before "connected": the return event is
    // not privileged (spec §8.4).
    expect(m.context.trace).toEqual([
      "inviting sip:bob@example.com",
      "host saw noise",
      "connected to x",
    ]);
  });
});

describe("deadlines", () => {
  it("suspends the host's after and arms it afresh on return", () => {
    const m = inBlock(host({ after: 10_000 }).start());
    // 9 s inside the block: the host's 10 s deadline must not be running.
    vi.advanceTimersByTime(9_000);
    expect(m.state).toBe("placing");
    m.send({ type: "sip:200", from: "x" });
    expect(m.state).toBe("talking");
  });

  it("does not let the host's deadline expire during a long block", () => {
    const m = inBlock(host({ after: 10_000 }).start());
    vi.advanceTimersByTime(25_000);
    expect(m.sbb?.block).toBe("Establish"); // still in the block, alive
  });

  it("bounds the block with its own deadline", async () => {
    const m = inBlock(host().start());
    vi.advanceTimersByTime(30_000);
    expect((await m.done).reason).toBe("no answer");
  });

  it("keeps the host's fx.delay alive across a block, and drops the block's", () => {
    const fired: string[] = [];
    type E = { type: "go" } | { type: "ping"; who: string } | { type: "done" };
    const B = defineSbb<
      Record<string, never>,
      E,
      Record<string, never>,
      { type: "done" }
    >()({
      name: "B",
      data: () => ({}),
      states: {
        initial_state: {
          enter(_c, fx) {
            fx.delay({ type: "ping", who: "block" }, 5_000);
          },
          on: { go: (_e, _c, fx) => fx.sbbReturn({ type: "done" }) },
        },
      },
    });
    const M = defineMachine<Record<string, never>, E>()({
      name: "H",
      context: () => ({}),
      states: {
        initial_state: {
          enter(_c, fx) {
            fx.delay({ type: "ping", who: "host" }, 5_000);
            fx.sbb(B);
          },
          on: {
            done: () => stay(),
            ping: (ev) => {
              fired.push(ev.who);
              return stay();
            },
          },
        },
      },
    });
    const m = M.start();
    m.send({ type: "go" }); // block returns at t=0
    vi.advanceTimersByTime(5_000);
    expect(fired).toEqual(["host"]);
    expect(m.state).toBe("initial_state");
  });
});

describe("terminals propagate, sbbReturn does not", () => {
  it("a terminal inside a block unwinds host included, cleanups innermost first", async () => {
    const m = inBlock(host().start());
    m.send({ type: "ui:hangup" }); // the block aborts
    const r = await m.done;
    expect(r).toEqual({ outcome: "aborted", reason: "caller gave up" });
    expect(m.context.trace).toEqual([
      "inviting sip:bob@example.com",
      "establish cleanup",
      "host cleanup",
    ]);
  });

  it("a cooperative shutdown runs the block's cleanup and the host's hook", async () => {
    const M = defineMachine<HostCtx, Ev>()({
      name: "Graceful",
      context: () => ({ uri: "sip:x", trace: [] }),
      onShutdown: (ctx) => {
        ctx.trace.push("host onShutdown");
        return success("wound down");
      },
      cleanup: (ctx) => ctx.trace.push("host cleanup"),
      states: {
        initial_state: {
          enter: (_c, fx) => fx.sbb(Establish),
          on: { "call:connected": () => success() },
        },
      },
    });
    const m = M.start();
    const r = await m.shutdown("bye");
    expect(r).toEqual({ outcome: "success", reason: "wound down" });
    expect(m.context.trace).toEqual([
      "inviting sip:x",
      "establish cleanup",
      "host onShutdown",
      "host cleanup",
    ]);
  });
});

describe("composition", () => {
  type E2 = { type: "go" } | { type: "inner:done" } | { type: "outer:done" };

  const Inner = defineSbb<
    { trace: string[] },
    E2,
    Record<string, never>,
    { type: "inner:done" }
  >()({
    name: "Inner",
    data: () => ({}),
    states: {
      initial_state: {
        enter: (ctx) => {
          ctx.trace.push("inner");
        },
        on: { go: (_e, _c, fx) => fx.sbbReturn({ type: "inner:done" }) },
      },
    },
  });

  const Outer = defineSbb<
    { trace: string[] },
    E2,
    Record<string, never>,
    { type: "outer:done" }
  >()({
    name: "Outer",
    data: () => ({}),
    states: {
      initial_state: {
        enter(ctx, fx) {
          ctx.trace.push("outer");
          fx.sbb(Inner);
        },
        on: {
          "inner:done": (_e, _c, fx) => fx.sbbReturn({ type: "outer:done" }),
        },
      },
    },
  });

  it("nests, and reports the innermost block", () => {
    const M = defineMachine<{ trace: string[] }, E2>()({
      name: "H",
      context: () => ({ trace: [] }),
      states: {
        initial_state: {
          enter: (_c, fx) => fx.sbb(Outer),
          on: { "outer:done": () => goto("finished") },
        },
        finished: {},
      },
    });
    const m = M.start();
    expect(m.sbb).toMatchObject({ block: "Inner", depth: 2 });
    expect(m.state).toBe("initial_state");
    m.send({ type: "go" });
    expect(m.state).toBe("finished");
    expect(m.context.trace).toEqual(["outer", "inner"]);
  });

  it("stops runaway recursion with a failure that names the block", async () => {
    type RE = { type: "r:done" };
    type Recur = Sbb<
      Record<string, never>,
      RE,
      Record<string, never>,
      RE,
      "initial_state"
    >;
    // The annotation plus the indirection break the self-reference that
    // would otherwise make R's own type circular.
    const deref = (): Recur => R;
    const R: Recur = defineSbb<
      Record<string, never>,
      RE,
      Record<string, never>,
      RE
    >()({
      name: "Recur",
      data: () => ({}),
      states: {
        initial_state: {
          enter(_c, fx) {
            fx.sbb(deref());
          },
        },
      },
    });
    const M = defineMachine<Record<string, never>, RE>()({
      name: "H",
      context: () => ({}),
      states: {
        initial_state: {
          enter(_c, fx) {
            fx.sbb(R);
          },
        },
      },
    });
    const m = M.start({ logger: () => {} });
    const r = await m.done;
    expect(r.outcome).toBe("failure");
    expect(r.reason).toContain("Recur");
  });
});

describe("a block is a machine in every other way", () => {
  it("next() follows the block's own declaration order", () => {
    type E3 = { type: "go" } | { type: "b:done"; where: string };
    const B = defineSbb<
      Record<string, never>,
      E3,
      Record<string, never>,
      { type: "b:done"; where: string }
    >()({
      name: "Steps",
      data: () => ({}),
      states: {
        initial_state: { on: { go: () => next() } },
        second: { on: { go: () => next() } },
        third: {
          enter: (_c, fx) => fx.sbbReturn({ type: "b:done", where: "third" }),
        },
      },
    });
    const M = defineMachine<Record<string, never>, E3>()({
      name: "H",
      context: () => ({}),
      states: {
        initial_state: {
          enter: (_c, fx) => fx.sbb(B),
          on: { "b:done": (ev) => goto(ev.where === "third" ? "ok" : "nope") },
        },
        ok: {},
        nope: {},
      },
    });
    const m = M.start();
    m.send({ type: "go" });
    m.send({ type: "go" });
    expect(m.state).toBe("ok");
  });

  it("exports its structure as mermaid", () => {
    const dia = Establish.toMermaid();
    expect(dia).toContain("stateDiagram-v2");
    expect(dia).toContain("initial_state");
    expect(dia).toContain("ringing");
  });
});

describe("defineSbb validation", () => {
  const ok = { name: "V", data: () => ({}), states: { initial_state: {} } };

  it("rejects a nameless block", () => {
    expect(() => defineSbb()({ ...ok, name: "" })).toThrow(/non-empty string/);
  });

  it("rejects a missing data factory", () => {
    expect(() => defineSbb()({ ...ok, data: undefined as never })).toThrow(
      /'data' must be a factory/,
    );
  });

  it("rejects states without initial_state", () => {
    expect(() =>
      defineSbb()({ ...ok, states: { other: {} } as never }),
    ).toThrow(/must declare 'initial_state'/);
  });

  it("rejects a terminal state name", () => {
    expect(() =>
      defineSbb()({
        ...ok,
        states: { initial_state: {}, terminal_success_state: {} } as never,
      }),
    ).toThrow(/is reserved/);
  });

  it("rejects an invalid timeout", () => {
    expect(() =>
      defineSbb()({ ...ok, timeout: { delay: -1, then: () => {} } }),
    ).toThrow(/invalid timeout.delay/);
  });

  it("rejects a value that is not a block", () => {
    const M = defineMachine()({
      name: "H",
      context: () => ({}),
      states: {
        initial_state: {
          enter: (_c, fx) => fx.sbb({ name: "fake" } as never),
        },
      },
    });
    const m = M.start({ logger: () => {} });
    expect(m.state).toBe("terminal_failure_state");
  });
});

describe("calling a block from a handler, not only from enter", () => {
  type E =
    { type: "start" } | { type: "go" } | { type: "b:done" } | { type: "late" };

  const B = defineSbb<
    Record<string, never>,
    E,
    Record<string, never>,
    { type: "b:done" }
  >()({
    name: "B",
    data: () => ({}),
    states: {
      initial_state: {
        on: { go: (_e, _c, fx) => fx.sbbReturn({ type: "b:done" }) },
      },
    },
  });

  it("suspends the deadline that was already running, and arms it afresh", async () => {
    const M = defineMachine<Record<string, never>, E>()({
      name: "H",
      context: () => ({}),
      states: {
        initial_state: {
          on: {
            start: (_e, _c, fx) => {
              fx.sbb(B);
            },
            "b:done": () => stay("back"),
          },
          after: { delay: 10_000, then: () => failure("host deadline") },
        },
      },
    });
    const m = M.start();
    vi.advanceTimersByTime(9_000); // 9 s of the host's 10 s are gone
    m.send({ type: "start" });
    vi.advanceTimersByTime(60_000); // a long block: the host must not fire
    expect(m.state).toBe("initial_state");
    m.send({ type: "go" });
    // Back in the host, with a full deadline rather than the last second.
    vi.advanceTimersByTime(9_000);
    expect(m.state).toBe("initial_state");
    vi.advanceTimersByTime(1_500);
    expect((await m.done).reason).toBe("host deadline");
  });

  it("ignores a transition returned after fx.sbb, and says so", () => {
    const warnings: string[] = [];
    const M = defineMachine<Record<string, never>, E>()({
      name: "H",
      context: () => ({}),
      states: {
        initial_state: {
          on: {
            start: (_e, _c, fx) => {
              fx.sbb(B);
              return goto("elsewhere"); // the block is running: too late
            },
            "b:done": () => goto("elsewhere"),
          },
        },
        elsewhere: {},
      },
    });
    const m = M.start({ logger: (l) => warnings.push(l) });
    m.send({ type: "start" });
    expect(m.sbb?.block).toBe("B"); // still in the block, not in `elsewhere`
    expect(warnings.join()).toContain(
      "must be the last thing a state body does",
    );
    m.send({ type: "go" });
    expect(m.state).toBe("elsewhere");
  });
});

describe("the two ways a state body can hand the machine over", () => {
  type E = { type: "dial"; n: string } | { type: "go" } | { type: "b:done" };

  const B = defineSbb<
    { seen: string[] },
    E,
    Record<string, never>,
    { type: "b:done" }
  >()({
    name: "B",
    data: () => ({}),
    states: {
      initial_state: {
        on: {
          dial: (ev, ctx, fx) => {
            ctx.seen.push(`block got ${ev.n}`);
            fx.sbbReturn({ type: "b:done" });
          },
          go: (_e, _c, fx) => fx.sbbReturn({ type: "b:done" }),
        },
      },
    },
  });

  it("does not drop the event a string shorthand was re-dispatching", () => {
    const M = defineMachine<{ seen: string[] }, E>()({
      name: "H",
      context: () => ({ seen: [] }),
      states: {
        initial_state: { on: { dial: "placing" } },
        placing: {
          enter(_c, fx) {
            fx.sbb(B);
          },
          on: { "b:done": () => goto("done") },
        },
        done: {},
      },
    });
    const m = M.start();
    m.send({ type: "dial", n: "123" });
    // The shorthand moved to `placing`, whose enter entered the block:
    // the event must reach the block, not vanish.
    expect(m.context.seen).toEqual(["block got 123"]);
    expect(m.state).toBe("done");
  });

  it("names sbbReturn when a transition follows it", () => {
    const warnings: string[] = [];
    const Chatty = defineSbb<
      Record<string, never>,
      E,
      Record<string, never>,
      { type: "b:done" }
    >()({
      name: "Chatty",
      data: () => ({}),
      states: {
        initial_state: {
          on: {
            go: (_e, _c, fx) => {
              fx.sbbReturn({ type: "b:done" });
              return goto("nowhere_useful");
            },
          },
        },
        nowhere_useful: {},
      },
    });
    const M = defineMachine<Record<string, never>, E>()({
      name: "H",
      context: () => ({}),
      states: {
        initial_state: {
          enter(_c, fx) {
            fx.sbb(Chatty);
          },
          on: { "b:done": () => goto("done") },
        },
        done: {},
      },
    });
    const m = M.start({ logger: (l) => warnings.push(l) });
    m.send({ type: "go" });
    expect(warnings.join()).toContain("returned after fx.sbbReturn");
    expect(m.state).toBe("done");
  });
});
