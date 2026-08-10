---
name: release-gate
description: "Use before committing anything in HelaEngine, and when a check fails for a reason that may not be your change. Gives the command order, the container's two recurring environment failures (Postgres/Redis dying, CHROMIUM_PATH unset), and how to tell an environment failure from a regression. Triggers: 'run the tests', 'is it green', 'ready to commit', a failing e2e or export-worker run."
---

# The release gate

## Order

```
pnpm format        # first — lint fails on formatting otherwise
pnpm lint
pnpm typecheck
pnpm test
pnpm smoke:test    # real exports, played headless. ~2 minutes.
```

`smoke:test` needs `CHROMIUM_PATH` (below). Run it whenever the scene schema, the engine or the
exporter changed — it is the check that catches "the export no longer plays".

## End-to-end

```
CHROMIUM_PATH=/opt/pw-browsers/chromium pnpm --filter @helaengine/editor exec \
  playwright test <spec> --project=chromium --reporter=line
```

Always name the spec and the project while iterating. The full suite across three browsers takes
well over an hour.

## The container's two recurring failures

Neither is ever a regression in your change. Check both before investigating.

### Postgres and Redis die

Symptom: the Playwright web server exits with `ECONNREFUSED 127.0.0.1:5433`.

```
PGBIN=$(ls -d /usr/lib/postgresql/*/bin | head -1)
"$PGBIN/pg_isready" -h 127.0.0.1 -p 5433 ||
  su postgres -c "$PGBIN/pg_ctl -D /tmp/hela-pg -o '-p 5433 -k /tmp' -l /tmp/pg.log start"
redis-cli ping || redis-server --daemonize yes --port 6379 --save '' --appendonly no
```

### `CHROMIUM_PATH` is unset

Symptom: a box-drawn message telling you to run `playwright install`. The pre-installed Chromium
build does not match the one Playwright expects. **Never run `playwright install`** — set the
variable. The asset ingest fails the same way and takes the same fix.

## Telling an environment failure from a regression

`@helaengine/export-worker` failing on queue timing (`expected 2 to be 1`, `job never finished`) is
almost always Redis contention with a running e2e suite, not your change.

**Confirm rather than assume.** Stash and re-run:

```
git stash && pnpm --filter @helaengine/export-worker test; git stash pop
```

Identical failures on a clean tree means it is the environment. A shifting set of failures between
two runs of the same suite is the same signal.

## Known-red, not yours

`e2e/export-qa.spec.ts` → `export visual regression` has been failing in CI since before this work.
It is tracked separately. Do not treat it as caused by your change, and do not silently accept a
_new_ failure in that file either — check the test name.

## Committing

Only after all five are green, plus the e2e specs your change touches. If something is red for a
reason you have not resolved, say so plainly in the report rather than committing around it.
