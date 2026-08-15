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

/**
 * Effects facade passed to `enter` and to event handlers.
 * M1 surface: `send` + `dropPending`; `delay`/`task`/`cancel` arrive in
 * M3, `spawn`/`notify`/`notifyParent` in M4 (design §3.4).
 */
export interface Fx<Ev extends AnyEvent> {
  /** Self-send: enqueued, processed after the current event (spec §4.3). */
  send(ev: Ev): void;
  /** Purge matching events from the pending queue (spec §4.2). */
  dropPending(sel: Ev["type"] | ((ev: Ev) => boolean)): void;
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

/** A running machine instance (spec §6). `shutdown` arrives in M4. */
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
}

export interface Machine<Ctx, Ev extends AnyEvent, SN extends string = string> {
  readonly name: string;
  start(opts?: StartOpts<Ctx>): Instance<Ctx, Ev, SN>;
}
