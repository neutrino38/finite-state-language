/**
 * finite-state-language — public API.
 *
 * See ../docs/design.md for the software design and
 * ../../spec/fsl-js-ts.md for the language specification.
 */

export { defineMachine } from "./core/define.js";
export {
  goto,
  next,
  loop,
  stay,
  success,
  failure,
  aborted,
  type Transition,
} from "./core/transition.js";
export { TERMINAL_STATES } from "./core/types.js";
export type {
  AnyEvent,
  DelayHandle,
  DoneResult,
  Fx,
  Handler,
  Instance,
  Listener,
  Machine,
  MachineDef,
  OnMap,
  Outcome,
  Snapshot,
  StartOpts,
  StateDef,
  TaskResult,
  TerminalStateName,
  TransitionNotification,
} from "./core/types.js";
export type { LogEntry } from "./core/log.js";

export const VERSION = "0.0.0";
