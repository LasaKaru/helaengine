import { MapSchema, Schema, type } from '@colyseus/schema';

/**
 * One player, as the server sees them.
 *
 * Positions are the server's answer, not a client's claim: a client sends what it *wants* to do and
 * reads back where it actually ended up. That is the whole of "server-authoritative", and it is
 * what makes cheating a matter of writing a different server rather than a different client.
 *
 * Deliberately small. Every field here is broadcast to every player on every patch, so anything
 * that can be derived on the client — an animation state, a nameplate colour — should be.
 */
export class PlayerState extends Schema {
  @type('string') sessionId = '';
  @type('string') name = '';

  @type('number') x = 0;
  @type('number') y = 0;
  @type('number') z = 0;
  /** Heading in radians, the camera's Y euler — the same convention the whole engine uses. */
  @type('number') yaw = 0;

  @type('number') health = 100;
  @type('boolean') grounded = true;
  @type('boolean') crouched = false;
  /** Metres per second, so a remote avatar can bob or animate without the server sending a pose. */
  @type('number') speed = 0;

  /**
   * The last input sequence number this position accounts for.
   *
   * Not used by the co-op slice, which simply follows the server. It is here because it is the one
   * field client-side prediction cannot be added without, and adding a field to a schema later
   * means a protocol break for every deployed client.
   */
  @type('number') lastInputSeq = 0;
}

/**
 * The shared world.
 *
 * `destroyedObjectIds` is the co-op slice's entire notion of shared world state: an enemy one
 * player kills is dead for everybody. It is a list of ids rather than a full object mirror because
 * every client already has the scene document — the server only has to say what has *changed*
 * about it, and "these are gone" covers the cases co-op actually runs into.
 */
export class RoomState extends Schema {
  @type({ map: PlayerState }) players = new MapSchema<PlayerState>();
  /** Scene these players are in. A client whose document disagrees is refused at join. */
  @type('string') sceneId = '';
  /** Server ticks since the room opened, for debugging desync reports. */
  @type('number') tick = 0;
  @type(['string']) destroyedObjectIds: string[] = [];
}
