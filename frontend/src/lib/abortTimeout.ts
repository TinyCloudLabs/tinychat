/**
 * Run `run` with a signal that aborts after `ms`. Built on setTimeout because iOS 15
 * WKWebView and Safari before 16 have no AbortSignal.timeout.
 */
export function withAbortTimeout<T>(ms: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ms);
  return run(controller.signal).finally(() => clearTimeout(timeout));
}
