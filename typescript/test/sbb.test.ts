/**
 * Service Building Blocks (spec §8.4): the subroutine model — one
 * machine, one context, one mailbox, a stack of definitions — and the
 * declared vocabulary a block talks back with.
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
  type SbbReturn,
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
  | SbbReturn<"call", "connected", { uri: string }>
  | SbbReturn<"call", "rejected", { code: number }>
  | SbbReturn<"call", "timeout", { block: string }>;

const Establish = defineSbb<HostCtx, Ev, Data, Ret>()({
  name: "Establish",
  namespace: "call",
  returns: {
    connected: "the callee answered — {uri}",
    rejected: "a final ≥ 300 — {code}",
    timeout: "nobody answered within the block's deadline — {block}",
  },
  data: () => ({ tries: 0, dest: "" }),
  // No `then`: the deadline is an outcome like any other.
  timeout: { delay: 30_000 },
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
          fx.sbbReturn("connected", { uri: ev.from });
        },
        "sip:486": (_ev, _ctx, fx) => fx.sbbReturn("rejected", { code: 486 }),
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
            ctx.trace.push(`connected to ${ev.data.uri}`);
            return goto("talking");
          },
          "call:rejected": (ev, ctx) => {
            ctx.trace.push(`rejected ${ev.data.code}`);
            return failure(`rejected ${ev.data.code}`);
          },
          "call:timeout": (ev) => failure(`no answer from ${ev.data.block}`),
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
    type R = SbbReturn<"c", "done">;
    const Counter = defineSbb<{ n: number }, { type: "go" } | R, Data2, R>()({
      name: "Counter",
      namespace: "c",
      returns: { done: "counted once" },
      data: () => ({ tries: 0 }),
      timeout: { delay: "infinity" },
      states: {
        initial_state: {
          enter(_ctx, fx) {
            fx.data.tries++;
            seen.push(fx.data.tries);
            fx.sbbReturn("done", {});
          },
        },
      },
    });
    type Data2 = { tries: number };
    const M = defineMachine<{ n: number }, { type: "go" } | R>()({
      name: "Twice",
      context: () => ({ n: 0 }),
      states: {
        initial_state: {
          enter: (_c, fx) => fx.sbb(Counter),
          on: { "c:done": () => goto("again") },
        },
        again: {
          enter: (_c, fx) => fx.sbb(Counter),
          on: { "c:done": () => success() },
        },
      },
    });
    M.start();
    expect(seen).toEqual([1, 1]);
  });

  it("keeps the sandbox across entries when the call site says resume", () => {
    const seen: number[] = [];
    type R = SbbReturn<"c", "done">;
    type D = { tries: number };
    const Counter = defineSbb<{ n: number }, { type: "go" } | R, D, R>()({
      name: "Counter",
      namespace: "c",
      returns: { done: "counted once" },
      data: () => ({ tries: 0 }),
      timeout: { delay: "infinity" },
      states: {
        initial_state: {
          enter(_ctx, fx) {
            fx.data.tries++;
            seen.push(fx.data.tries);
            fx.sbbReturn("done", {});
          },
        },
      },
    });
    const M = defineMachine<{ n: number }, { type: "go" } | R>()({
      name: "Resumed",
      context: () => ({ n: 0 }),
      states: {
        initial_state: {
          enter: (_c, fx) => fx.sbb(Counter),
          on: { "c:done": () => goto("again") },
        },
        again: {
          enter: (_c, fx) => fx.sbb(Counter, { resume: true }),
          on: { "c:done": () => success() },
        },
      },
    });
    M.start();
    expect(seen).toEqual([1, 2]);
  });

  it("refuses a stale fx: only the top frame may return", () => {
    const warnings: string[] = [];
    type R = SbbReturn<"l", "done">;
    let escaped: { sbbReturn: (o: "done", d: unknown) => void } | undefined;
    const Leaky = defineSbb<
      Record<string, never>,
      { type: "go" } | R,
      Record<string, never>,
      R
    >()({
      name: "Leaky",
      namespace: "l",
      returns: { done: "done" },
      data: () => ({}),
      timeout: { delay: "infinity" },
      states: {
        initial_state: {
          enter(_ctx, fx) {
            escaped = fx as never;
            fx.sbbReturn("done", {});
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
          on: { "l:done": () => goto("after") },
        },
        after: {},
      },
    });
    const m = M.start({ logger: (l) => warnings.push(l) });
    expect(m.state).toBe("after");
    escaped?.sbbReturn("done", {}); // the block is long gone
    expect(warnings.join()).toContain("is not the one currently running");
    expect(m.state).toBe("after");
  });
});

describe("the declared vocabulary", () => {
  it("publishes what the block can send", () => {
    expect(Establish.namespace).toBe("call");
    expect(Object.keys(Establish.returns)).toEqual([
      "connected",
      "rejected",
      "timeout",
    ]);
    expect(Establish.returns.connected).toContain("answered");
  });

  it("fails the machine on an outcome the block did not declare", async () => {
    // Plain JS reaches here: TS refuses the call at compile time.
    type R = SbbReturn<"b", "done">;
    const B = defineSbb<
      Record<string, never>,
      { type: "go" } | R,
      Record<string, never>,
      R
    >()({
      name: "Typo",
      namespace: "b",
      returns: { done: "the only outcome" },
      data: () => ({}),
      timeout: { delay: "infinity" },
      states: {
        initial_state: {
          enter: (_c, fx) =>
            (fx.sbbReturn as (o: string, d: unknown) => void)("donne", {}),
        },
      },
    });
    const M = defineMachine<Record<string, never>, { type: "go" } | R>()({
      name: "H",
      context: () => ({}),
      states: {
        initial_state: {
          enter: (_c, fx) => fx.sbb(B),
          on: { "b:done": () => success() },
        },
      },
    });
    const m = M.start({ logger: () => {} });
    const r = await m.done;
    expect(r.outcome).toBe("failure");
    expect(r.reason).toContain("undeclared outcome 'donne'");
    expect(r.reason).toContain("declared: done");
  });

  it("builds the event as {namespace}:{outcome} carrying data", () => {
    const seen: unknown[] = [];
    const m = inBlock(host().start());
    m.subscribe((n) => {
      if (n.event) seen.push(n.event);
    });
    m.send({ type: "sip:200", from: "sip:bob@phone" });
    expect(seen).toContainEqual({
      type: "call:connected",
      data: { uri: "sip:bob@phone" },
    });
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

  it("returns the deadline as an outcome when the block declares no then", async () => {
    const m = inBlock(host().start());
    vi.advanceTimersByTime(30_000);
    expect((await m.done).reason).toBe("no answer from Establish");
  });

  it("lets timeout.then decide when the block declares one", async () => {
    type R = SbbReturn<"b", "gave_up", { after: number }>;
    const B = defineSbb<
      Record<string, never>,
      { type: "go" } | R,
      Record<string, never>,
      R
    >()({
      name: "Patient",
      namespace: "b",
      returns: { gave_up: "the block's own word for expiry — {after}" },
      data: () => ({}),
      timeout: {
        delay: 5_000,
        then: (_c, fx) => fx.sbbReturn("gave_up", { after: 5_000 }),
      },
      states: { initial_state: {} },
    });
    const M = defineMachine<Record<string, never>, { type: "go" } | R>()({
      name: "H",
      context: () => ({}),
      states: {
        initial_state: {
          enter: (_c, fx) => fx.sbb(B),
          on: { "b:gave_up": (ev) => failure(`waited ${ev.data.after}`) },
        },
      },
    });
    const m = M.start();
    vi.advanceTimersByTime(5_000);
    expect((await m.done).reason).toBe("waited 5000");
  });

  it("arms nothing for a block declaring delay: infinity", () => {
    type R = SbbReturn<"b", "done">;
    const B = defineSbb<
      Record<string, never>,
      { type: "go" } | R,
      Record<string, never>,
      R
    >()({
      name: "Endless",
      namespace: "b",
      returns: { done: "ended by an event, never by a clock" },
      data: () => ({}),
      timeout: { delay: "infinity" },
      states: {
        initial_state: { on: { go: (_e, _c, fx) => fx.sbbReturn("done", {}) } },
      },
    });
    const M = defineMachine<Record<string, never>, { type: "go" } | R>()({
      name: "H",
      context: () => ({}),
      states: {
        initial_state: {
          enter: (_c, fx) => fx.sbb(B),
          on: { "b:done": () => goto("after") },
        },
        after: {},
      },
    });
    const m = M.start();
    vi.advanceTimersByTime(10 * 60_000);
    expect(m.sbb?.block).toBe("Endless");
    m.send({ type: "go" });
    expect(m.state).toBe("after");
  });

  it("keeps the host's fx.delay alive across a block, and drops the block's", () => {
    const fired: string[] = [];
    type R = SbbReturn<"b", "done">;
    type E = { type: "go" } | { type: "ping"; who: string } | R;
    const B = defineSbb<Record<string, never>, E, Record<string, never>, R>()({
      name: "B",
      namespace: "b",
      returns: { done: "done" },
      data: () => ({}),
      timeout: { delay: "infinity" },
      states: {
        initial_state: {
          enter(_c, fx) {
            fx.delay({ type: "ping", who: "block" }, 5_000);
          },
          on: { go: (_e, _c, fx) => fx.sbbReturn("done", {}) },
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
            "b:done": () => stay(),
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
  type Inner_R = SbbReturn<"inner", "done">;
  type Outer_R = SbbReturn<"outer", "done">;
  type E2 = { type: "go" } | Inner_R | Outer_R;

  const Inner = defineSbb<
    { trace: string[] },
    E2,
    Record<string, never>,
    Inner_R
  >()({
    name: "Inner",
    namespace: "inner",
    returns: { done: "done" },
    data: () => ({}),
    timeout: { delay: "infinity" },
    states: {
      initial_state: {
        enter: (ctx) => {
          ctx.trace.push("inner");
        },
        on: { go: (_e, _c, fx) => fx.sbbReturn("done", {}) },
      },
    },
  });

  const Outer = defineSbb<
    { trace: string[] },
    E2,
    Record<string, never>,
    Outer_R
  >()({
    name: "Outer",
    namespace: "outer",
    returns: { done: "done" },
    data: () => ({}),
    timeout: { delay: "infinity" },
    states: {
      initial_state: {
        enter(ctx, fx) {
          ctx.trace.push("outer");
          fx.sbb(Inner);
        },
        on: {
          "inner:done": (_e, _c, fx) => fx.sbbReturn("done", {}),
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
    type RE = SbbReturn<"r", "done">;
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
      namespace: "r",
      returns: { done: "done" },
      data: () => ({}),
      timeout: { delay: "infinity" },
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
    type R = SbbReturn<"b", "done", { where: string }>;
    type E3 = { type: "go" } | R;
    const B = defineSbb<Record<string, never>, E3, Record<string, never>, R>()({
      name: "Steps",
      namespace: "b",
      returns: { done: "walked the three states — {where}" },
      data: () => ({}),
      timeout: { delay: "infinity" },
      states: {
        initial_state: { on: { go: () => next() } },
        second: { on: { go: () => next() } },
        third: {
          enter: (_c, fx) => fx.sbbReturn("done", { where: "third" }),
        },
      },
    });
    const M = defineMachine<Record<string, never>, E3>()({
      name: "H",
      context: () => ({}),
      states: {
        initial_state: {
          enter: (_c, fx) => fx.sbb(B),
          on: {
            "b:done": (ev) => goto(ev.data.where === "third" ? "ok" : "nope"),
          },
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
  const ok = {
    name: "V",
    namespace: "v",
    returns: { done: "done" },
    data: () => ({}),
    timeout: { delay: "infinity" as const },
    states: { initial_state: {} },
  };

  it("rejects a nameless block", () => {
    expect(() => defineSbb()({ ...ok, name: "" })).toThrow(/non-empty string/);
  });

  it("rejects a namespace carrying a colon", () => {
    expect(() => defineSbb()({ ...ok, namespace: "a:b" })).toThrow(
      /'namespace' must be a non-empty string without ':'/,
    );
  });

  it("rejects a block that declares no outcome", () => {
    expect(() => defineSbb()({ ...ok, returns: {} })).toThrow(
      /declares no outcome/,
    );
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

  it("rejects a missing timeout: the bound is a decision, not a default", () => {
    expect(() => defineSbb()({ ...ok, timeout: undefined as never })).toThrow(
      /'timeout' is required/,
    );
  });

  it("rejects an invalid timeout delay", () => {
    expect(() => defineSbb()({ ...ok, timeout: { delay: -1 } })).toThrow(
      /positive number or "infinity"/,
    );
  });

  it("rejects a bounded block whose 'timeout' outcome is undeclared", () => {
    expect(() => defineSbb()({ ...ok, timeout: { delay: 1000 } })).toThrow(
      /declare it in 'returns'/,
    );
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
  type R = SbbReturn<"b", "done">;
  type E = { type: "start" } | { type: "go" } | R | { type: "late" };

  const B = defineSbb<Record<string, never>, E, Record<string, never>, R>()({
    name: "B",
    namespace: "b",
    returns: { done: "done" },
    data: () => ({}),
    timeout: { delay: "infinity" },
    states: {
      initial_state: {
        on: { go: (_e, _c, fx) => fx.sbbReturn("done", {}) },
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
  type R = SbbReturn<"b", "done">;
  type E = { type: "dial"; n: string } | { type: "go" } | R;

  const B = defineSbb<{ seen: string[] }, E, Record<string, never>, R>()({
    name: "B",
    namespace: "b",
    returns: { done: "done" },
    data: () => ({}),
    timeout: { delay: "infinity" },
    states: {
      initial_state: {
        on: {
          dial: (ev, ctx, fx) => {
            ctx.seen.push(`block got ${ev.n}`);
            fx.sbbReturn("done", {});
          },
          go: (_e, _c, fx) => fx.sbbReturn("done", {}),
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
      R
    >()({
      name: "Chatty",
      namespace: "b",
      returns: { done: "done" },
      data: () => ({}),
      timeout: { delay: "infinity" },
      states: {
        initial_state: {
          on: {
            go: (_e, _c, fx) => {
              fx.sbbReturn("done", {});
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
