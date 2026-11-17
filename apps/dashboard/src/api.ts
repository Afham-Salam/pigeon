/**
 * Pigeon Dashboard API Client & Authentication Storage
 *
 * Manages the single-owner admin token in localStorage, attaches
 * `Authorization: Bearer <token>` to outgoing requests, and triggers
 * automatic logout/redirection to the login screen on HTTP 401 Unauthorized.
 */

export const AUTH_TOKEN_KEY = 'pigeon_admin_token';

/**
 * Parse JSON responses without leaking the browser's opaque "Unexpected token <"
 * error when a dashboard/static-host fallback returns HTML instead of API data.
 */
export async function readApiJson<T>(response: Response): Promise<T> {
  const contentType = response.headers?.get?.('content-type') || '';
  if (typeof response.text !== 'function') {
    return response.json() as Promise<T>;
  }
  const body = await response.text();
  if (contentType && !contentType.toLowerCase().includes('application/json')) {
    const preview = body.trim().slice(0, 120);
    throw new Error(
      `API returned non-JSON content (${response.status}). Check that the dashboard API URL points to the Pigeon Worker, not the dashboard site.${preview ? ` Response: ${preview}` : ''}`,
    );
  }
  try {
    return JSON.parse(body) as T;
  } catch {
    throw new Error(`API returned invalid JSON (${response.status}).`);
  }
}

/**
 * Retrieves the stored admin password / token from localStorage.
 */
export function getStoredToken(): string | null {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      return window.localStorage.getItem(AUTH_TOKEN_KEY);
    }
  } catch {
    // Ignore storage read errors (e.g. storage disabled in private mode)
  }
  return null;
}

/**
 * Saves the admin password / token to localStorage.
 */
export function setStoredToken(token: string): void {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      window.localStorage.setItem(AUTH_TOKEN_KEY, token);
    }
  } catch {
    // Ignore storage write errors
  }
}

/**
 * Removes the stored admin password / token from localStorage.
 */
export function clearStoredToken(): void {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      window.localStorage.removeItem(AUTH_TOKEN_KEY);
    }
  } catch {
    // Ignore storage removal errors
  }
}

type UnauthorizedListener = () => void;
const unauthorizedListeners = new Set<UnauthorizedListener>();

/**
 * Subscribes a listener function to be called whenever any API request
 * returns a 401 Unauthorized response. Returns an unsubscribe function.
 */
export function onUnauthorized(callback: UnauthorizedListener): () => void {
  unauthorizedListeners.add(callback);
  return () => {
    unauthorizedListeners.delete(callback);
  };
}

/**
 * Clears the stored token and notifies all registered unauthorized listeners.
 */
export function notifyUnauthorized(): void {
  clearStoredToken();
  for (const listener of unauthorizedListeners) {
    try {
      listener();
    } catch {
      // Ignore listener error
    }
  }
}

/**
 * Authenticated fetch client that attaches `Authorization: Bearer <token>`
 * from localStorage to outgoing requests (unless an Authorization header is already provided).
 *
 * If the server responds with HTTP 401, clears the stored token and fires
 * unauthorized listeners so the UI redirects back to the login screen.
 */
export async function apiFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const token = getStoredToken();
  const headers = new Headers(init?.headers);

  if (token && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${token}`);
  }

  const response = await fetch(input, {
    ...init,
    headers,
  });

  if (response.status === 401) {
    notifyUnauthorized();
  }

  return response;
}

/**
 * Builds the Google OAuth start URL with the current stored admin token (if present)
 * so that browser-level navigation to /auth/google/start passes owner authentication.
 */
export function getGoogleAuthStartUrl(apiBase = ''): string {
  const token = getStoredToken();
  const base = `${apiBase}/auth/google/start`;
  return token ? `${base}?token=${encodeURIComponent(token)}` : base;
}
