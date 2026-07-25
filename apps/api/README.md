# @helaengine/api — placeholder

Scaffolded in **Sprint 16** (NestJS + Postgres + Prisma).

Planned module layout, per `docs/DEVELOPMENT-PLAN.md` section 4:

```
src/modules/{auth,orgs,projects,assets,exports,billing,collab,audit}
src/common/{guards,interceptors,pipes}
```

The API will validate incoming scene documents with the very same `@helaengine/schema` package the
editor and engine use — one schema, validated at every boundary.
