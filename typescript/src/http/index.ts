/**
 * finite-state-language/http — HTTP requests as events (spec §4.4).
 *
 * The transposition of Elixip's HTTP.Session mixin, built on fx.task
 * exactly as the original is built on Valet: exactly one event per
 * call, timeout aborts the fetch, late or post-terminal results are
 * discarded. Zero dependencies — standard fetch (browsers, Node ≥ 18).
 */

import type { AnyEvent, Fx } from "../core/types.js";
import type { TaskOpts, TaskSettlement } from "../core/tasks.js";

/**
 * The event delivered by httpGet — add it to the machine's union:
 * `type Ev = ... | HttpResult<"provisioning">`.
 *
 * A non-2xx status is NOT an error: the handler inspects `ev.status`.
 * `ok: false` means network failure, parse failure or "timeout".
 */
export type HttpResult<Tag extends string> =
  | {
      type: `http:${Tag}`;
      ok: true;
      status: number;
      headers: Headers;
      body: unknown;
    }
  | { type: `http:${Tag}`; ok: false; error: string };

export interface HttpGetOpts<Tag extends string> {
  tag: Tag;
  timeout?: number;
  headers?: HeadersInit;
  /** "json" (default) | "text" | "raw" (the Response object as body). */
  parse?: "json" | "text" | "raw";
}

interface HttpPayload {
  status: number;
  headers: Headers;
  body: unknown;
}

/** Internal shape of fx.task including the mapEvent hook (design §7). */
interface InternalTaskFx {
  task<T>(
    work: (signal: AbortSignal) => Promise<T>,
    tag: string,
    opts?: TaskOpts<T>,
  ): void;
}

export function httpGet<Tag extends string, Ev extends AnyEvent>(
  fx: Fx<Ev>,
  url: string,
  opts: HttpGetOpts<Tag>,
): void {
  const { tag, timeout, headers, parse = "json" } = opts;
  const work = async (signal: AbortSignal): Promise<HttpPayload> => {
    const res = await fetch(url, { signal, headers });
    const body =
      parse === "raw"
        ? res
        : parse === "text"
          ? await res.text()
          : await res.json();
    return { status: res.status, headers: res.headers, body };
  };
  const mapEvent = (s: TaskSettlement<HttpPayload>): HttpResult<Tag> =>
    s.ok
      ? {
          type: `http:${tag}`,
          ok: true,
          status: s.value.status,
          headers: s.value.headers,
          body: s.value.body,
        }
      : { type: `http:${tag}`, ok: false, error: s.error };
  // The registry key is namespaced so an fx.task("x") and an
  // httpGet(tag: "x") never collide.
  (fx as unknown as InternalTaskFx).task(work, `http:${tag}`, {
    timeout,
    mapEvent,
  });
}
