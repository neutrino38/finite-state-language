import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineMachine, stay, success, type TaskResult } from "../src/index.js";

type Ev =
  | { type: "go" }
  | { type: "again" }
  | { type: "drop" }
  | { type: "end" }
  | TaskResult<"policy", { level: number }>;

interface Ctx {
  results: string[];
  aborted: boolean;
}

/** A promise controlled by the test, optionally wired to the signal. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

function harness(d: ReturnType<typeof deferred<{ level: number }>>) {
  return defineMachine<Ctx, Ev>()({
    name: "Valet",
    context: () => ({ results: [], aborted: false }),
    states: {
      initial_state: {
        on: {
          go: (_ev, ctx, fx) => {
            fx.task(
              (signal) => {
                signal.addEventListener("abort", () => (ctx.aborted = true));
                return d.promise;
              },
              "policy",
              { timeout: 10_000 },
            );
            return stay("asked");
          },
          drop: (_ev, _ctx, fx) => {
            fx.cancel("policy");
            return stay("cancelled");
          },
          "task:policy": (ev, ctx) => {
            ctx.results.push(
              ev.ok ? `ok:${ev.value.level}` : `err:${ev.error}`,
            );
            return stay();
          },
          end: () => success(),
        },
      },
    },
  });
}

describe("§4.3 fx.task — the Valet pattern", () => {
  it("resolution delivers exactly one ok event", async () => {
    const d = deferred<{ level: number }>();
    const m = harness(d).start();
    m.send({ type: "go" });
    d.resolve({ level: 3 });
    await vi.runAllTimersAsync();
    expect(m.context.results).toEqual(["ok:3"]);
  });

  it("rejection delivers exactly one error event", async () => {
    const d = deferred<{ level: number }>();
    const m = harness(d).start();
    m.send({ type: "go" });
    d.reject(new Error("backend down"));
    await vi.runAllTimersAsync();
    expect(m.context.results).toEqual(["err:Error: backend down"]);
  });

  it("timeout wins, aborts the signal, and a late result is discarded", async () => {
    const d = deferred<{ level: number }>();
    const m = harness(d).start();
    m.send({ type: "go" });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(m.context.results).toEqual(["err:timeout"]);
    expect(m.context.aborted).toBe(true);
    d.resolve({ level: 9 }); // late — must be discarded
    await vi.runAllTimersAsync();
    expect(m.context.results).toEqual(["err:timeout"]);
  });

  it("fx.cancel aborts and discards: no event is ever delivered", async () => {
    const d = deferred<{ level: number }>();
    const m = harness(d).start();
    m.send({ type: "go" });
    m.send({ type: "drop" });
    expect(m.context.aborted).toBe(true);
    d.resolve({ level: 5 });
    await vi.runAllTimersAsync();
    expect(m.context.results).toEqual([]);
  });

  it("a result arriving after a terminal state is discarded", async () => {
    const d = deferred<{ level: number }>();
    const m = harness(d).start();
    m.send({ type: "go" });
    m.send({ type: "end" });
    expect(m.context.aborted).toBe(true); // terminal cancels pending tasks
    d.resolve({ level: 5 });
    await vi.runAllTimersAsync();
    expect(m.context.results).toEqual([]);
  });

  it("reusing a live tag cancels the previous task (design §11.5)", async () => {
    const first = deferred<{ level: number }>();
    const second = deferred<{ level: number }>();
    let firstAborted = false;
    const M = defineMachine<Ctx, Ev>()({
      name: "Reuse",
      context: () => ({ results: [], aborted: false }),
      states: {
        initial_state: {
          on: {
            go: (_ev, _ctx, fx) => {
              fx.task((signal) => {
                signal.addEventListener("abort", () => (firstAborted = true));
                return first.promise;
              }, "policy");
            },
            again: (_ev, _ctx, fx) => {
              fx.task(() => second.promise, "policy");
            },
            "task:policy": (ev, ctx) => {
              ctx.results.push(ev.ok ? `ok:${ev.value.level}` : "err");
            },
          },
        },
      },
    });
    const m = M.start();
    m.send({ type: "go" });
    m.send({ type: "again" });
    expect(firstAborted).toBe(true);
    first.resolve({ level: 1 }); // stale — discarded
    second.resolve({ level: 2 });
    await vi.runAllTimersAsync();
    expect(m.context.results).toEqual(["ok:2"]);
  });

  it("a synchronous throw in the work function becomes a rejection event", async () => {
    const M = defineMachine<Ctx, Ev>()({
      name: "SyncThrow",
      context: () => ({ results: [], aborted: false }),
      states: {
        initial_state: {
          on: {
            go: (_ev, _ctx, fx) => {
              fx.task(() => {
                throw new Error("sync boom");
              }, "policy");
            },
            "task:policy": (ev, ctx) => {
              ctx.results.push(ev.ok ? "ok" : ev.error);
            },
          },
        },
      },
    });
    const m = M.start();
    m.send({ type: "go" });
    await vi.runAllTimersAsync();
    expect(m.context.results).toEqual(["Error: sync boom"]);
  });
});
