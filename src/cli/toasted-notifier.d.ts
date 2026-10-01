// toasted-notifier ships without type declarations; these are the parts
// notifications.ts uses.
declare module 'toasted-notifier/notifiers/*' {
  class Notifier {
    constructor(options?: Record<string, unknown>);
    notify(
      options: Record<string, unknown>,
      callback?: (error: unknown, response: unknown, metadata?: unknown) => void,
    ): this;
  }
  export default Notifier;
}
