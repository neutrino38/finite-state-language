/**
 * TaskManager — the Valet pattern (spec §4.3, design §5): every
 * long-running work becomes exactly one tagged event, the timeout is
 * arbitrated at this single choke point, and no late settlement can
 * ever leak into a later state.
 */

import type { AnyEvent } from "./types.js";

export type TaskSettlement<T = unknown> =
  { ok: true; value: T } | { ok: false; error: string };

export interface TaskOpts<T = unknown> {
  timeout?: number;
  /**
   * Internal hook (design §7), used by the /http module to reshape the
   * settlement into its own event type. Not part of the public Fx.
   */
  mapEvent?: (s: TaskSettlement<T>) => AnyEvent;
}

interface Entry {
  ctrl: AbortController;
  timer: ReturnType<typeof setTimeout> | undefined;
  settled: boolean;
}

export class TaskManager {
  private readonly map = new Map<string, Entry>();

  constructor(private readonly deliver: (ev: AnyEvent) => void) {}

  run<T>(
    work: Promise<T> | ((signal: AbortSignal) => Promise<T>),
    tag: string,
    opts: TaskOpts<T> = {},
  ): void {
    this.cancel(tag); // one live task per tag (design §11.5)
    const ctrl = new AbortController();
    const entry: Entry = { ctrl, timer: undefined, settled: false };
    this.map.set(tag, entry);

    // async wrapper: a synchronous throw in `work` becomes a rejection
    const promise =
      typeof work === "function" ? (async () => work(ctrl.signal))() : work;

    if (opts.timeout !== undefined) {
      entry.timer = setTimeout(() => {
        // timeout wins: abort so the underlying work is actually
        // cancelled — the TS equivalent of Process.exit(worker, :kill)
        this.settle(entry, tag, { ok: false, error: "timeout" }, opts, true);
      }, opts.timeout);
    }

    promise.then(
      (value) => this.settle(entry, tag, { ok: true, value }, opts, false),
      (err: unknown) =>
        this.settle(entry, tag, { ok: false, error: String(err) }, opts, false),
    );
  }

  /** fx.cancel(tag): abort and discard — no event is ever delivered. */
  cancel(tag: string): void {
    const entry = this.map.get(tag);
    if (entry === undefined) return;
    entry.settled = true;
    if (entry.timer !== undefined) clearTimeout(entry.timer);
    entry.ctrl.abort();
    this.map.delete(tag);
  }

  /** Terminal transition: discard every outstanding task (spec §8.3). */
  cancelAll(): void {
    for (const tag of [...this.map.keys()]) this.cancel(tag);
  }

  private settle<T>(
    entry: Entry,
    tag: string,
    result: TaskSettlement<T>,
    opts: TaskOpts<T>,
    abort: boolean,
  ): void {
    // First of {settlement, timeout, cancellation} wins; every later
    // outcome of the same task is discarded (spec §4.3).
    if (entry.settled || this.map.get(tag) !== entry) return;
    entry.settled = true;
    if (entry.timer !== undefined) clearTimeout(entry.timer);
    this.map.delete(tag);
    if (abort) entry.ctrl.abort();
    this.deliver(
      opts.mapEvent
        ? opts.mapEvent(result)
        : ({ type: `task:${tag}`, ...result } as AnyEvent),
    );
  }
}
