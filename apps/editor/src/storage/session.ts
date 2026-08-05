import { API_ORIGIN, NotSignedIn, type CloudSession } from './cloudProjects';
import { signIn as adoptSession, signOut as clearSession } from './backend';

/**
 * Signing in, and staying signed in across a reload.
 *
 * The token lives in `localStorage`, which is a deliberate and imperfect choice: it is readable by
 * any script on this origin, so a cross-site scripting bug becomes a session theft. The
 * alternative is an httpOnly cookie, which needs the API and the editor to share a site — they do
 * not today, and arranging it is a deployment decision rather than a code one. Written down here
 * so the trade is visible rather than accidental, and so the day the editor and API are served
 * together, this is the file that changes.
 */

const STORAGE_KEY = 'helaengine/session';

export interface SignedIn {
  session: CloudSession;
  displayName: string;
  email: string;
}

export function apiConfigured(): boolean {
  return typeof API_ORIGIN === 'string' && API_ORIGIN.length > 0;
}

/** Restores a session from a previous visit, if it is still valid. */
export async function restore(): Promise<SignedIn | null> {
  if (!apiConfigured()) return null;

  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;

  try {
    const stored = JSON.parse(raw) as CloudSession;
    // Verified against the API rather than trusted: a token in storage proves somebody was signed
    // in once, not that they still are, and starting the editor in a state the server disagrees
    // with is how a save fails at the worst possible moment.
    const me = await fetchMe(stored);
    // Refreshed from the server rather than trusted from storage: a session written by an older
    // build has no user id on it, and a collaborator with an empty id would share a colour with
    // everybody else in the same state.
    const session = { ...stored, userId: me.userId, displayName: me.displayName };
    adoptSession(session);
    return { session, ...me };
  } catch {
    localStorage.removeItem(STORAGE_KEY);
    return null;
  }
}

export async function signUp(input: {
  email: string;
  password: string;
  displayName: string;
}): Promise<SignedIn> {
  const body = await post<{
    user: { id: string; email: string; displayName: string };
    personalOrganizationId: string;
    session: { token: string };
  }>('/auth/signup', input);

  const session: CloudSession = {
    origin: API_ORIGIN!,
    token: body.session.token,
    organizationId: body.personalOrganizationId,
    userId: body.user.id,
    displayName: body.user.displayName,
  };
  return remember(session, body.user);
}

export async function signIn(input: { email: string; password: string }): Promise<SignedIn> {
  const body = await post<{ session: { token: string } }>('/auth/login', input);
  // The login response says who you are but not which workspace to open, so the personal one is
  // fetched rather than assumed — a returning user may have been invited to several.
  const partial: CloudSession = {
    origin: API_ORIGIN!,
    token: body.session.token,
    organizationId: '',
    userId: '',
    displayName: '',
  };
  const me = await fetchMe(partial);

  return remember(
    {
      ...partial,
      organizationId: me.organizationId,
      userId: me.userId,
      displayName: me.displayName,
    },
    me,
  );
}

export function signOut(): void {
  localStorage.removeItem(STORAGE_KEY);
  clearSession();
}

function remember(session: CloudSession, who: { email: string; displayName: string }): SignedIn {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  adoptSession(session);
  return { session, email: who.email, displayName: who.displayName };
}

async function fetchMe(
  session: CloudSession,
): Promise<{ userId: string; email: string; displayName: string; organizationId: string }> {
  const response = await fetch(`${session.origin}/me`, {
    headers: { authorization: `Bearer ${session.token}` },
  });
  if (response.status === 401) throw new NotSignedIn();
  if (!response.ok) throw new Error('The API did not answer.');

  const body = (await response.json()) as {
    user: { id: string; email: string; displayName: string };
    organizations: Array<{ id: string; isPersonal: boolean }>;
  };

  const personal = body.organizations.find((org) => org.isPersonal) ?? body.organizations[0];
  if (!personal) throw new Error('This account has no workspace.');

  return {
    userId: body.user.id,
    email: body.user.email,
    displayName: body.user.displayName,
    organizationId: personal.id,
  };
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${API_ORIGIN}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  const text = await response.text();
  const parsed = (text ? JSON.parse(text) : {}) as Record<string, unknown>;
  if (!response.ok) throw new Error(String(parsed['error'] ?? 'That did not work.'));
  return parsed as T;
}
