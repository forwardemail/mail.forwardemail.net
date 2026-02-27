import ky from 'ky';
import { config } from '../config.js';
import { buildApiKeyAuthHeader, getAuthHeader } from './auth.ts';
import { logApiError } from './error-logger.ts';
import { logPerfEvent } from './perf-logger.ts';
import { interceptDemoRequest, isDemoMode } from './demo-mode';

// Action-specific timeouts for better performance
const TIMEOUT_BY_ACTION = {
  Folders: 5000,
  FolderGet: 5000,
  FolderCreate: 5000,
  FolderUpdate: 5000,
  FolderDelete: 5000,
  Labels: 5000,
  MessageList: 10000,
  Contacts: 10000,
  ContactsCreate: 10000,
  Message: 20000,
  MessageUpdate: 15000,
  MessageDelete: 10000,
  CalendarEvents: 15000,
  Emails: 30000,
  Account: 10000,
  AccountUpdate: 15000,
  default: 30000,
};

const addJitter = (delay) => delay + Math.random() * 1000;

// Create base ky instance with default configuration
const api = ky.create({
  prefixUrl: config.apiBase,
  timeout: 30000, // 30 second timeout (default, overridden per-action)
  retry: {
    limit: 3,
    methods: ['get', 'post', 'put', 'delete'],
    statusCodes: [0, 408, 413, 429, 500, 502, 503, 504],
    backoffLimit: 5000,
    delay: (attemptCount) => addJitter(Math.min(1000 * Math.pow(2, attemptCount - 1), 5000)),
  },
  headers: {
    Accept: 'application/json',
    'Content-Type': 'application/json',
  },
});

export const Remote = {
  async request(action, params = {}, options = {}) {
    // Demo mode: intercept all requests with fake data
    if (isDemoMode()) {
      const demo = interceptDemoRequest(action, params, options);
      if (demo.handled) {
        // Write actions return { blocked: true } — throw so callers
        // enter their error path.  The demo toast was already shown.
        if (demo.result?.blocked) {
          const err = new Error('Demo mode');
          err.isDemo = true;
          throw err;
        }
        return demo.result;
      }
    }

    const { path, method: defaultMethod } = this.getEndpoint(action);
    const method = (options.method || defaultMethod || 'GET').toLowerCase();
    const { signal } = options;
    const perfLabel = options.perfLabel || action;
    const perfStart = performance?.now ? performance.now() : null;

    // Build URL path
    const urlPath = (options.pathOverride || path).replace(/^\//, ''); // Remove leading slash for ky

    // Prepare headers
    const headers = { ...options.headers };

    // Handle authorization
    if (!options.skipAuth && this.shouldAuthorize(action)) {
      if (options.apiKey) {
        headers.Authorization = buildApiKeyAuthHeader(options.apiKey);
      } else {
        headers.Authorization = getAuthHeader({ allowApiKey: false, required: true });
      }
    }

    // Prepare ky options
    const kyOptions = {
      method,
      headers,
      signal,
      timeout: TIMEOUT_BY_ACTION[action] || TIMEOUT_BY_ACTION.default,
      hooks: {
        afterResponse: [
          async (request, options, response) => {
            // Log API errors for feedback system
            if (!response.ok) {
              const contentType = response.headers.get('content-type') || '';
              const isJson = contentType.includes('application/json');
              let errorData = null;

              try {
                errorData = isJson ? await response.clone().json() : null;
              } catch (e) {
                // Failed to parse JSON
                logApiError(action, method.toUpperCase(), 0, e);
              }

              // Sanitize error message to prevent server info leakage
              const rawMessage = errorData?.message || errorData?.error || 'Request failed';
              // Strip server-specific details (stack traces, file paths, internal IPs)
              const message =
                typeof rawMessage === 'string'
                  ? rawMessage
                      .replace(
                        /\b(?:\/[\w./-]+|\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}|at\s+\S+)\b/g,
                        '[redacted]',
                      )
                      .slice(0, 500)
                  : 'Request failed';
              const error = new Error(message);
              // Only copy safe, known fields from error data
              if (errorData && typeof errorData === 'object') {
                const safeFields = ['code', 'description', 'param', 'type'];
                for (const field of safeFields) {
                  if (field in errorData) error[field] = errorData[field];
                }
              }
              error.status = response.status;

              logApiError(action, method.toUpperCase(), response.status, error);
            }
            return response;
          },
        ],
      },
    };

    // Handle params based on method
    if (method === 'get') {
      // Filter out empty values for GET requests
      const searchParams = {};
      Object.entries(params || {}).forEach(([key, value]) => {
        if (value !== undefined && value !== null && value !== '') {
          searchParams[key] = value;
        }
      });
      kyOptions.searchParams = searchParams;
    } else {
      // For POST/PUT/DELETE, send as JSON body
      kyOptions.json = params || {};
    }

    try {
      const response = await api(urlPath, kyOptions);

      // ky automatically parses JSON if content-type is application/json
      // For non-JSON responses, we need to handle differently
      const contentType = response.headers.get('content-type') || '';
      const isJson = contentType.includes('application/json');

      if (isJson) {
        return await response.json();
      }

      return null;
    } catch (error) {
      console.error(`Remote.${action} failed:`, error);

      // ky throws HTTPError for non-2xx responses
      // For network errors, error.name will be 'TypeError'
      if (error.name === 'HTTPError') {
        // HTTP error - already logged in afterResponse hook
        const err = new Error(error.message);
        err.status = error.response.status;

        // Try to get error details from response
        try {
          const errorData = await error.response.json();
          if (errorData && typeof errorData === 'object') {
            Object.assign(err, errorData);
            err.message = errorData.message || errorData.error || error.message;
          }
        } catch (e) {
          // Couldn't parse JSON, use original error
          logApiError(action, method.toUpperCase(), 0, e);
        }

        throw err;
      } else if (error.name === 'TimeoutError') {
        // Timeout error
        const err = new Error('Request timeout');
        err.status = 408;
        logApiError(action, method.toUpperCase(), 408, err);
        throw err;
      } else {
        // Network error or other error (no status code)
        logApiError(action, method.toUpperCase(), 0, error);
        throw error;
      }
    } finally {
      if (perfStart && typeof performance !== 'undefined' && performance.now) {
        const duration = performance.now() - perfStart;
        logPerfEvent('api.request', {
          action,
          method: method.toUpperCase(),
          path: options.pathOverride || path,
          duration,
          label: perfLabel,
        });
      }
    }
  },

  getEndpoint(action) {
    const endpoints = {
      Folders: { path: '/v1/folders', method: 'GET' },
      FolderCreate: { path: '/v1/folders', method: 'POST' },
      FolderGet: { path: '/v1/folders/:id', method: 'GET' },
      FolderUpdate: { path: '/v1/folders/:id', method: 'PUT' },
      FolderDelete: { path: '/v1/folders/:id', method: 'DELETE' },
      MessageList: { path: '/v1/messages', method: 'GET' },
      Message: { path: '/v1/messages', method: 'GET' },
      MessageUpdate: { path: '/v1/messages', method: 'PUT' },
      MessageDelete: { path: '/v1/messages', method: 'DELETE' },
      Contacts: { path: '/v1/contacts', method: 'GET' },
      ContactsCreate: { path: '/v1/contacts', method: 'POST' },
      ContactsUpdate: { path: '/v1/contacts', method: 'PUT' },
      ContactsDelete: { path: '/v1/contacts', method: 'DELETE' },
      Calendars: { path: '/v1/calendars', method: 'GET' },
      Calendar: { path: '/v1/calendars', method: 'GET' },
      CalendarUpdate: { path: '/v1/calendars', method: 'PUT' },
      CalendarEvents: { path: '/v1/calendar-events', method: 'GET' },
      CalendarEventCreate: { path: '/v1/calendar-events', method: 'POST' },
      CalendarEventUpdate: { path: '/v1/calendar-events', method: 'PUT' },
      CalendarEventDelete: { path: '/v1/calendar-events', method: 'DELETE' },
      Labels: { path: '/v1/labels', method: 'GET' },
      LabelsCreate: { path: '/v1/labels', method: 'POST' },
      LabelsUpdate: { path: '/v1/labels', method: 'PUT' },
      Emails: { path: '/v1/emails', method: 'POST' },
      EmailCancel: { path: '/v1/emails/:id', method: 'DELETE' },
      Account: { path: '/v1/account', method: 'GET' },
      AccountUpdate: { path: '/v1/account', method: 'PUT' },
    };

    const entry = endpoints[action];
    if (entry) return entry;
    return { path: `/v1/${String(action || '').toLowerCase()}`, method: 'GET' };
  },

  shouldAuthorize(action) {
    if (!action) return true;
    return action !== 'Login';
  },
};
