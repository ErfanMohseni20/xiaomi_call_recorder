import { noop } from "./no-op.js";
/**
 * Suppress Node.js unhandled rejection warning for a Promise
 * @param promise The Promise to suppress unhandled rejection warnings for
 */
export function suppressUnhandledRejection(promise) {
    promise.catch(noop);
}
//# sourceMappingURL=suppress-unhandled-rejection.js.map