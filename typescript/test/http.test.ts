/**
 * finite-state-language/http (spec §4.4), tested against a mocked
 * global fetch — no network in CI. Mirrors the Elixip query_backend
 * example shape.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineMachine, failure, next, stay, success } from "../src/index.js";
import { httpGet, type HttpResult } from "../src/http/index.js";

type Ev = { type: "go" } | HttpResult<"provisioning">;

interface Ctx {
  data?: unknown;
  events: string[];
}

const QueryBackend = defineMachine<Ctx, Ev>()({
  name: "QueryBackend",
  context: () => ({ events: [] }),
  states: {
    initial_state: {
      enter(_ctx, fx) {
        httpGet(fx, "https://backend/api/x", {
          tag: "provisioning",
          timeout: 10_000,
        });
      },
      on: {
        "http:provisioning": (ev, ctx) => {
          ctx.events.push(ev.ok ? `ok:${ev.status}` : `err:${ev.error}`);
          if (!ev.ok) return failure(`backend ${ev.error}`);
          if (ev.status !== 200) return failure(`backend HTTP ${ev.status}`);
          ctx.data = ev.body;
          return next("backend OK");
        },
      },
    },
    done_state: {
      enter() {
        return success("provisioned");
      },
    },
  },
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("spec §4.4 — HTTP as events", () => {
  it("delivers one ok event with status and parsed json body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(200, { plan: "gold" })),
    );
    const m = QueryBackend.start();
    await vi.runAllTimersAsync();
    expect(m.context.data).toEqual({ plan: "gold" });
    expect(await m.done).toEqual({
      outcome: "success",
      reason: "provisioned",
    });
  });

  it("a non-2xx status is not an error: the handler decides", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(503, { oops: true })),
    );
    const m = QueryBackend.start();
    await vi.runAllTimersAsync();
    expect(m.context.events).toEqual(["ok:503"]);
    expect((await m.done).reason).toBe("backend HTTP 503");
  });

  it("a network failure delivers ok:false with the error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    const m = QueryBackend.start();
    await vi.runAllTimersAsync();
    expect((await m.done).reason).toBe("backend TypeError: fetch failed");
  });

  it("timeout aborts the fetch and delivers exactly one event", async () => {
    let signalAborted = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise<Response>((_res, rej) => {
            init.signal?.addEventListener("abort", () => {
              signalAborted = true;
              rej(new DOMException("aborted", "AbortError"));
            });
          }),
      ),
    );
    const m = QueryBackend.start();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(signalAborted).toBe(true);
    expect(m.context.events).toEqual(["err:timeout"]);
    expect((await m.done).reason).toBe("backend timeout");
  });

  it("parse: 'text' delivers the raw text body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("hello", { status: 200 })),
    );
    type TEv = { type: "go" } | HttpResult<"page">;
    const M = defineMachine<{ body?: unknown }, TEv>()({
      name: "TextGet",
      context: () => ({}),
      states: {
        initial_state: {
          enter(_ctx, fx) {
            httpGet(fx, "https://backend/page", { tag: "page", parse: "text" });
          },
          on: {
            "http:page": (ev, ctx) => {
              if (ev.ok) ctx.body = ev.body;
              return stay("got it");
            },
          },
        },
      },
    });
    const m = M.start();
    await vi.runAllTimersAsync();
    expect(m.context.body).toBe("hello");
  });
});
