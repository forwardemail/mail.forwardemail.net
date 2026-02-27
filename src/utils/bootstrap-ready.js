let resolveReady = null;

export const bootstrapReady = new Promise((resolve) => {
  resolveReady = resolve;
});

export function markBootstrapReady() {
  if (resolveReady) {
    resolveReady();
    resolveReady = null;
  }
}

// Separate gate that resolves after app lock is dismissed and credentials
// are available.  Mailbox (and other components that make API calls) must
// await this before issuing requests.
let resolveAppReady = null;
export const appReady = new Promise((resolve) => {
  resolveAppReady = resolve;
});

export function markAppReady() {
  if (resolveAppReady) {
    resolveAppReady();
    resolveAppReady = null;
  }
}
