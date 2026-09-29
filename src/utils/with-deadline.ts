/**
 * Race a promise against a deadline.
 *
 * Used where the app waits on something that can stall rather than fail: the
 * IndexedDB cache after iOS suspended or killed the web process, or a worker
 * that never answers. Waiting on those without a deadline is how the mailbox
 * sat on its loading skeleton indefinitely. The original promise is not
 * cancelled; its outcome is simply no longer awaited.
 */
export class DeadlineError extends Error {
  label: string;

  ms: number;

  constructor(label: string, ms: number) {
    super(`${label} did not finish within ${ms}ms`);
    this.name = 'DeadlineError';
    this.label = label;
    this.ms = ms;
  }
}

export function withDeadline<T>(promise: Promise<T>, ms: number, label = 'operation'): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new DeadlineError(label, ms)), ms);
  });
  // A late rejection of the original promise must not surface as unhandled.
  Promise.resolve(promise).catch(() => {});
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}
