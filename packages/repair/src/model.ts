import {
  RepairProposalSchema,
  REPAIR_OPS,
  type RepairProposal,
  type Scene,
} from '@helaengine/schema';
import type { RepairContext } from './context.js';

/**
 * Anything that can suggest a repair.
 *
 * A seam rather than a class hierarchy, because the two implementations are genuinely different
 * kinds of thing — one is arithmetic, one is a language model — and the loop must not be able to
 * tell them apart. Whatever a proposer returns is parsed by `RepairProposalSchema` before the loop
 * reads a single field of it, so a proposer cannot widen what a repair is allowed to do by being
 * clever, or by being compromised.
 */
export interface RepairModel {
  /** Shown in the audit log, so a record says who suggested what. */
  readonly name: string;
  /** Returns a proposal, or null when it has nothing to suggest. */
  propose(context: RepairContext, scene: Scene): Promise<unknown>;
}

/**
 * Parses whatever a proposer returned into a proposal, or explains why it will not.
 *
 * The only door between a proposer and the scene. It exists as its own function so that the same
 * validation runs for the rule-based proposer and the model one — a bug that only guards untrusted
 * input is a bug that stops guarding the moment somebody adds a second caller.
 */
export function validateProposal(
  value: unknown,
): { ok: true; proposal: RepairProposal } | { ok: false; reason: string } {
  const parsed = RepairProposalSchema.safeParse(value);
  if (!parsed.success) {
    const first = parsed.error.errors[0];
    return {
      ok: false,
      reason: first
        ? `${first.path.join('.') || 'proposal'}: ${first.message}`
        : 'the proposal did not match the repair schema',
    };
  }
  return { ok: true, proposal: parsed.data };
}

/**
 * The instructions given to a language-model proposer.
 *
 * Written as a constant rather than assembled inline so it can be read, reviewed and diffed. Note
 * what it does *not* do: it does not ask for code, a script, an expression, or a JSON path. It asks
 * for one of five named operations with typed fields, and the answer is thrown away if it is
 * anything else. The prompt is a convenience for getting a useful answer — the schema is what makes
 * a useless or hostile one harmless.
 */
export const REPAIR_SYSTEM_PROMPT = `You repair 3D scene documents for the HelaEngine editor.

A build failed an automated play-test. You will be given the failing check, what the test measured,
and the small part of the scene that is relevant. Propose exactly ONE change that would fix it.

Reply with JSON only, in this shape:
  { "patch": { "op": "<operation>", ... }, "reason": "<one sentence>", "fixes": "<check id>" }

The only operations that exist are: ${REPAIR_OPS.join(', ')}.
  setPlayerSpawn      { "spawn": [x, y, z] }
  setObjectPosition   { "objectId": "obj_0001", "position": [x, y, z] }
  setObjectCollider   { "objectId": "obj_0001", "collider": "auto|none|box|sphere|capsule|mesh" }
  clearObjectTrigger  { "objectId": "obj_0001" }
  removeObject        { "objectId": "obj_0001" }

Rules:
- Prefer the smallest change. removeObject destroys someone's work; use it last.
- Only name objects that appear in the candidates list.
- "reason" is shown to the person who built the scene. Write it for them, not for a developer.
- If nothing in this list would help, reply exactly: null`;

/** The user half of the prompt: the failure and the narrow slice of scene it concerns. */
export function buildRepairPrompt(context: RepairContext): string {
  return [
    `Failing check: ${context.failing}`,
    `What the test found: ${context.detail}`,
    `Measurements: ${JSON.stringify(context.evidence)}`,
    `Scene facts: ${JSON.stringify(context.facts)}`,
    `Candidate objects: ${JSON.stringify(context.candidates)}`,
  ].join('\n');
}

/**
 * How a language model is reached.
 *
 * One function, injected. `ModelRouter` from AI-PROTOTYPE-PLAN.md is the intended production
 * implementation and does not exist yet; a stub is what the tests use. Keeping the transport at
 * arm's length is also what makes "the schema rejects a hostile response" a thing that can be
 * *tested*, rather than asserted in a comment.
 */
export type ModelTransport = (system: string, user: string) => Promise<string>;

export class LlmRepairModel implements RepairModel {
  readonly name: string;
  readonly #transport: ModelTransport;

  constructor(transport: ModelTransport, name = 'llm') {
    this.#transport = transport;
    this.name = name;
  }

  async propose(context: RepairContext): Promise<unknown> {
    const reply = await this.#transport(REPAIR_SYSTEM_PROMPT, buildRepairPrompt(context));
    return extractJson(reply);
  }
}

/**
 * Pulls the JSON object out of a model reply.
 *
 * Models wrap JSON in prose and fences however much you ask them not to, and a proposal lost to a
 * stray ```json is a repair that silently never happens. This is lenient about the wrapper and not
 * lenient about the contents: whatever comes out still goes through `validateProposal`.
 */
export function extractJson(reply: string): unknown {
  const trimmed = reply.trim();
  if (trimmed === 'null' || trimmed === '') return null;

  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
  const candidate = fenced?.[1]?.trim() ?? trimmed;

  try {
    return JSON.parse(candidate);
  } catch {
    // A bare object somewhere in a sentence. Last resort, and still parsed rather than trusted.
    const braced = /\{[\s\S]*\}/.exec(candidate);
    if (!braced) return null;
    try {
      return JSON.parse(braced[0]);
    } catch {
      return null;
    }
  }
}
