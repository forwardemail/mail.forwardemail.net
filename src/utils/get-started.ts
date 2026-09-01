/**
 * Visibility and completion rules for the "Get started" checklist card.
 *
 * Kept free of DOM and store imports so the same rules can back the card in
 * the empty inbox, the copy in Settings, and the unit tests.
 */

/** Permission value reported by getPushNotificationStatus() on Tauri. */
export type PushPermission = 'granted' | 'not-granted' | 'unsupported' | 'unknown' | null;

/** Value of the web Notification.permission property, or null when the API is absent. */
export type WebNotificationPermission = 'granted' | 'denied' | 'default' | null;

export interface GetStartedItemState {
  id: string;
  complete: boolean;
}

/**
 * The theme setting defaults to 'system' when the raw key is absent, so an
 * explicit choice is simply the key existing at all. setSettingValue removes
 * the key when a value serializes to null, which keeps this reliable.
 */
export const isThemeChosen = (rawTheme: string | null): boolean =>
  rawTheme !== null && rawTheme !== '';

/**
 * Notification permission across platforms. The Tauri probe wins when it has
 * a definite answer; otherwise fall back to the web Notification API, which
 * is also what the notification bridge reads outside Tauri.
 */
export const resolveNotificationComplete = (
  tauriPermission: PushPermission,
  webPermission: WebNotificationPermission,
): boolean => {
  if (tauriPermission === 'granted') return true;
  if (tauriPermission === 'not-granted') return false;
  return webPermission === 'granted';
};

/**
 * The card shows only while there is something left to do: a dismissal or
 * demo mode hides it outright, and finishing every item retires it.
 */
export const shouldShowGetStarted = ({
  dismissed,
  demoMode,
  items,
}: {
  dismissed: boolean;
  demoMode: boolean;
  items: GetStartedItemState[];
}): boolean => {
  if (dismissed || demoMode) return false;
  return items.some((item) => !item.complete);
};
