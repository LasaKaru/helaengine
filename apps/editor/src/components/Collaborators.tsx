import type { Peer } from '../collab/session';

/**
 * Who else is in this room.
 *
 * Initials in coloured circles rather than names in a list, because the top bar has a fixed width
 * and a room of five people would push the save state off the edge. The colour is the same one
 * their selection highlight is drawn in, which is what makes "that orange box is Lin's" legible
 * without a legend.
 */

function initials(displayName: string): string {
  const parts = displayName.trim().split(/\s+/).slice(0, 2);
  return parts.map((part) => part[0]?.toUpperCase() ?? '').join('') || '?';
}

export function Collaborators({ peers }: { peers: Peer[] }): React.JSX.Element {
  return (
    <div className="collaborators" role="group" aria-label="Collaborators">
      {peers.map((peer) => (
        <span
          key={peer.clientId}
          className={`collaborator${peer.editing ? ' editing' : ''}`}
          style={{ background: peer.color }}
          // The accessible name carries what the colour cannot, so a screen reader gets the same
          // information a sighted user reads off the ring.
          title={peer.editing ? `${peer.displayName} is editing` : peer.displayName}
          aria-label={peer.editing ? `${peer.displayName} is editing` : peer.displayName}
          data-user-id={peer.userId}
        >
          {initials(peer.displayName)}
        </span>
      ))}
    </div>
  );
}
