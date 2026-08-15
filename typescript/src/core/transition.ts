/**
 * Transition constructors (spec §3.3).
 *
 * Transitions are values returned by handlers — never called for side
 * effect. The union is parameterised by the target state name so that
 * `goto("typo")` fails to type-check against the machine's states
 * (design §3.3): target-free constructors return `Transition<never>`,
 * which is assignable to any `Transition<S>`.
 */

import type { Outcome } from "./types.js";

export type Transition<S extends string = string> =
  | { readonly kind: "goto"; readonly to: S; readonly desc?: string }
  | { readonly kind: "next"; readonly desc?: string }
  | { readonly kind: "loop"; readonly desc?: string }
  | { readonly kind: "stay"; readonly desc?: string }
  | {
      readonly kind: "final";
      readonly outcome: Outcome;
      readonly reason?: string;
    };

/** Move to a named state (type-checked against the machine's states). */
export function goto<S extends string>(to: S, desc?: string): Transition<S> {
  return Object.freeze({ kind: "goto", to, desc });
}

/** Move to the state declared after the current one (spec §3.1). */
export function next(desc?: string): Transition<never> {
  return Object.freeze({ kind: "next", desc });
}

/** Re-enter the current state: `enter` runs again, `after` re-arms. */
export function loop(desc?: string): Transition<never> {
  return Object.freeze({ kind: "loop", desc });
}

/**
 * Remain in the state without re-running `enter` — the explicit
 * "same state, new data" repaint tick (spec §5). Unlike returning
 * `void`, `stay()` notifies subscribers and is logged.
 */
export function stay(desc?: string): Transition<never> {
  return Object.freeze({ kind: "stay", desc });
}

/** Terminal transition: settle `machine.done` with outcome "success". */
export function success(reason?: string): Transition<never> {
  return Object.freeze({ kind: "final", outcome: "success", reason });
}

/** Terminal transition: settle `machine.done` with outcome "failure". */
export function failure(reason?: string): Transition<never> {
  return Object.freeze({ kind: "final", outcome: "failure", reason });
}

/** Terminal transition: settle `machine.done` with outcome "aborted". */
export function aborted(reason?: string): Transition<never> {
  return Object.freeze({ kind: "final", outcome: "aborted", reason });
}
