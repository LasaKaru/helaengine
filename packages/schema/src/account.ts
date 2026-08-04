import { z } from 'zod';

/**
 * Accounts, organisations and who may do what.
 *
 * In the schema package with everything else, so the API validates a request with the same
 * definitions the editor will use to render a members list. One contract, checked at both ends.
 */

/**
 * What a member may do, most powerful first.
 *
 * `enterprise_admin` exists before anything uses it, on purpose and on the plan's own advice: SSO
 * and cross-organisation administration are coming, and adding an enum value now costs nothing
 * while adding one later costs a migration over live membership rows. It is deliberately *above*
 * owner — an owner owns one organisation, an enterprise admin answers for several.
 */
export const RoleSchema = z.enum(['enterprise_admin', 'owner', 'admin', 'editor', 'viewer']);
export type Role = z.infer<typeof RoleSchema>;

/**
 * Roles as a ladder.
 *
 * A number rather than a set of allowed actions, because every permission this product has so far
 * is genuinely ordered — an admin can do everything an editor can. The day that stops being true,
 * this becomes a capability table and the guard changes shape; until then, pretending otherwise
 * would be building a permissions engine for one straight line.
 */
export const ROLE_RANK: Record<Role, number> = {
  enterprise_admin: 40,
  owner: 30,
  admin: 20,
  editor: 10,
  viewer: 0,
};

export function roleAtLeast(held: Role, required: Role): boolean {
  return ROLE_RANK[held] >= ROLE_RANK[required];
}

export const UserSchema = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  displayName: z.string().min(1).max(120),
  createdAt: z.string(),
});
export type User = z.infer<typeof UserSchema>;

export const OrganizationSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(120),
  /**
   * True for the workspace created automatically at signup.
   *
   * Marked rather than inferred, because "you cannot leave your own personal workspace" is a rule
   * the API enforces, and inferring it from membership counts would make that rule accidental.
   */
  isPersonal: z.boolean(),
  createdAt: z.string(),
});
export type Organization = z.infer<typeof OrganizationSchema>;

export const MembershipSchema = z.object({
  organizationId: z.string().uuid(),
  userId: z.string().uuid(),
  role: RoleSchema,
  createdAt: z.string(),
});
export type Membership = z.infer<typeof MembershipSchema>;

export const SignupRequestSchema = z.object({
  email: z.string().email(),
  // Length only. Composition rules push people towards `Password1!` and are worse than a longer
  // minimum; the real defence is the hash and the rate limit, not the punctuation.
  password: z.string().min(10).max(200),
  displayName: z.string().min(1).max(120),
});
export type SignupRequest = z.infer<typeof SignupRequestSchema>;

export const LoginRequestSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1).max(200),
});
export type LoginRequest = z.infer<typeof LoginRequestSchema>;

export const InviteRequestSchema = z.object({
  email: z.string().email(),
  role: RoleSchema,
});
export type InviteRequest = z.infer<typeof InviteRequestSchema>;

export const InviteSchema = z.object({
  id: z.string().uuid(),
  organizationId: z.string().uuid(),
  email: z.string().email(),
  role: RoleSchema,
  /** Present only in the response to the person who created it. Never listed afterwards. */
  token: z.string().optional(),
  acceptedAt: z.string().nullable(),
  expiresAt: z.string(),
  createdAt: z.string(),
});
export type Invite = z.infer<typeof InviteSchema>;

export const SessionSchema = z.object({
  token: z.string(),
  user: UserSchema,
  expiresAt: z.string(),
});
export type Session = z.infer<typeof SessionSchema>;
