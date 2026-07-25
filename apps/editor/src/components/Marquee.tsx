import { useEditorStore } from '../store/editorStore';

/** The rubber-band rectangle drawn while box-selecting. */
export function MarqueeOverlay(): React.JSX.Element | null {
  const marquee = useEditorStore((state) => state.marquee);
  if (!marquee) return null;

  const left = Math.min(marquee.x1, marquee.x2);
  const top = Math.min(marquee.y1, marquee.y2);

  return (
    <div
      className="marquee"
      data-testid="marquee"
      style={{
        left,
        top,
        width: Math.abs(marquee.x2 - marquee.x1),
        height: Math.abs(marquee.y2 - marquee.y1),
      }}
    />
  );
}
