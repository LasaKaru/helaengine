import { useEffect, useState } from 'react';
import { useProjectStore } from '../store/projectStore';
import { apiConfigured, restore, signIn, signOut, signUp, type SignedIn } from '../storage/session';

/**
 * Sign in, or do not.
 *
 * Only rendered when an API is configured, because the editor works perfectly well without one and
 * an account form on a tool that needs no account is a wall in front of a door. When there is an
 * API, this is what turns "projects in this browser" into "projects in your account" — and it says
 * which of the two you are in, because that is the difference between work that survives a laptop
 * and work that does not.
 */
export function AccountBar(): React.JSX.Element | null {
  const refreshProjects = useProjectStore((state) => state.refreshProjects);

  const [who, setWho] = useState<SignedIn | null>(null);
  const [mode, setMode] = useState<'in' | 'up'>('in');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    // A session from a previous visit, verified against the API rather than trusted.
    void restore().then(async (found) => {
      if (!found) return;
      setWho(found);
      await refreshProjects();
    });
  }, [refreshProjects]);

  if (!apiConfigured()) return null;

  const submit = async (): Promise<void> => {
    setBusy(true);
    setError('');
    try {
      const found =
        mode === 'up'
          ? await signUp({ email, password, displayName })
          : await signIn({ email, password });
      setWho(found);
      setPassword('');
      await refreshProjects();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  const leave = async (): Promise<void> => {
    signOut();
    setWho(null);
    // The list has to change too. Leaving somebody's cloud projects on screen after they sign out
    // would be showing them something they can no longer load.
    await refreshProjects();
  };

  if (who) {
    return (
      <div className="account-bar" role="status">
        <span>
          Signed in as <strong>{who.displayName}</strong>. Projects are saved to your account, with
          a version for every save.
        </span>
        <button type="button" onClick={() => void leave()}>
          Sign out
        </button>
      </div>
    );
  }

  return (
    <div className="account-bar">
      <span>
        Projects are stored in this browser. Sign in to keep them in your account and get version
        history.
      </span>
      <div className="account-form">
        {mode === 'up' && (
          <input
            type="text"
            aria-label="Display name"
            placeholder="Your name"
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
          />
        )}
        <input
          type="email"
          aria-label="Email"
          placeholder="you@example.com"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
        <input
          type="password"
          aria-label="Password"
          placeholder="Password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
        <button type="button" className="primary" disabled={busy} onClick={() => void submit()}>
          {busy ? 'Working…' : mode === 'up' ? 'Create account' : 'Sign in'}
        </button>
        <button type="button" onClick={() => setMode(mode === 'up' ? 'in' : 'up')}>
          {mode === 'up' ? 'I have an account' : 'Create an account'}
        </button>
      </div>
      {error && (
        <p className="panel-hint error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
