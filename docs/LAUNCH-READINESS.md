# Launch readiness

Sprints 39 and 40 ask for a production readiness review, support processes and a launch plan. This
is that review, and its most useful column is the last one.

**The distinction this document is organised around is _verified_ versus _configured_.** A thing
that is configured has been written down and looks right. A thing that is verified has been run, and
somebody watched the result. Most launch incidents are configured things that were never verified,
so they are separated here rather than listed together.

---

## 1. What is verified

Each of these has been executed and the result observed, in this environment.

| Area                             | What was proved                                                                                                                                                                                                                       | How to re-prove it                              |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| **Backup and restore**           | A 448-project, 858-version database backed up, restored into a scratch database, and compared: row counts, a content digest and all 125 constraints identical. A truncated archive was refused before the restore touched the target. | `SOURCE_URL=… ops/backup/verify.sh`             |
| **API under load**               | One process meets all four latency targets at 50 concurrent editing sessions; misses autosave at 100, where throughput goes flat at ~130/s — a saturated process, not a slow query.                                                   | `pnpm load`                                     |
| **Collaboration server**         | Under 1% of a core at 50 editors in one room; an edit reaches a peer in 1–5 ms.                                                                                                                                                       | `pnpm load:collab`                              |
| **Editor bundle**                | 314 KiB of initial JavaScript against a 400 KiB budget, enforced in CI.                                                                                                                                                               | `pnpm budget`                                   |
| **Cache headers**                | Content-addressed assets answer `immutable` on GET _and_ HEAD, checked against a running origin.                                                                                                                                      | `pnpm headers`                                  |
| **Accessibility**                | No serious or critical axe violations on the projects screen, the editor or the populated inspector; every control shows a focus ring; a project can be opened by keyboard alone.                                                     | `playwright test a11y`                          |
| **Export integrity**             | Every export passes a headless release gate before it can be downloaded.                                                                                                                                                              | `pnpm smoke <folder>`                           |
| **Engine memory**                | Deterministic leak tests over twenty load/dispose cycles; per-object resources freed on delete.                                                                                                                                       | `pnpm --filter @helaengine/engine test`         |
| **Attribution**                  | Every one of 499 shipped assets carries a licence, an author and an origin; enforced by a test that fails when one does not.                                                                                                          | `pnpm --filter @helaengine/asset-pipeline test` |
| **Cross-organisation isolation** | An integration test per endpoint, against real Postgres.                                                                                                                                                                              | `pnpm --filter @helaengine/api test`            |

---

## 2. What is configured but **not** verified

These would be reported as done by a checklist. They are not done.

| Area                  | What exists                                                                                                     | What has never happened                                                                                                                    |
| --------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| **Dashboards**        | `ops/grafana/helaengine-overview.json`, written against metric names that tests assert exist.                   | Never loaded into a running Grafana. No panel has ever rendered.                                                                           |
| **Alert rules**       | `ops/prometheus/alerts.yml`, with severities.                                                                   | Never loaded into a Prometheus. No alert has ever fired.                                                                                   |
| **Alert delivery**    | Severities are labelled `page` and `ticket`.                                                                    | Nothing is wired to PagerDuty, Slack or email. A firing alert would reach nobody.                                                          |
| **Log shipping**      | Structured JSON on stdout, which every shipper expects.                                                         | Nothing ships them.                                                                                                                        |
| **Stripe**            | `StripeBilling` implements the provider port; signature verification is tested against locally-signed payloads. | **It has never contacted Stripe.** No account, no live mode, no webhook endpoint, no real payment.                                         |
| **Backup scheduling** | Scripts exist and the loop is proved.                                                                           | Nothing runs them on a schedule; there is no host to schedule them on. No off-site copy, no encryption at rest, no point-in-time recovery. |
| **Staging**           | —                                                                                                               | There is none. Every number in this repository was measured on one container over loopback.                                                |

**Sprint 40's definition of done cannot be met from here.** It requires public sign-ups open, a real
payment through Stripe live mode, and active dashboards on a production environment. Three of those
need accounts and a deployment target that do not exist in this environment. What is listed in
section 1 is what could be proved without them.

---

## 3. Plan limits against observed reality

Sprint 39 asks to sanity-check the Sprint 35 tiers against real usage. There is no beta usage, but
there are real measurements, and two of them move the answer.

**A scene document is much smaller than expected.** A 500-object level — a large one — stores as
**8.4 KB** in `jsonb`. A user would need roughly 60,000 such saves to reach the Free tier's 0.5 GB.
Project storage is therefore not what the storage limit is about, and never will be; it is about
uploaded models. Worth knowing before somebody "optimises" scene storage.

**Uploaded models vary by two orders of magnitude.** The Kenney models now in the library average
about 7 KB; a detailed model from a commercial pack is 5–25 MB. So Free's 0.5 GB is somewhere
between 20 and 70,000 uploads depending entirely on where a user's assets come from — which means
the limit will feel arbitrary and different to every user who hits it. **This is the tier limit most
likely to need changing after real usage**, and the funnel will show it: a spike of `402` responses
on upload against a flat export rate says the storage tier is wrong, not the pricing.

**Export counts look right and are untested.** Free gets 5 exports a month. An export is a few
minutes of worker time, so the number is a cost control rather than a value metric; nothing observed
here contradicts it, and nothing confirms it either.

**Recommendation:** ship the tiers as they are and treat storage as the one to revisit first. Do not
change any of them on the strength of this document — it has no users in it.

---

## 4. Support: SLA expectations and escalation

Written so there is something to point at, not because a support organisation exists.

| Tier       | First response                | Channel                    |
| ---------- | ----------------------------- | -------------------------- |
| Free       | Best effort, no commitment    | Public issue tracker       |
| Pro        | 2 working days                | Email                      |
| Studio     | 1 working day                 | Email, named contact       |
| Enterprise | 4 working hours for a blocker | Email and a shared channel |

**Severity, and what it means for who gets woken:**

- **S1 — nobody can use it.** Sign-in down, the editor fails to load, saves are failing. Page
  immediately. Roll back first, diagnose second.
- **S2 — a core flow is broken for some people.** Export failing for one plan, collaboration not
  connecting. Ticket, same working day.
- **S3 — degraded but usable.** Slow saves, a panel that throws behind an error boundary. Next
  working day.
- **S4 — cosmetic or a single user's data question.** Normal queue.

**Escalation path:** on call → engineering lead → whoever owns the affected service. For anything
touching customer data or billing, the person who notices writes it down before fixing it, because
the reconstruction afterwards is always harder than the note would have been.

**Every report starts with a correlation id.** Ask for it — it is in the `x-correlation-id` header
of any API response and in the editor's error report — then run `pnpm trace <id>` and you have the
whole path across every service before you have finished reading the ticket.

---

## 5. Launch-day plan

Assuming the section 2 gaps are closed first; if they are not, this plan is fiction.

**Before opening sign-ups**

1. Dashboards loaded and rendering real data, watched by a person for a full day of pre-launch
   traffic. A panel first seen on launch day is a panel nobody can read.
2. One alert deliberately fired end to end, to prove delivery. An untested alert route is the
   commonest cause of a silent incident.
3. `ops/backup/verify.sh` run against production, green, and scheduled.
4. A real payment through Stripe live mode, and a real refund. The refund matters: it is the path
   nobody tests and the first one a launch-day mistake needs.
5. The rollback rehearsed. Not documented — rehearsed, with a stopwatch.

**During the window**

- One named person watching dashboards, not everybody watching occasionally.
- The funnel checked hourly rather than daily. `biggestDropOff` answers "where are people stopping"
  directly, and on launch day the answer changes.
- A status page updated on a schedule even when nothing is wrong, because silence during an incident
  reads as absence.

**Rollback triggers, decided in advance so nobody has to argue at the time**

- Error rate above 2% of requests for five minutes.
- Autosave p95 above 2 seconds — that is data loss with extra steps.
- Any failure that loses or corrupts a saved project. This one is immediate and unconditional.

**After**

Run the funnel review weekly, and keep a running list of the top friction points. The first
post-launch roadmap should come from that list rather than from opinion — which is the whole reason
the funnel was instrumented before there was anybody in it.
