/**
 * The HelaEngine mark: a ring, an H, and a pulse running through it.
 *
 * Drawn as SVG rather than shipped as a PNG, and the reason is not fussiness. The mark appears at
 * 20 pixels in the header and at 200 in the opener, and a raster asset has to be either blurry at
 * one of those or two files that can drift apart. It also has to answer to the theme: `currentColor`
 * means one mark works on the dark editor chrome and on a light splash without a second export.
 *
 * It is a redrawing of the supplied logo rather than that file itself. The proportions are matched
 * by eye — the ring's weight, the chamfered uprights, where the pulse crosses the bar — and if an
 * exact match to the original raster matters more than scaling does, drop the `.svg` export in
 * beside this and swap the body out. Everything else here stays the same.
 */
export function BrandMark({
  size = 24,
  title,
}: {
  size?: number;
  /** Given only where the mark stands alone. Beside the wordmark it is decoration and stays silent. */
  title?: string;
}): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      role={title ? 'img' : 'presentation'}
      aria-label={title}
      aria-hidden={title ? undefined : true}
    >
      {/* The ring. Stroked rather than two filled circles, so the weight scales with the mark. */}
      <circle cx="50" cy="50" r="43" stroke="currentColor" strokeWidth="7" />

      {/*
        The uprights, chamfered at the outer top and bottom corners so they lean into the ring
        rather than butting against it. Each is a single path: a rectangle with two corners cut.
      */}
      <path d="M26 30 L38 24 L38 46 L26 46 Z" fill="currentColor" />
      <path d="M26 54 L38 54 L38 76 L26 70 Z" fill="currentColor" />
      <path d="M62 24 L74 30 L74 46 L62 46 Z" fill="currentColor" />
      <path d="M62 54 L74 54 L74 70 L62 76 Z" fill="currentColor" />

      {/*
        The crossbar and the pulse, one stroke.

        One path rather than a bar plus a separate zigzag, because they are the same line: it runs
        in from the left, spikes up and down between the uprights, and runs out to the right. Two
        paths would need their joins to agree, and at 20 pixels a disagreement of half a pixel is a
        visible notch.
      */}
      <path
        d="M28 50 H40 L46 26 L54 74 L60 50 H72"
        stroke="currentColor"
        strokeWidth="7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
