# Finance v3 migration rollback

Migration: `20260821103249_finance_v3_additive_schema.sql`

This migration is additive and has **not** been applied to production by Codex. The pre-task Git restore point is:

- tag: `checkpoint/20260821-180842-before-autonomous-build`
- SHA: `56df3f31d2a3c7b93954faef9c352859c8f1f3d5`

## Required pre-deployment recovery point

Before applying the migration to any non-local database:

1. Create and independently verify a Supabase/PostgreSQL backup or PITR restore point. Git is not a database backup.
2. Record row counts for `transactions`, `goals`, `subscriptions`, and `budgets` without exporting private row contents into the repository.
3. Capture the current policy/grant definitions so a database restore can recover them exactly.
4. Run the migration on an isolated preview/staging database populated with sanitized representative fixtures.
5. Verify migrated entity counts, orphan checks, RLS owner isolation, recurrence uniqueness, and the legacy-goal allocation total before production approval.

## Safest application rollback

The preferred rollback is code-only:

1. Stop or roll back the v3 frontend deployment to the checkpointed application commit.
2. Leave the additive v3 tables/columns, tightened RLS policies, and legacy columns in place.
3. Do not delete v3 records. The legacy columns on `transactions`, `goals`, `subscriptions`, and `budgets` were intentionally retained for this path.
4. Diagnose and repair forward in a new reviewed migration.

Leaving the schema in place is safe because unused additive objects do not reinterpret or remove legacy financial records. Do not revert the owner-scoped RLS policies to a broader historical policy merely to restore an old client.

## Database rollback

If the schema itself must be reversed, restore the independently verified pre-migration database backup/PITR point. This is the only supported exact reversal because the migration:

- replaces existing policies with strict owner policies;
- creates deterministic allocations from legacy goal totals;
- may accept new v3-only account, category, adjustment, allocation, and recurring-rule records after deployment.

A destructive `DROP TABLE`/`DROP COLUMN` rollback is intentionally not provided. It could silently discard v3-only financial records or recreate obsolete broad policies. Any selective removal requires explicit approval, a fresh backup, proof that no v3-only rows exist, and a separately reviewed migration.

## Post-rollback verification

- Authenticated user A cannot read or mutate user B rows.
- Legacy transaction amounts, types, categories, accounts, notes, and local date text match the pre-migration evidence.
- Legacy goal `current_amount`, subscription, and budget rows remain present.
- No duplicate `(user_id, recurring_rule_id, occurrence_date)` records exist.
- Application typecheck, tests, production build, and core authenticated/guest smoke flows pass.
