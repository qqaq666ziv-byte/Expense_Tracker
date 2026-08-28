# Finance v3 migrations and rollback

Migrations:

- `20260821103249_finance_v3_additive_schema.sql` — applied to production on 2026-08-24 after an independently stored PostgreSQL backup.
- `20260824023801_finance_resource_abuse_guards.sql` — applied to Production as part of the completed transfer release.
- `20260828013341_finance_account_transfers.sql` — additive first-class transfer table and capacity-guard extension, applied to Production as part of the completed transfer release.

The first migration preserves legacy financial rows and columns while expanding the schema and correcting legacy IDs to owner-scoped primary keys. The second migration changes no row values: it adds `NOT VALID` future-write text/numeric checks and a trigger-enforced per-owner row ceiling. The transfer migration creates one owner-scoped row per logical transfer, adds no backfill, and updates the server allocation-capacity calculation so included/excluded account boundaries agree with the client. The Git restore points are:

- tag: `checkpoint/20260821-180842-before-autonomous-build`
- SHA: `56df3f31d2a3c7b93954faef9c352859c8f1f3d5`
- resume tag: `checkpoint/20260823-105721-before-resume-interrupted-build`
- resume SHA: `ba3e5de15a83cf314c3a3a64a7fc3580fd625fee`
- release-gate tag: `checkpoint/20260824-101753-before-production-e2e-release-gate`
- release-gate SHA: `5fb688f32cdaa54d0734de6b28d1b59cbde6516f`
- final-release tag: `checkpoint/20260824-1158-before-v3-production-release`
- final-release SHA: `a1d3ebfd45f9a9f4fb7451ee6dc123bfe18ef643`

Git can restore application/migration source only. The verified external `roles.sql`, `schema.sql`, and `data.sql` backup is deliberately outside this repository and remains the database restore path for the first production migration.

## Required pre-deployment recovery point

Before applying any pending migration to a non-local database:

1. Create and independently verify a Supabase/PostgreSQL backup or PITR restore point. Git is not a database backup.
2. Record row counts for `transactions`, `goals`, `subscriptions`, and `budgets` without exporting private row contents into the repository.
3. Capture the current policy/grant definitions so a database restore can recover them exactly.
4. Run the migration on an isolated preview/staging database populated with sanitized representative fixtures.
5. Verify migrated entity counts, orphan checks, RLS owner isolation, recurrence uniqueness, server allocation-capacity rejection, parent-archive atomic pauses, the bidirectional legacy-goal/subscription mirrors, and the owner-scoped primary keys before production approval.
6. Confirm there are no unexpected incoming foreign keys to the four legacy tables. The migration intentionally aborts rather than dropping an unknown dependency.

For `finance_resource_abuse_guards`, the pre-release aggregate-only preflight recorded every guarded text/numeric field and each owner's table count. The 2026-08-24 production preflight found zero text or numeric violations in all currently non-empty finance tables and every owner below quota. For any future guard-related deployment, re-run the preflight immediately beforehand because production can change. A `NOT VALID` constraint preserves an existing violating row at creation time but rejects a later update to that row; if preflight ever reports a violation, stop and design a reviewed, data-preserving cleanup before applying a further guard change.

The completed transfer release applied `20260824023801_finance_resource_abuse_guards.sql` before `20260828013341_finance_account_transfers.sql`, released the transfer-capable frontend, and released the reviewed `finance-import-historical-transfer-batch` Edge Function. Its browser-facing handler verifies the user JWT and complete owner-scoped import/restore manifest, while the atomic database function is executable only by `service_role`; never expose that credential to a frontend. Production can therefore contain first-class `public.transfers` rows. For any future migration/function release, use isolated staging and verify that ordinary `authenticated` clients cannot execute the privileged RPC, transfer owner isolation, positive/distinct-account constraints, archived-account rejection for normal new endpoints, deterministic endpoint row locking, same-clock conflict rejection, tombstone retry, and all four included/excluded total-assets cases. Re-read remote metadata and take a fresh independently verified backup/PITR point before deployment.

The repository release document and the domains currently attached to the active Vercel project have a known topology discrepancy. It remains a separate release follow-up; do not change domains or aliases as part of the transfer database release.

## Code-only frontend rollback

Use one operational rule: **if any Production transfer row may exist, the
code-only rollback must be transfer-aware.** Unless an authoritative,
current aggregate check proves `public.transfers` is empty, treat transfer rows
as potentially present and deploy the emergency artifact built with:

```powershell
npm.cmd run build:transfer-read-only
```

For a hosted emergency build, set the deployment build command to
`npm.cmd run build:transfer-read-only` (or set
`VITE_TRANSFER_MUTATIONS_ENABLED=false` at build time). This artifact retains
schema-v4 local data, pulls and validates transfer rows and tombstones, and
includes transfer effects in account balances and total assets while blocking
transfer create/edit/delete. It does not require reversing additive database
migrations. Verify the served artifact against an existing transfer before
routing users to it, then diagnose and repair forward in a reviewed release.

### Historical pre-transfer frontend rollback (conditionally safe only)

The former v3 frontend/deployment rollback is historical. It may be considered
only when authoritative current evidence proves that `public.transfers` has no
Production rows and every schema-v4 local raw recovery payload is preserved.
Under that narrow condition, the historical reference was deployment
`dpl_6ejsiuY1gFcGne5F7U44kuUeFdWj`, built from main SHA
`5fcebebe4b924b94929a4e0c638437796ef2ef9c` and previously serving
`https://pure-finance-pi.vercel.app/`.

Never use that frontend when a Production transfer row may exist: it does not
pull `public.transfers` and omits transfer effects from balances and total
assets. Leave v3 tables/columns, owner-scoped legacy primary keys, tightened
RLS policies, and retained legacy columns in place; do not delete v3 records,
restore global `id` uniqueness, or broaden historical RLS policies merely to
roll back a frontend.

## Database rollback

If the first schema migration itself must be reversed, restore the independently verified pre-migration database backup/PITR point. This is the only supported exact reversal because the migration:

- replaces existing policies with strict owner policies;
- changes the four legacy primary keys from global `id` to `(user_id,id)` without changing row contents;
- creates deterministic allocations from legacy goal totals;
- may accept new v3-only account, category, adjustment, allocation, and recurring-rule records after deployment.

A destructive `DROP TABLE`/`DROP COLUMN` rollback is intentionally not provided. It could silently discard v3-only financial records or recreate obsolete broad policies. Any selective removal requires explicit approval, a fresh backup, proof that no v3-only rows exist, and a separately reviewed migration.

### Guard migration rollback

The guard migration is additive and performs no backfill. If it is later authorized and a false-positive blocks legitimate writes, the preferred response is a reviewed forward fix that adjusts the affected threshold while retaining owner protection. If the entire guard must be removed:

1. Take and verify a fresh independent backup/PITR point and record aggregate row counts.
2. Stop new frontend rollout until the database and client limits agree.
3. In one separately reviewed transaction, remove the nine `finance_v3_10_owner_resource_limit` triggers, the `finance_v3_*_len_chk` and `finance_v3_*_numeric_chk` constraints, then `finance_private.enforce_owner_resource_limit()`; do not touch finance rows, RLS policies, v3 bridge triggers, or owner-scoped keys.
4. Re-run owner isolation, row/orphan, legacy-client, authenticated CRUD, and advisor checks before reopening rollout.

No executable destructive down migration is checked in because guard removal weakens a security boundary and requires action-time authorization. Exact point-in-time reversal remains the external backup/PITR path.

### Completed transfer release and rollback

`20260824023801_finance_resource_abuse_guards.sql`,
`20260828013341_finance_account_transfers.sql`, the
`finance-import-historical-transfer-batch` Edge Function, and the
transfer-capable frontend were released to Production. Production can contain
`public.transfers` rows; preserve the table, policies, tombstones, and
associated financial records during incident response. For a future migration
or function release, create and independently verify a fresh external database
backup/PITR restore point; record aggregate row counts and current
policies/grants without exporting financial rows.

For code-only rollback, follow the rule in [Code-only frontend rollback](#code-only-frontend-rollback):
when a Production transfer row may exist, use the transfer-aware emergency
artifact. A schema-v3 frontend is historical and conditionally safe only after
an authoritative current aggregate check proves `public.transfers` is empty and
all schema-v4 local raw recovery payloads are preserved. Commit
`d2510646961ff51f725b2e9a3c91bf9fb740516b` predates schema v4, does not pull
`public.transfers`, and is not an operationally safe rollback target when
transfer rows may exist, even if a clean device appears to load normally.

The tested transfer-aware code-only emergency path is:

```powershell
npm.cmd ci
npm.cmd run lint
npm.cmd test
npm.cmd run verify:migration
npm.cmd run build:transfer-read-only
npm.cmd audit --audit-level=high
```

Deploy that reviewed source with build command
`npm.cmd run build:transfer-read-only` (or build-time
`VITE_TRANSFER_MUTATIONS_ENABLED=false`). The resulting frontend still:

- accepts and preserves local schema v4;
- pulls and validates `public.transfers` rows and tombstones;
- preserves endpoint IDs and historical endpoint-name snapshots;
- includes transfers in each account balance and total assets without
  converting them into income or expense;
- blocks transfer create/edit/delete locally and rejects normal, conditional,
  and historical-import transfer writes remotely, leaving any pending transfer
  operations durable for a later repaired build.

Smoke the emergency artifact by loading an existing transfer (including one
whose unchanged endpoint is archived), confirming both account balances and
total assets, and confirming create/edit/delete controls are disabled. Do not
drop or hide `public.transfers`, its tombstones, policies, or triggers. Do not
clear browser storage. Preserve raw recovery exports and all cloud transfer
rows. Prefer a reviewed forward repair when it can safely restore the normal
write path. If database-level reversal is unavoidable, restore the fresh
pre-release backup/PITR point; any selective removal requires separate
authorization plus proof that no transfer rows would be lost.

## Post-rollback verification

- Authenticated user A cannot read or mutate user B rows.
- Legacy transaction amounts, types, categories, accounts, notes, and local date text match the pre-migration evidence.
- Legacy goal `current_amount`, subscription, and budget rows remain present.
- Live allocation sums equal legacy goal `current_amount`; an over-capacity allocation fails atomically without changing either side.
- Pausing/deleting a v3 recurring rule hides its legacy subscription mirror, resuming a valid monthly rule restores it, and archiving an account/category cannot leave an active dependent schedule.
- No duplicate `(user_id, recurring_rule_id, occurrence_date)` records exist.
- Application typecheck, tests, production build, and core authenticated/guest smoke flows pass.
- Oversized UTF-8 text, monetary magnitude above `100000000`, precision above six decimal places, and the first row over each owner ceiling fail without creating a partial row; exact UPSERT retry remains legal at capacity and tombstones hidden from legacy reads still count. Supported legacy values with up to six decimal places remain writable unchanged so JSON restore does not destroy or strand previously valid financial data; preflight must stop on any higher-precision existing value.
