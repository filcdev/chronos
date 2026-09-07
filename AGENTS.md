# Filc Agent Guidance

## Repo Shape

- This is a Bun + Turborepo monorepo. Shared scripts live in [package.json](package.json), task wiring lives in [turbo.json](turbo.json), and lint rules live in [biome.jsonc](biome.jsonc).
- [apps/chronos](apps/chronos) is the Hono + Drizzle backend.
- [packages/api](packages/api) is the shared API contract package (`@filcdev/api`): zod wire schemas per domain, envelope/error types, permission constants, and a typed client factory consumed by Chronos and Iris alike. Future apps calling the Chronos API should depend on this package instead of the Chronos workspace.
- [apps/iris](apps/iris) is the React + Vite frontend.

## Graphify — Default Code Memory

- The repo knowledge graph in `graphify-out/` (`graph.json`, `GRAPH_REPORT.md`) is the **default memory for codebase facts** in this repository. Before answering questions about how code fits together ("how does X work?", "what calls Y?", "which files share Z?", cross-file data flow), query it first with `graphify query "<question>"` or consult `graphify-out/GRAPH_REPORT.md`; do not rely on memory of prior sessions.
- graphify is the authoritative store for code-structure knowledge. Do NOT duplicate durable code facts into the shared memory stack (memory graph, MEMORY.md, DECISIONS.md); persist those only when they are decisions/conventions, not structure.
- The graph stays fresh via the installed post-commit/post-checkout hooks (rebuild after commits, code-file changes only). After doc/image changes or a large refactor, refresh manually from the repo root: `graphify --update`. If a question touches recently-changed code and the graph looks stale, rebuild rather than answer from memory.
- `graphify-out/` is generated and git-ignored — never hand-edit it, never commit it.

## Commands

- Use `bun` only. Do not switch to `npm`, `pnpm`, or `yarn`.
- Run validation from the repo root in this order: `bun install` when dependencies change, `bun lint`, `bun typecheck`, `bun run build`.
- Do not use bare `bun build` from the repo root; the root build command is `bun run build`.
- No reliable repo-wide test command is documented. Do not invent one unless the task is explicitly about adding tests.
- Local Postgres is managed by the `pg-dispo` script (`pg-dispo start|stop|wipe`), not Docker Compose or devcontainers.

## Conventions

- Use the correct path alias for the app you are editing: `#...` in Chronos and `@/...` in Iris.
- Do not hand-edit generated files such as [apps/iris/src/route-tree.gen.ts](apps/iris/src/route-tree.gen.ts) or SQL files under [apps/chronos/src/database/migrations](apps/chronos/src/database/migrations).
- Backend commands that need auth or database configuration rely on [apps/chronos/.env.example](apps/chronos/.env.example).
- If a change crosses backend and frontend, keep the API contract and client usage aligned before finishing.
- Bun 1.4.0 ignores `[run] bun = true` from bunfig.toml when spawning package binaries. Scripts that need the Bun runtime (vite, drizzle-kit) must invoke them via `bun --bun <binary>`; see the `dev`, `build`, and `db:*` scripts.
- Every API error response carries a machine-readable `code` (`@filcdev/api/errors`): derived from the HTTP status unless a handler opts out via an explicit override. Throw through the helpers in Chronos' `#utils/http` (or `ApiHttpError` with `{ code }`) when the status default is ambiguous; clients receive it typed as `ErrorCode` on `ApiError`.

## Shared API Contracts (`@filcdev/api`)

- Wire schemas describing request bodies, path/query params, and hand-written response payloads belong in `packages/api/src/domains/<domain>...`. Chronos routes import them from `@filcdev/api/domains/<name>`; do not re-declare them locally.
- Schemas derived from Drizzle tables (`createSelectSchema(table)` and composites embedding those) stay in Chronos; the package must not import drizzle-orm or server code.
- Permission strings are canonical constants from `@filcdev/api/permissions`. Never inline `'resource:action'` literals in middleware or UI gating; they are also stored in the `roles` table, so renaming requires a data migration.
- Frontend API calls go through the typed client built in [apps/iris/src/utils/hc.ts](apps/iris/src/utils/hc.ts) (`createApiClient`) and unwrap envelopes via `unwrapResponse` (used by `useApiQuery`/`useApiMutation` in [apps/iris/src/utils/api.ts](apps/iris/src/utils/api.ts)), which throws a structured `ApiError` with `code`/`status`.

## Chronos Backend

### Routes

- Follow the feature route layout in [apps/chronos/src/routes](apps/chronos/src/routes): keep `_factory.ts`, `_router.ts`, and handler files together inside the feature folder.
- New handlers match patterns like [apps/chronos/src/routes/ping/index.ts](apps/chronos/src/routes/ping/index.ts): `factory.createHandlers(...)` with `describeRoute(...)` then shared middleware, then validators, then the final handler, plus OpenAPI metadata via `describeRoute(...)` and `filcExt(...)`.
- Register endpoints from the feature router, following [apps/chronos/src/routes/doorlock/_router.ts](apps/chronos/src/routes/doorlock/_router.ts), so new handlers are actually reachable.
- Reuse `requireAuthentication` and `requireAuthorization(permissions.<name>)` middleware instead of inline permission checks.
- Return the established success envelope (`ok()` helpers from `#utils/http`) and use `HTTPException` plus `StatusCodes` for error paths.
- Keep OpenAPI metadata complete enough for the endpoint to stay discoverable: tags, descriptions, and response documentation ship with the route change.

### Database Schema

- Change TypeScript schema sources under [apps/chronos/src/database/schema](apps/chronos/src/database/schema); never hand-edit generated SQL under migrations.
- Reuse shared column helpers like [apps/chronos/src/database/helpers.ts](apps/chronos/src/database/helpers.ts) instead of re-declaring timestamp columns.
- Follow the table style in [apps/chronos/src/database/schema/doorlock.ts](apps/chronos/src/database/schema/doorlock.ts): explicit foreign keys, intentional `onDelete` behavior, indexes/composite keys where relationships need them.
- After intentional schema changes, generate the migration with the `db:*` scripts in [apps/chronos/package.json](apps/chronos/package.json).
- If backend route or frontend form code depends on a changed shape, update those callers in the same change rather than leaving a contract mismatch.

## Iris Frontend

### General

- Keep user-facing text in `t(...)` and update both locale trees under [apps/iris/public/locales/en](apps/iris/public/locales/en) and [apps/iris/public/locales/hu](apps/iris/public/locales/hu).
- TanStack Form is the default form pattern: `useForm`, `useStore(form.store, selector)`, `<form.Field>{(field) => ...}</form.Field>` (see [apps/iris/src/components/doorlock/card-dialog.tsx](apps/iris/src/components/doorlock/card-dialog.tsx)).
- `form.reset(values)` takes raw values, not `{ values }`; `form.reset` and `form.setFieldValue` are not stable `useEffect` dependencies, so omit them from dependency arrays.
- Base UI dropdown wrappers use `onClick`, not Radix-style `onSelect`, unless the local component exposes a different API.
- [apps/iris/src/components/ui/chart.tsx](apps/iris/src/components/ui/chart.tsx) already owns `ResponsiveContainer`; do not wrap chart children in another one.
- Keep public timetable filter state in TanStack Router search params instead of duplicating it in unrelated local state.

### Data Flow

- Domain data access lives in hook modules at [apps/iris/src/hooks](apps/iris/src/hooks) (one file per domain, e.g. `substitutions.ts`): `use<X>` query hooks plus individual `useCreateX`/`useUpdateX`/`useDeleteX` mutation hooks. Hooks own the API call, translated success/error toasts, and invalidation of every affected query family. Mutation hooks accept `{ onSaved?: () => void }` for callers that need to react to success (e.g. closing a dialog).
- Routes contain no inline `parseResponse`/`useMutation` blocks; they consume the domain hooks and keep only UI state (sort, filters, dialog open/close, selection). Reference shape: [apps/iris/src/routes/_private/admin/timetable/substitutions.tsx](apps/iris/src/routes/_private/admin/timetable/substitutions.tsx).
- Always use centralized keys from [apps/iris/src/utils/query-keys.ts](apps/iris/src/utils/query-keys.ts); no inline array query keys for existing domains. Multi-parameter keys take a single object argument (e.g. `doorlock.logs({ deviceFilter, search, ... })`) so React Query partial matching works.
- Reuse [apps/iris/src/hooks/use-has-permission.ts](apps/iris/src/hooks/use-has-permission.ts) and existing permission guard components instead of duplicating permission logic in views.

### Dialogs And Forms

- Dialogs are self-contained: they call domain mutation hooks directly and close themselves via `onOpenChange(false)` from their `onSaved` callback. Do not pass payload-submit callbacks (`onSubmit`) into dialogs. Reference shape: [apps/iris/src/components/admin/substitution-dialog.tsx](apps/iris/src/components/admin/substitution-dialog.tsx).
- Follow the form idiom of [apps/iris/src/components/admin/user-dialog.tsx](apps/iris/src/components/admin/user-dialog.tsx): form near the top of the component, reactive slices via `useStore(form.store, selector)`, fields via `<form.Field>`. Plain `useState`+`onChange` forms are not acceptable for new or migrated code.
- Reuse validation schemas from [apps/iris/src/utils/form-schemas.ts](apps/iris/src/utils/form-schemas.ts) when available, or the shared domain contracts from `@filcdev/api` when validating against backend wire shapes. If a schema becomes shared by multiple dialogs, move it there instead of copying validation logic.
- Extend shared dialog prop types ([apps/iris/src/components/admin/admin.types.ts](apps/iris/src/components/admin/admin.types.ts), [apps/iris/src/components/doorlock/doorlock.types.ts](apps/iris/src/components/doorlock/doorlock.types.ts)) instead of defining near-duplicate props.


## Reuse And DRY

- Reuse existing helpers, types, schemas, and hooks before adding new ones. Check nearby feature folders first, then shared files: [apps/chronos/src/database/helpers.ts](apps/chronos/src/database/helpers.ts), [apps/iris/src/utils/query-keys.ts](apps/iris/src/utils/query-keys.ts), [packages/api/src/domains](packages/api/src/domains).
- When a second call site needs the same logic, extract or extend the existing abstraction instead of creating a parallel helper with a slightly different name.
- Keep abstractions local to the narrowest shared boundary that already exists. Do not create cross-app utilities for one feature-specific use.
- Prefer the smallest root-cause fix that matches neighboring code over broad rewrites or speculative cleanup.

## References

- Chronos scripts and package metadata: [apps/chronos/package.json](apps/chronos/package.json)
- Iris scripts and package metadata: [apps/iris/package.json](apps/iris/package.json)
