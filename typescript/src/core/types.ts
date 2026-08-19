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

/**
 * What a Service Building Block hands back (spec §8.4): the namespace it
 * declares, an outcome, and a map — the three slots of the Elixir dialect's
 * `{namespace, outcome, data}`, spelled as one event this dialect can
 * dispatch on.
 *
 * The arity is fixed on purpose. A block that learns to report one more
 * thing adds a key to `data`, which is invisible to a host that does not
 * read it; a fourth slot would break every host matching the old shape.
 *
 *     type CallReturn =
 *       | SbbReturn<"call", "connected", { uri: string; code: number }>
 *       | SbbReturn<"call", "rejected", { code: number; reason: string }>;
 */
export type SbbReturn<
  Ns extends string,
  O extends string,
  D = Record<string, never>,
> = {
  type: `${Ns}:${O}`;
  data: D;
};

/**
 * The namespace a block's return union speaks — `"call"` for the union
 * above. Used to type `SbbDef.namespace`, so the declaration and the
 * events cannot drift apart.
 */
export type SbbNamespace<Ret extends AnyEvent> = Ret extends {
  type: `${infer N}:${string}`;
}
  ? N
  : never;

/** The outcomes a block's return union declares — `"connected" | "rejected"`. */
export type SbbOutcome<Ret extends AnyEvent> = Ret extends {
  type: `${string}:${infer O}`;
}
  ? O
  : never;

/** The `data` map that goes with one outcome of a return union. */
export type SbbData<Ret extends AnyEvent, O extends string> =
  Extract<Ret, { type: `${string}:${O}` }> extends { data: infer D }
    ? D
    : never;

/**
 * Effects facade passed to `enter` and to event handlers (design §3.4).
 *
 * `Ctx` is the host context type. It is only load-bearing for `sbb`,
 * which uses it to reject a block the host cannot satisfy; every other
 * effect ignores it.
 */
export interface Fx<Ev extends AnyEvent, Ctx = unknown> {
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
  /**
   * Enter a Service Building Block (spec §8.4): a subroutine call, not
   * a second actor. This machine is suspended at the call site — its
   * `enter` will not re-run and its `after` is cancelled — while the
   * block handles every event, until the block calls `fx.sbbReturn`.
   *
   * The block shares this machine's context and gets a private sandbox
   * of its own, seeded by `args`. Two things are checked at compile
   * time: the host context must provide what the block declares it
   * requires, and every event the block can return must be part of the
   * host's event union — an outcome the host cannot match is the
   * silence this layer exists to prevent.
   *
   * `resume: true` keeps the sandbox the same block left behind on its
   * previous entry, which is what a block designed to be interrupted and
   * re-entered needs; without it the sandbox is fresh, so a hunt calling
   * one block on target after target cannot inherit the last attempt's
   * scratch.
   */
  sbb<E extends AnyEvent, D, Ret extends Ev>(
    block: Sbb<Ctx, E, D, Ret>,
    opts?: { args?: Partial<D>; resume?: boolean },
  ): void;
}

/**
 * The effects facade inside a block: everything a machine gets, plus
 * its private sandbox and the one way back (spec §8.4).
 */
export interface SbbFx<
  Ev extends AnyEvent,
  Ctx,
  Data,
  Ret extends AnyEvent,
> extends Fx<Ev, Ctx> {
  /**
   * The block's private scratch space (design §12.2), seeded by the
   * `args` of the call site and cleared on every entry. Mutate it
   * freely: no host and no sibling block can see it, which is why
   * writing here can never clobber anything.
   */
  readonly data: Data;
  /**
   * Pop the block and hand control back to the host state as a
   * `stay()`: the host's `enter` does not re-run, and its `after` is
   * armed afresh.
   *
   * The block names an outcome and hands over a map; the event posted to
   * the machine is `{ type: "<namespace>:<outcome>", data }`. An outcome
   * the block did not declare in `returns` is refused — a mistyped one
   * does not crash, it leaves the host waiting on a deadline for an event
   * nobody will ever send.
   *
   * The returned event is **not** privileged: whatever the block left
   * pending is replayed first, in arrival order.
   */
  sbbReturn<O extends SbbOutcome<Ret>>(outcome: O, data: SbbData<Ret, O>): void;
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
  F = Fx<Ev, Ctx>,
> = (ev: E, ctx: Ctx, fx: F) => Transition<NoInfer<SN>> | void;

/**
 * Event-type → handler map (spec §3.2). A string value is a shorthand:
 * move to that state, then re-dispatch the event there (design §11.2).
 * `"*"` is the catch-all clause.
 */
export type OnMap<
  Ctx,
  Ev extends AnyEvent,
  SN extends string,
  F = Fx<Ev, Ctx>,
> = {
  [T in Ev["type"]]?:
    Handler<Ctx, Ev, Extract<Ev, { type: T }>, SN, F> | NoInfer<SN>;
} & { "*"?: Handler<Ctx, Ev, Ev, SN, F> | NoInfer<SN> };

export interface StateDef<
  Ctx,
  Ev extends AnyEvent,
  SN extends string = string,
  F = Fx<Ev, Ctx>,
> {
  /**
   * Synchronous set-up code, executed each time the state is entered
   * (including on `loop()`). Must never block (spec §3.2).
   */
  enter?: (ctx: Ctx, fx: F) => Transition<NoInfer<SN>> | void;
  on?: OnMap<Ctx, Ev, SN, F>;
  /**
   * One timer, armed when the state is entered, cancelled on exit,
   * re-armed on `loop()` — the Elixir `after` clause (spec §3.2).
   */
  after?: {
    delay: number;
    then: (ctx: Ctx, fx: F) => Transition<NoInfer<SN>> | void;
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
  onShutdown?: (ctx: Ctx, fx: Fx<Ev, Ctx>) => Transition<NoInfer<SN>> | void;
  /** Called after any terminal transition, before `done` settles (spec §8.3). */
  cleanup?: (ctx: Ctx) => void;
}

/**
 * Definition of a Service Building Block (spec §8.4, design §12).
 *
 * A block is written in FSL like any machine, and differs in what it
 * owns: it has no context of its own — it works on the host's — and it
 * ends its branches on `fx.sbbReturn` instead of on a terminal.
 *
 * `Ctx` is a *requirement*, not a possession: it says what the block
 * needs to find in whichever host calls it, and `fx.sbb` refuses a host
 * that does not provide it. Declare the smallest shape that works.
 */
export interface SbbDef<
  Ctx,
  Ev extends AnyEvent,
  Data,
  Ret extends AnyEvent,
  SN extends string = string,
> {
  /** For logs, devtools, diagram export; qualifies the block's states. */
  name: string;
  /**
   * The first half of the block's vocabulary: the word its returns lead
   * with, so a host reading `"call:connected"` knows at a glance what
   * happened and tells two blocks called from the same state apart.
   *
   * It follows the verb a host writes, not the module path — the same
   * rule as the Elixir dialect's `@sbb_namespace`.
   */
  namespace: SbbNamespace<Ret>;
  /**
   * The other half: every outcome the block can return, and what it
   * means. The declaration is load-bearing rather than documentary —
   * `fx.sbbReturn` refuses an outcome that is not here, and the record
   * being exhaustive over the return union means a block cannot grow an
   * outcome it forgot to document.
   */
  returns: Record<SbbOutcome<Ret>, string>;
  /**
   * Factory for the block's private sandbox, fresh on every entry
   * (design §12.2) — a block entered twice starts twice from nothing,
   * which a hunt calling the same block on target after target needs.
   * `fx.sbb(block, { resume: true })` is the explicit exception.
   */
  data: () => Data;
  /** Ordered record of states, exactly as a machine's (spec §3.1). */
  states: Record<SN, StateDef<Ctx, Ev, SN, SbbFx<Ev, Ctx, Data, Ret>>>;
  /**
   * The block's own deadline, armed on entry and running across all of
   * its states (spec §8.4) — the host's `after` is suspended, so a
   * block that says nothing can never hold the machine for ever.
   *
   * It is **required**, and `delay: "infinity"` is how a block says it
   * has no bound of its own — the relay that ends when the dialog ends.
   * Making the author decide is the point: an unbounded block that was
   * not meant to be one is the silence this layer exists to prevent.
   *
   * `then` is optional. Without it the deadline is an outcome like any
   * other: the block returns `{namespace}:timeout` with `{ block }`, so
   * the host has one clause to write and no special case. Declaring
   * `timeout` in `returns` is then mandatory, checked at define time.
   * With it, `then` decides, and is expected to end on `fx.sbbReturn`
   * or on a terminal.
   */
  timeout: {
    delay: number | "infinity";
    then?: (
      ctx: Ctx,
      fx: SbbFx<Ev, Ctx, Data, Ret>,
    ) => Transition<NoInfer<SN>> | void;
  };
  /**
   * Called when the block is left through a terminal or a shutdown —
   * never on an ordinary `sbbReturn`, which is a normal ending the
   * block's own branch already handled. The place to release what the
   * block reserved, so unwinding past it does not leak.
   */
  cleanup?: (ctx: Ctx, data: Data) => void;
}

/**
 * A defined block, callable through `fx.sbb` (spec §8.4).
 *
 * `__requires` is a phantom: it never exists at run time. Its
 * contravariant position is what makes `fx.sbb(block)` reject a host
 * whose context does not satisfy the block's `Ctx`.
 */
export interface Sbb<
  Ctx,
  Ev extends AnyEvent,
  Data,
  Ret extends AnyEvent,
  SN extends string = string,
> {
  readonly name: string;
  /** The word its returns lead with — the machine-readable half of §8.4. */
  readonly namespace: string;
  /** Outcome → what it means: what this block can send, for whatever wants to show it. */
  readonly returns: Readonly<Record<string, string>>;
  /**
   * Phantoms: none of them exists at run time. A type parameter that
   * appears nowhere in the structure is invisible to assignability, so
   * without these `fx.sbb` would infer and check nothing.
   *
   * `__requires` is contravariant on purpose — that is what makes a
   * block assignable only to a host whose context satisfies it.
   */
  readonly __requires: (ctx: Ctx) => void;
  readonly __handles: (ev: Ev) => void;
  readonly __data: Data;
  readonly __returns: Ret;
  readonly __states: SN;
  /** Static structure export, as `Machine.toMermaid()` (spec §6.1). */
  toMermaid(): string;
}

/**
 * Where a machine is inside a block (spec §8.4, design §12.5). The
 * innermost block, because that is where the machine actually is; the
 * chain of enclosing ones is not worth a field that has to fit a
 * terminal.
 */
export interface SbbView {
  /** The block's `name`. */
  readonly block: string;
  /** The state the block is in, unqualified. */
  readonly state: string;
  /** 1 for a block called by the host, 2 for one it called in turn. */
  readonly depth: number;
  /**
   * The block state's `meta`. `snapshot.meta` stays the host's, so a
   * view that follows a block reads its hints here and the two never
   * disagree about which state they describe.
   */
  readonly meta?: Record<string, unknown>;
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
  /**
   * The host state. A running block does not change it: a subroutine
   * call is not a state its caller declared, and reporting one would
   * make the machine look like it jumped somewhere it cannot go.
   */
  readonly state: SN | TerminalStateName;
  readonly context: Ctx;
  readonly pending: readonly Ev[];
  readonly meta?: Record<string, unknown>;
  /** Set while a block runs (spec §8.4): where inside it the machine is. */
  readonly sbb?: SbbView;
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
  /** Set while a block runs (spec §8.4). */
  readonly sbb?: SbbView;
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
  /** Where inside a block the machine is, or undefined (spec §8.4). */
  readonly sbb: SbbView | undefined;
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
  /**
   * Static structure export for documentation (spec §6.1): every state
   * in declaration order, string-shorthand transitions as edges, and a
   * per-state description with the listened events and the `after`
   * delay. Handler-internal gotos are closures and are deliberately not
   * extracted — the transition log is the dynamic trace.
   */
  toMermaid(): string;
}
