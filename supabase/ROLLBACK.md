# Finance v3 migrations and rollback

Migrations:

- `20260821103249_finance_v3_additive_schema.sql` — applied to production on 2026-08-24 after an independently stored PostgreSQL backup.
- `20260824023801_finance_resource_abuse_guards.sql` — reviewed and locally verified, **not applied to production** pending explicit authorization.
- `20260828013341_finance_account_transfers.sql` — additive first-class transfer table and capacity-guard extension, locally verified, **not applied to production** pending explicit authorization.

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

For `finance_resource_abuse_guards`, also record aggregate-only preflight results for every guarded text/numeric field and each owner's table count. The 2026-08-24 production preflight found zero text or numeric violations in all currently non-empty finance tables and every owner below quota. Re-run it immediately before deployment because production can change. A `NOT VALID` constraint preserves an existing violating row at creation time but rejects a later update to that row; if preflight ever reports a violation, stop and design a reviewed, data-preserving cleanup before applying the guard.

For `finance_account_transfers`, preserve migration order: apply `20260824023801_finance_resource_abuse_guards.sql` before `20260828013341_finance_account_transfers.sql`. On an isolated staging database, verify clean install and upgrade from the production-like state, then prove transfer owner isolation, positive/distinct-account constraints, archived-account rejection for new endpoints, same-clock conflict rejection, tombstone retry, and all four included/excluded total-assets cases. Immediately before an authorized Production release, re-read remote migration metadata and take a fresh independently verified backup/PITR point. Do not deploy a frontend that can create transfers until the transfer table and policies are confirmed available.

The repository release document and the domains currently attached to the active Vercel project have a known topology discrepancy. It remains a separate release follow-up; do not change domains or aliases as part of the transfer database release.

## Safest application rollback

The preferred rollback is code-only:

1. Stop or roll back the v3 frontend deployment to the previous known-good production deployment `dpl_6ejsiuY1gFcGne5F7U44kuUeFdWj`, built from main SHA `5fcebebe4b924b94929a4e0c638437796ef2ef9c` and previously serving `https://pure-finance-pi.vercel.app/`.
2. Leave the v3 tables/columns, owner-scoped legacy primary keys, tightened RLS policies, and legacy columns in place.
3. Do not delete v3 records. The legacy columns on `transactions`, `goals`, `subscriptions`, and `budgets` were intentionally retained for this path.
4. Diagnose and repair forward in a new reviewed migration.

Leaving the backward-compatible schema in place preserves legacy financial records and lets the old client continue to use its owner-qualified CRUD paths. Headerless legacy reads intentionally hide tombstones, archived goals/budgets, and paused subscriptions; v3 requests retain owner-scoped full-graph visibility through the non-secret capability header. Allocation totals and representable monthly recurring rules remain projected into the retained legacy columns/tables so a code-only frontend rollback does not reinterpret them as missing. Do not restore the global `id` uniqueness constraint or broaden historical RLS policies merely to roll back the frontend.

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

### Transfer migration release and rollback

For a later explicitly authorized release:

1. Create and verify a fresh external database backup/PITR restore point; record aggregate row counts and current policies/grants without exporting financial rows.
2. Apply pending migrations in timestamp order on isolated staging, run `npm.cmd run verify:migration`, then repeat owner/RLS and transfer-capacity smoke checks.
3. Apply the same pending migrations to Production through the reviewed Supabase migration workflow.
4. Verify that `public.transfers` has exactly three authenticated owner policies, no authenticated `DELETE` grant, both owner-scoped account foreign keys, conflict/resource/account guards, and no orphan rows.
5. Deploy the compatible frontend only after the schema check succeeds; verify guest and an authorized isolated authenticated ledger without touching genuine user financial rows.

The preferred rollback is code-only: restore the previous frontend while leaving `public.transfers` and its rows intact. Older clients synchronize known entity tables individually and therefore do not delete unknown transfer rows. However, rolling the frontend from the schema-v4 local-state client back to a schema-v3 client is not guaranteed to be immediately usable: the older validator preserves the raw local payload and all cloud rows but may deliberately enter recovery protection because it cannot interpret the newer local schema. Keep the raw recovery export, do not clear browser storage, and prefer a forward client repair when that is safer than asking the older client to reinterpret the ledger. Do not drop the table, its tombstones, policies, or triggers. If a database-level reversal is unavoidable, restore the fresh pre-release backup/PITR point; any selective removal requires separate authorization plus proof that no transfer rows would be lost. A forward repair migration is preferred for client-schema, constraint, policy, trigger, or capacity-calculation defects.

## Post-rollback verification

- Authenticated user A cannot read or mutate user B rows.
- Legacy transaction amounts, types, categories, accounts, notes, and local date text match the pre-migration evidence.
- Legacy goal `current_amount`, subscription, and budget rows remain present.
- Live allocation sums equal legacy goal `current_amount`; an over-capacity allocation fails atomically without changing either side.
- Pausing/deleting a v3 recurring rule hides its legacy subscription mirror, resuming a valid monthly rule restores it, and archiving an account/category cannot leave an active dependent schedule.
- No duplicate `(user_id, recurring_rule_id, occurrence_date)` records exist.
- Application typecheck, tests, production build, and core authenticated/guest smoke flows pass.
- Oversized UTF-8 text, monetary magnitude above `100000000`, precision above six decimal places, and the first row over each owner ceiling fail without creating a partial row; exact UPSERT retry remains legal at capacity and tombstones hidden from legacy reads still count. Supported legacy values with up to six decimal places remain writable unchanged so JSON restore does not destroy or strand previously valid financial data; preflight must stop on any higher-precision existing value.
