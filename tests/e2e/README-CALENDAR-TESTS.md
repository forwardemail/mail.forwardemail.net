# Calendar E2E Tests

This directory contains Playwright end-to-end tests for the calendar functionality.

## Test Files

### `calendar.spec.js` - Calendar Navigation

Tests basic calendar page functionality:

- Calendar header displays correctly
- Schedule-X calendar component renders
- Import and New Event buttons are visible

### `calendar-upload.spec.js` - ICS File Upload

Tests ICS file import functionality:

- Import menu opens/closes
- Simple ICS file upload
- Multi-event ICS file upload
- All-day event upload

### `calendar-events.spec.js` - Event Creation UI

Tests the new event modal and form interactions:

- Modal opens with title input focused
- Form accepts basic event details (title, date)
- All-day checkbox hides time fields
- Optional fields (location, URL, etc.) can be expanded
- Save button validation (enabled/disabled based on form state)
- Cancel and Escape key close modal

## Test Fixtures

### ICS Files (`tests/fixtures/ics/`)

- `simple-event.ics`: Single timed event
- `all-day-event.ics`: All-day event
- `multi-event.ics`: Three events in one file
- `event-with-details.ics`: Event with location, URL, attendees, etc.
- `invalid-event.ics`: Malformed ICS for error handling

### Helper Functions (`tests/fixtures/calendar-helpers.js`)

Reusable utilities for calendar tests:

- `setupAuthenticatedSession()`: Sets up auth tokens
- `navigateToCalendar()`: Navigates to calendar page
- `openNewEventModal()`: Opens new event modal
- `uploadICSFile()`: Uploads an ICS file
- More helpers for common operations

## Running the Tests

```bash
# Run all calendar tests
pnpm test:e2e tests/e2e/calendar*.spec.js

# Run specific test file
pnpm test:e2e tests/e2e/calendar-upload.spec.js

# Run in headed mode (see browser)
pnpm test:e2e tests/e2e/calendar.spec.js --headed

# Run with Playwright inspector for debugging
pnpm test:e2e tests/e2e/calendar.spec.js --debug
```

## Test Coverage

### What's Tested ✅

- Calendar page navigation and rendering
- ICS file upload UI interactions
- New event modal opening/closing
- Form input handling (title, date, description, etc.)
- All-day event checkbox behavior
- Optional fields expansion
- Form validation (Save button enable/disable)
- Modal keyboard shortcuts (Escape to close)

### What's NOT Tested ⏭️

- **Event rendering on calendar**: Skipped due to Schedule-X rendering timing complexities
- **Clicking existing events**: Requires events to render first
- **Saving events**: Better tested with integration tests
- **Edit/delete operations**: Depends on clicking rendered events

These limitations are intentional to keep tests fast and reliable. The tests focus on what users can interact with directly in the UI.

## Notes

- Tests use mocked API responses via `tests/e2e/mockApi.js`
- Authentication uses localStorage with `webmail_` prefix
- Schedule-X calendar has complex async rendering, so we avoid tests that depend on seeing rendered events
- Tests verify UI interactions; business logic is out of scope
