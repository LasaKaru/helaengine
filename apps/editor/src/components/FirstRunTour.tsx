import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * The first-run tour.
 *
 * The plan's own instruction is the design brief: *"keep it skippable and short, most users tune out
 * long tours"*. So it is five steps, every one of which can be dismissed with Escape or the X, and
 * once dismissed it never returns — the flag is written the moment it is skipped, not when the tour
 * is completed, because a tour somebody escaped from and then met again on reload is worse than no
 * tour at all.
 *
 * It points at real elements rather than describing them. Each step names a selector; the tour
 * measures that element and puts the card beside it with a ring around it. A step whose element is
 * missing is **skipped rather than shown floating**, which matters because the panels differ between
 * a signed-in and a signed-out editor, and a tour that points at nothing teaches people to distrust
 * it.
 */

export const TOUR_SEEN_KEY = 'helaengine.tour.seen';

interface Step {
  /** What to ring. Missing elements are skipped, not shown detached. */
  target: string;
  title: string;
  body: string;
}

const STEPS: Step[] = [
  {
    target: '.panel-assets',
    title: 'Everything you can place',
    body: 'Search or filter by category, then drag a card into the view to place it. Hundreds of models are here — start typing to narrow them down.',
  },
  {
    target: '.viewport',
    title: 'Your level',
    body: 'Drag to orbit, scroll to zoom, right-drag to pan. Click an object to select it; press Delete to remove it.',
  },
  {
    target: '.panel-tree',
    title: 'What is in the scene',
    body: 'Every object you place appears here. Select one to edit it, or drag rows to nest one object under another.',
  },
  {
    target: '.rail-right',
    title: 'Position, rotation, and behaviour',
    body: 'With something selected, this is where you move it precisely, give it physics, or make it chase the player.',
  },
  {
    target: '.topbar-actions',
    title: 'Save, and ship it',
    body: 'Save keeps your project in this browser. Export builds a folder you can host anywhere — it is a real game, not a preview.',
  },
];

interface Placement {
  top: number;
  left: number;
  ring: { top: number; left: number; width: number; height: number };
}

/** Where the card goes, given the element it is describing. */
function placeBeside(rect: DOMRect): Placement {
  const margin = 12;
  const cardWidth = 300;
  const cardHeight = 160;

  // Prefer the right of the element, fall back to the left when there is no room — the asset panel
  // is on the left edge and the inspector on the right, so both cases really happen.
  const roomRight = window.innerWidth - rect.right;
  const left =
    roomRight > cardWidth + margin
      ? rect.right + margin
      : Math.max(margin, rect.left - cardWidth - margin);

  const top = Math.min(
    Math.max(margin, rect.top + rect.height / 2 - cardHeight / 2),
    Math.max(margin, window.innerHeight - cardHeight - margin),
  );

  return {
    top,
    left,
    ring: { top: rect.top, left: rect.left, width: rect.width, height: rect.height },
  };
}

export function FirstRunTour(): React.JSX.Element | null {
  const [index, setIndex] = useState(0);
  const [placement, setPlacement] = useState<Placement | null>(null);
  const [done, setDone] = useState(() => {
    try {
      return localStorage.getItem(TOUR_SEEN_KEY) === '1';
    } catch {
      // Private browsing, or storage disabled. Showing the tour every time is friendlier than
      // crashing the editor over a preference.
      return false;
    }
  });
  const cardRef = useRef<HTMLDivElement>(null);

  const finish = useCallback(() => {
    setDone(true);
    try {
      localStorage.setItem(TOUR_SEEN_KEY, '1');
    } catch {
      /* see above — a tour that cannot record itself is still a tour that should close */
    }
  }, []);

  // Steps whose element is not on screen are dropped, so the tour never rings empty space.
  const visible = STEPS.filter((step) => document.querySelector(step.target) !== null);
  const step = visible[index];

  useEffect(() => {
    if (done || !step) return;

    const measure = (): void => {
      const element = document.querySelector(step.target);
      setPlacement(element ? placeBeside(element.getBoundingClientRect()) : null);
    };

    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [done, step]);

  useEffect(() => {
    if (done) return;

    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        finish();
      }
    };

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [done, finish]);

  // Focus moves to the card as it appears, so a keyboard user is not left tabbing from wherever they
  // were to find the thing that just took over the screen.
  useEffect(() => {
    if (!done && placement) cardRef.current?.focus();
  }, [done, placement, index]);

  if (done || !step || !placement) return null;

  const last = index === visible.length - 1;

  return (
    <div className="tour" role="dialog" aria-modal="false" aria-labelledby="tour-title">
      {/*
        The ring is drawn as an outline on an empty div rather than as four dimming panels around
        the target. Four panels means four elements to keep in step during a resize, and any gap
        between them shows as a seam.
      */}
      <div
        className="tour-ring"
        aria-hidden="true"
        style={{
          top: placement.ring.top,
          left: placement.ring.left,
          width: placement.ring.width,
          height: placement.ring.height,
        }}
      />

      <div
        className="tour-card"
        ref={cardRef}
        tabIndex={-1}
        style={{ top: placement.top, left: placement.left }}
      >
        <p className="tour-step">
          {index + 1} of {visible.length}
        </p>
        <h2 id="tour-title">{step.title}</h2>
        <p>{step.body}</p>

        <div className="tour-actions">
          <button type="button" className="tour-skip" onClick={finish}>
            {last ? 'Close' : 'Skip tour'}
          </button>
          {!last && (
            <button type="button" onClick={() => setIndex((current) => current + 1)}>
              Next
            </button>
          )}
          {last && (
            <button type="button" onClick={finish}>
              Start building
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
