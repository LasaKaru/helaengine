import { useEffect, useState } from 'react';
import { BrandMark } from './BrandMark';

/**
 * The opening ident: the mark drawing itself, once, before the editor appears.
 *
 * ## It covers work rather than adding a wait
 *
 * This is the whole design constraint. A splash that *delays* the application is a splash people
 * resent, and rightly — it is a toll on every reload. This one sits over an editor that is already
 * mounting behind it: the asset manifest is fetching, the scene loader is being built, IndexedDB is
 * opening. By the time it clears, work that had to happen anyway has happened.
 *
 * So it is capped at a bit over a second, and it is skippable by any key or click. Both matter. An
 * ident that cannot be skipped is one somebody meets for the fortieth time on the fortieth reload.
 *
 * ## Once per session, not once per render
 *
 * Held in `sessionStorage` rather than in state, because state resets on a route change and a splash
 * that reappears when you close a project is a bug that looks like a feature. `sessionStorage` and
 * not `localStorage`: coming back tomorrow should show it again — that is what an ident is for — but
 * five navigations in one sitting should not.
 *
 * ## The animation is the mark, not a video
 *
 * The pulse is a single stroke, so it can be drawn with `stroke-dashoffset` running from its full
 * length to zero: the line appears to be traced left to right. The ring fades and scales in behind
 * it. No asset to download, no codec, no second file to keep in step with the header's mark — it is
 * the same component at a different size.
 */

/** How long the whole thing lasts, animation included. */
const DURATION_MS = 1400;

const SEEN_KEY = 'helaengine.ident.seen';

/**
 * Whether the ident should play at all.
 *
 * Read once, synchronously, during the first render rather than in an effect. An effect would let
 * one frame of the editor paint before the cover appeared, which is a flash of the thing the ident
 * exists to introduce.
 */
function shouldPlay(): boolean {
  const query = new URLSearchParams(window.location.search);
  if (query.has('noident')) return false;
  // `?ident` forces it, which is how the ident's own test sees it and how anybody checks the
  // animation without clearing storage first.
  if (query.has('ident')) return true;

  /**
   * Never for an automated browser, unless it asked.
   *
   * Otherwise every one of the sixty-odd browser specs pays a second and a half and has its first
   * click swallowed by a full-screen cover — and a suite that is slower and flakier is one people
   * stop running locally, which costs far more than an ident is worth. Checked here rather than by
   * threading a query parameter through every `page.goto` in the repository.
   */
  if (navigator.webdriver) return false;

  try {
    return window.sessionStorage.getItem(SEEN_KEY) === null;
  } catch {
    // Private browsing can throw on storage access. An ident that crashes the editor rather than
    // playing twice is the wrong way round.
    return false;
  }
}

export function OpeningIdent(): React.JSX.Element | null {
  const [playing, setPlaying] = useState(shouldPlay);

  useEffect(() => {
    if (!playing) return;

    try {
      window.sessionStorage.setItem(SEEN_KEY, '1');
    } catch {
      // Nothing to do: worst case it plays again next navigation, which is not worth a crash.
    }

    const finish = (): void => setPlaying(false);
    const timer = window.setTimeout(finish, DURATION_MS);
    // Any key, any click. Nobody should have to find a Skip button they have already read once.
    window.addEventListener('keydown', finish);
    window.addEventListener('pointerdown', finish);

    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('keydown', finish);
      window.removeEventListener('pointerdown', finish);
    };
  }, [playing]);

  if (!playing) return null;

  return (
    <div className="ident" role="presentation" data-testid="opening-ident">
      <div className="ident-mark">
        <BrandMark size={160} />
      </div>
      <p className="ident-name">HelaEngine</p>
    </div>
  );
}
