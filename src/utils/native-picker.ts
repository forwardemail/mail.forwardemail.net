/**
 * Click handler for date and time inputs that opens the browser's own picker
 * from a click anywhere in the field, not just on its calendar or clock icon.
 * Desktop Chromium otherwise only opens it from the icon, and some mobile
 * webviews only from the icon too. Typing into the field still works.
 */
export function openNativePicker(event: MouseEvent) {
  const input = event.currentTarget as HTMLInputElement | null;
  if (!input || input.disabled || input.readOnly) return;
  try {
    input.showPicker?.();
  } catch {
    // Older engines throw when the picker is already open or the input
    // type has no picker. The field still takes typed input.
  }
}
