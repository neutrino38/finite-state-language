/**
 * Public types of the core (design §3). The two user-facing type
 * parameters are Ctx (context shape) and Ev (event discriminated
 * union); state names (SN) are always inferred from the `states`
 * object literal, never written by the user.
 */

import type { Transition } from "./transition.js";
import type { LogEntry } from "./log.js";

/** An event is any object with a string `type` field (spec §4). */
export type AnyEvent = { type: string };

export type Outcome = "success" | "failure" | "aborted";

/** Predeclared terminal states, one per outcome (spec §3.1, design §11.8). */
export const TERMINAL_STATES = {
  success: "terminal_success_state",
  failure: "terminal_failure_state",
  aborted: "terminal_aborted_state",
} as const;

export type TerminalStateName = (typeof TERMINAL_STATES)[Outcome];

/** Handle returned by fx.delay: cancel before it fires. */
export interface DelayHandle {
  cancel(): void;
}

/**
 * Settlement event delivered by fx.task (spec §4.3) — add it to the
 * machine's event union: `type Ev = ... | TaskResult<"policy", Policy>`.
 */
export type TaskResult<Tag extends string, T = unknown> =
  | { type: `task:${Tag}`; ok: true; value: T }
  | { type: `task:${Tag}`; ok: false; error: string };

/** Sent to a child by fx.notify (spec §8.1). */
export type ParentMsg<P = unknown> = { type: "parent:msg"; payload: P };

/** Sent to the parent by fx.notifyParent (spec §8.1). */
export type ChildMsg<P = unknown> = {
  type: "child:msg";
  from: string;
  payload: P;
};

/** Sent to the parent when a child terminates (spec §8.1). */
export type ChildExit = {
  type: "child:exit";
  from: string;
  outcome: Outcome;
  reason?: string;
};

/** Effects facade passed to `enter` and to event handlers (design §3.4). */
export interface Fx<Ev extends AnyEvent> {
  /** Self-send: enqueued, processed after the current event (spec §4.3). */
  send(ev: Ev): void;
  /**
   * Send later. Cancelled on state exit unless `sticky` (spec §4.3).
   */
  delay(ev: Ev, ms: number, opts?: { sticky?: boolean }): DelayHandle;
  /**
   * The Valet pattern (spec §4.3): run `work`, deliver exactly one
   * `task:<tag>` event — settlement, timeout or nothing (if cancelled).
   * On timeout the AbortSignal fires so the work is actually cancelled.
   */
  task<T>(
    work: Promise<T> | ((signal: AbortSignal) => Promise<T>),
    tag: string,
    opts?: { timeout?: number },
  ): void;
  /** Abort and discard a pending task: its event will never arrive. */
  cancel(tag: string): void;
  /** Purge matching events from the pending queue (spec §4.2). */
  dropPending(sel: Ev["type"] | ((ev: Ev) => boolean)): void;
  /**
   * Start a child machine owned by this instance (spec §8.1). The
   * child inherits debug/logger; `args` merges into its fresh context.
   * Spawning a name that is already alive is a runtime error (⇒
   * failure). Child termination delivers `child:exit`.
   */
  spawn<C, E extends AnyEvent>(
    machine: Machine<C, E, string>,
    opts: { as: string; args?: Partial<C> },
  ): void;
  /** Deliver `{type: "parent:msg", payload}` to a named child. */
  notify(child: string, payload: unknown): void;
  /**
   * Deliver `{type: "child:msg", from, payload}` to the parent.
   * A no-op without a parent, so the same machine runs standalone.
   */
  notifyParent(payload: unknown): void;
}

/**
 * `NoInfer` on every SN use-site below keeps SN's only inference site
 * at the keys of `states` (design §3.2): without it, TypeScript would
 * infer SN from `goto(...)` return values, and `goto("typo")` would
 * widen the union instead of failing to compile.
 */
export type Handler<
  Ctx,
  Ev extends AnyEvent,
  E extends AnyEvent,
  SN extends string,
> = (ev: E, ctx: Ctx, fx: Fx<Ev>) => Transition<NoInfer<SN>> | void;

/**
 * Event-type → handler map (spec §3.2). A string value is a shorthand:
 * move to that state, then re-dispatch the event there (design §11.2).
 * `"*"` is the catch-all clause.
 */
export type OnMap<Ctx, Ev extends AnyEvent, SN extends string> = {
  [T in Ev["type"]]?:
    Handler<Ctx, Ev, Extract<Ev, { type: T }>, SN> | NoInfer<SN>;
} & { "*"?: Handler<Ctx, Ev, Ev, SN> | NoInfer<SN> };

export interface StateDef<
  Ctx,
  Ev extends AnyEvent,
  SN extends string = string,
> {
  /**
   * Synchronous set-up code, executed each time the state is entered
   * (including on `loop()`). Must never block (spec §3.2).
   */
  enter?: (ctx: Ctx, fx: Fx<Ev>) => Transition<NoInfer<SN>> | void;
  on?: OnMap<Ctx, Ev, SN>;
  /**
   * One timer, armed when the state is entered, cancelled on exit,
   * re-armed on `loop()` — the Elixir `after` clause (spec §3.2).
   */
  after?: {
    delay: number;
    then: (ctx: Ctx, fx: Fx<Ev>) => Transition<NoInfer<SN>> | void;
  };
  /** Free-form UI hints, exposed as `snapshot.meta` (spec §7.3). */
  meta?: Record<string, unknown>;
}

export interface MachineDef<
  Ctx,
  Ev extends AnyEvent,
  SN extends string = string,
> {
  /** For logs, devtools, diagram export. */
  name: string;
  /** Factory producing a fresh context per instance (spec §3.1). */
  context: () => Ctx;
  /**
   * Ordered record of states. Declaration order defines `next()`.
   * Must contain `initial_state` (validated at define time).
   * SN — the union of state names — is inferred from the keys, which is
   * what makes `goto` type-checked inside the handlers (design §3.2).
   */
  states: Record<SN, StateDef<Ctx, Ev, SN>>;
  /** Pending-queue bound, default 32 (spec §4.2). */
  pending?: { max?: number };
  /**
   * Cooperative shutdown hook (spec §8.2): decides the exit. May return
   * a terminal transition, a non-terminal one (finish business first —
   * the machine keeps running toward its own end), or nothing
   * (⇒ aborted with the shutdown reason).
   */
  onShutdown?: (ctx: Ctx, fx: Fx<Ev>) => Transition<NoInfer<SN>> | void;
  /** Called after any terminal transition, before `done` settles (spec §8.3). */
  cleanup?: (ctx: Ctx) => void;
}

export interface StartOpts<Ctx> {
  /** Log every transition in the Elixip format (spec §6.1). */
  debug?: boolean;
  /** Merged into the fresh context (spec §6). */
  args?: Partial<Ctx>;
  /** Destination for debug lines; defaults to console.debug. */
  logger?: (line: string) => void;
  /** Transition ring-buffer size, default 50. */
  logSize?: number;
  /**
   * Grace period (ms) granted to children for cooperative shutdown
   * before stragglers are force-stopped, default 5000 (spec §8.1).
   */
  graceMs?: number;
}

/**
 * Reference-stable view rebuilt only on transition — the external-store
 * contract for `useSyncExternalStore` and friends (spec §7.1, design §4.7).
 */
export interface Snapshot<
  Ctx,
  Ev extends AnyEvent,
  SN extends string = string,
> {
  readonly state: SN | TerminalStateName;
  readonly context: Ctx;
  readonly pending: readonly Ev[];
  readonly meta?: Record<string, unknown>;
}

export interface TransitionNotification<
  Ctx,
  Ev extends AnyEvent,
  SN extends string = string,
> {
  readonly state: SN | TerminalStateName;
  readonly context: Ctx;
  readonly event?: Ev;
  readonly desc?: string;
}

export type Listener<Ctx, Ev extends AnyEvent, SN extends string = string> = (
  n: TransitionNotification<Ctx, Ev, SN>,
) => void;

export interface DoneResult {
  outcome: Outcome;
  reason?: string;
}

/** A running machine instance (spec §6). */
export interface Instance<
  Ctx,
  Ev extends AnyEvent,
  SN extends string = string,
> {
  readonly state: SN | TerminalStateName;
  readonly context: Ctx;
  readonly done: Promise<DoneResult>;
  readonly log: readonly LogEntry[];
  readonly pending: readonly Ev[];
  send(ev: Ev): void;
  subscribe(fn: Listener<Ctx, Ev, SN>): () => void;
  getSnapshot(): Snapshot<Ctx, Ev, SN>;
  matches(s: SN | TerminalStateName): boolean;
  /** Cooperative shutdown (spec §8.2); resolves with the final outcome. */
  shutdown(reason?: string): Promise<DoneResult>;
}

export interface Machine<Ctx, Ev extends AnyEvent, SN extends string = string> {
  readonly name: string;
  start(opts?: StartOpts<Ctx>): Instance<Ctx, Ev, SN>;
}
