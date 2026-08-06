import { z } from 'zod';

/**
 * The funnel, as a closed vocabulary.
 *
 * The plan asks for event tracking on "signup → first project created → first object placed → first
 * save → first export" so drop-off can be found quantitatively. The events are enumerated here, in
 * the schema, for the same reason every other vocabulary in this project is: an analytics call with
 * a free-text event name is a call nobody can typo-check, and a funnel assembled from
 * `first_object_placed` and `firstObjectPlaced` is a funnel with a hole in it that looks like a
 * drop-off. Six months later somebody concludes users abandon at placement, and the truth is a
 * rename.
 *
 * These are **product milestones, not page views**. There is deliberately no `page_viewed` and no
 * generic `button_clicked`: this is a funnel, and a funnel that also carries everything else stops
 * being one.
 */
export const FunnelEventSchema = z.enum([
  /** An account exists. The top of the funnel and the only one the API raises. */
  'signup',
  /** A project exists — from a template or an import. Not the same as "opened the editor". */
  'project_created',
  /** Something is in the scene. The first moment the product has done anything for them. */
  'object_placed',
  /** The work is somewhere it will survive a closed tab. */
  'project_saved',
  /** An export was *requested*. Completion is a separate event, because the gap between them is
   *  where a build failure hides. */
  'export_started',
  /** An export finished and is downloadable. The bottom of the funnel. */
  'export_completed',
]);
export type FunnelEvent = z.infer<typeof FunnelEventSchema>;

/**
 * What may travel with an event.
 *
 * Deliberately narrow, and it is a privacy decision rather than a schema convenience. No project
 * names, no asset ids, no scene contents, no email — a funnel needs to know *that* somebody placed
 * an object, never *what* they placed, and an analytics pipeline that has the second will one day
 * be asked to give it back. Counts and durations answer every drop-off question worth asking.
 */
export const FunnelPropertiesSchema = z
  .object({
    /** How many objects the scene held at the time. For "do people place one and stop?". */
    objectCount: z.number().int().nonnegative().max(1_000_000).optional(),
    /** Milliseconds since the session started, for time-to-first-value. */
    sinceSessionStartMs: z.number().int().nonnegative().optional(),
    /** Which template they began from, so a confusing starting point is visible. */
    templateId: z.string().max(64).optional(),
    /** `static` or `game`. Nothing about the scene itself. */
    exportMode: z.enum(['static', 'game']).optional(),
    /** Present on `export_completed` only. */
    outcome: z.enum(['succeeded', 'failed']).optional(),
  })
  .strict();
export type FunnelProperties = z.infer<typeof FunnelPropertiesSchema>;

export const FunnelRecordSchema = z.object({
  event: FunnelEventSchema,
  /**
   * Who, as an opaque id rather than an account.
   *
   * A random per-browser id, not the user id and not an email. It answers "is this the same person
   * across these five steps", which is the only question a funnel asks, and it answers nothing
   * else — which is the point.
   */
  anonymousId: z.string().min(8).max(64),
  at: z.string().datetime(),
  properties: FunnelPropertiesSchema.default({}),
});
export type FunnelRecord = z.infer<typeof FunnelRecordSchema>;

export function parseFunnelRecord(input: unknown): FunnelRecord {
  return FunnelRecordSchema.parse(input);
}

/**
 * The order the funnel is meant to be walked in.
 *
 * Exported so a report can compute drop-off without re-deciding what "next step" means, and so a
 * test can assert the sequence rather than a screenshot of a dashboard.
 */
export const FUNNEL_ORDER: readonly FunnelEvent[] = [
  'signup',
  'project_created',
  'object_placed',
  'project_saved',
  'export_started',
  'export_completed',
] as const;

export interface FunnelStep {
  event: FunnelEvent;
  /** How many distinct people reached this step. */
  reached: number;
  /** Fraction of the previous step that got here. 1 for the first step. */
  conversion: number;
}

/**
 * Turns raw events into the drop-off table the plan actually asks for.
 *
 * Counted by *distinct person per step* rather than by event, because somebody who saves eleven
 * times is one person who saved, and counting events would show a save step wider than the create
 * step above it — a funnel that widens is a funnel nobody trusts.
 */
export function funnelFrom(records: readonly FunnelRecord[]): FunnelStep[] {
  const peopleByEvent = new Map<FunnelEvent, Set<string>>();
  for (const record of records) {
    const people = peopleByEvent.get(record.event) ?? new Set<string>();
    people.add(record.anonymousId);
    peopleByEvent.set(record.event, people);
  }

  let previous = 0;
  return FUNNEL_ORDER.map((event, index) => {
    const reached = peopleByEvent.get(event)?.size ?? 0;
    const conversion = index === 0 ? 1 : previous === 0 ? 0 : reached / previous;
    previous = reached;
    return { event, reached, conversion };
  });
}

/** The step with the steepest fall, which is the one question the plan's DoD asks. */
export function biggestDropOff(steps: readonly FunnelStep[]): FunnelStep | null {
  const candidates = steps.slice(1).filter((step) => step.conversion < 1);
  if (candidates.length === 0) return null;
  return candidates.reduce((worst, step) => (step.conversion < worst.conversion ? step : worst));
}
