import { currentCorrelationId, type Logger } from '@helaengine/telemetry';
import type { Db } from './db.js';

/**
 * The audit trail.
 *
 * Ten actions, and the list is closed on purpose — in the schema (a `check` constraint) as well as
 * here. An audit log's only real value is that a row written today still means the same thing when
 * somebody reads it after an incident, and a free-text action column becomes six spellings of
 * "delete" inside a year.
 *
 * What is *not* here is as deliberate. Scene edits are already versioned in `scene_versions`, and
 * copying every autosave into this table would bury the handful of events anybody reviews under
 * thousands that are already recorded elsewhere. The rule applied was: membership, access,
 * deletion, and money-adjacent actions — the things a customer's security team asks about.
 */

export const AUDIT_ACTIONS = [
  'member.invited',
  'member.joined',
  'member.role_changed',
  'member.removed',
  'project.created',
  'project.deleted',
  'project.restored',
  'asset.deleted',
  'export.requested',
  'export.downloaded',
  // No actor on these: the provider is talking, not a person (Sprint 35).
  'billing.changed',
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export interface AuditEntry {
  organizationId: string;
  action: AuditAction;
  /** Who did it. Null for an unauthenticated action, such as accepting an invite before signing up. */
  actorUserId?: string | null;
  /** What it was done to: a project, asset, job or user id. */
  subject?: string | null;
  /** Detail that makes the entry answerable. Never credentials, never a scene document. */
  detail?: Record<string, unknown>;
}

/**
 * Writes one entry.
 *
 * **Never throws.** That is the interesting decision, and it cuts against instinct: surely a failed
 * audit write should fail the request? Not here. The alternative — a database hiccup in this table
 * turning a member removal into a 500 *after* the removal has already committed — leaves the system
 * in a worse state than a missing row, and leaves the user with no idea whether their action took.
 * So the write is best-effort and a failure is logged loudly, which is the same trade the export
 * worker makes when it cannot record a failure.
 *
 * If a future compliance regime demands that no action may proceed unaudited, the honest
 * implementation is to write the entry in the *same transaction* as the action rather than to make
 * this one throw. That is a bigger change than it looks — every call site would have to pass its
 * client — which is why it is written down rather than half-done.
 */
export async function audit(db: Db, entry: AuditEntry, log?: Logger): Promise<void> {
  try {
    await db.query(
      `insert into audit_log
         (organization_id, actor_user_id, action, subject, detail, correlation_id)
       values ($1, $2, $3, $4, $5::jsonb, $6)`,
      [
        entry.organizationId,
        entry.actorUserId ?? null,
        entry.action,
        entry.subject ?? null,
        JSON.stringify(entry.detail ?? {}),
        // Sprint 33's id, so an audit entry can be turned back into the request that produced it.
        currentCorrelationId(),
      ],
    );
  } catch (error) {
    log?.error('could not write an audit entry', { action: entry.action, error });
  }
}

export interface AuditRecord {
  id: string;
  organizationId: string;
  actorUserId: string | null;
  action: AuditAction;
  subject: string | null;
  detail: Record<string, unknown>;
  correlationId: string | null;
  createdAt: string;
}

/** An organisation's trail, newest first. Read by admins and by whoever answers the questionnaire. */
export async function listAudit(
  db: Db,
  organizationId: string,
  limit = 100,
): Promise<AuditRecord[]> {
  const found = await db.query<{
    id: string;
    organization_id: string;
    actor_user_id: string | null;
    action: AuditAction;
    subject: string | null;
    detail: Record<string, unknown>;
    correlation_id: string | null;
    created_at: Date;
  }>(
    `select id::text, organization_id, actor_user_id, action, subject, detail, correlation_id,
            created_at
       from audit_log
      where organization_id = $1
      order by created_at desc, id desc
      limit $2`,
    [organizationId, Math.min(limit, 500)],
  );

  return found.rows.map((row) => ({
    id: row.id,
    organizationId: row.organization_id,
    actorUserId: row.actor_user_id,
    action: row.action,
    subject: row.subject,
    detail: row.detail,
    correlationId: row.correlation_id,
    createdAt: row.created_at.toISOString(),
  }));
}
