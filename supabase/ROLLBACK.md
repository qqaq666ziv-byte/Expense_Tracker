# Finance v3 migration rollback

Migration: `20260821103249_finance_v3_additive_schema.sql`

This migration has **not** been applied to production by Codex. It preserves legacy financial rows and columns while expanding the schema and correcting legacy IDs to owner-scoped primary keys. The Git restore points are:

- tag: `checkpoint/20260821-180842-before-autonomous-build`
- SHA: `56df3f31d2a3c7b93954faef9c352859c8f1f3d5`
- resume tag: `checkpoint/20260823-105721-before-resume-interrupted-build`
- resume SHA: `ba3e5de15a83cf314c3a3a64a7fc3580fd625fee`

## Required pre-deployment recovery point

Before applying the migration to any non-local database:

1. Create and independently verify a Supabase/PostgreSQL backup or PITR restore point. Git is not a database backup.
2. Record row counts for `transactions`, `goals`, `subscriptions`, and `budgets` without exporting private row contents into the repository.
3. Capture the current policy/grant definitions so a database restore can recover them exactly.
4. Run the migration on an isolated preview/staging database populated with sanitized representative fixtures.
5. Verify migrated entity counts, orphan checks, RLS owner isolation, recurrence uniqueness, server allocation-capacity rejection, parent-archive atomic pauses, the bidirectional legacy-goal/subscription mirrors, and the owner-scoped primary keys before production approval.
6. Confirm there are no unexpected incoming foreign keys to the four legacy tables. The migration intentionally aborts rather than dropping an unknown dependency.

## Safest application rollback

The preferred rollback is code-only:

1. Stop or roll back the v3 frontend deployment to the checkpointed application commit.
2. Leave the v3 tables/columns, owner-scoped legacy primary keys, tightened RLS policies, and legacy columns in place.
3. Do not delete v3 records. The legacy columns on `transactions`, `goals`, `subscriptions`, and `budgets` were intentionally retained for this path.
4. Diagnose and repair forward in a new reviewed migration.

Leaving the backward-compatible schema in place preserves legacy financial records and lets the old client continue to use its owner-qualified CRUD paths. Headerless legacy reads intentionally hide tombstones, archived goals/budgets, and paused subscriptions; v3 requests retain owner-scoped full-graph visibility through the non-secret capability header. Allocation totals and representable monthly recurring rules remain projected into the retained legacy columns/tables so a code-only frontend rollback does not reinterpret them as missing. Do not restore the global `id` uniqueness constraint or broaden historical RLS policies merely to roll back the frontend.

## Database rollback

If the schema itself must be reversed, restore the independently verified pre-migration database backup/PITR point. This is the only supported exact reversal because the migration:

- replaces existing policies with strict owner policies;
- changes the four legacy primary keys from global `id` to `(user_id,id)` without changing row contents;
- creates deterministic allocations from legacy goal totals;
- may accept new v3-only account, category, adjustment, allocation, and recurring-rule records after deployment.

A destructive `DROP TABLE`/`DROP COLUMN` rollback is intentionally not provided. It could silently discard v3-only financial records or recreate obsolete broad policies. Any selective removal requires explicit approval, a fresh backup, proof that no v3-only rows exist, and a separately reviewed migration.

## Post-rollback verification

- Authenticated user A cannot read or mutate user B rows.
- Legacy transaction amounts, types, categories, accounts, notes, and local date text match the pre-migration evidence.
- Legacy goal `current_amount`, subscription, and budget rows remain present.
- Live allocation sums equal legacy goal `current_amount`; an over-capacity allocation fails atomically without changing either side.
- Pausing/deleting a v3 recurring rule hides its legacy subscription mirror, resuming a valid monthly rule restores it, and archiving an account/category cannot leave an active dependent schedule.
- No duplicate `(user_id, recurring_rule_id, occurrence_date)` records exist.
- Application typecheck, tests, production build, and core authenticated/guest smoke flows pass.
