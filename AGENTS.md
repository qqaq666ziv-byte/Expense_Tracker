# AGENTS.md — Expense Tracker

> Scope: repository root and all descendants unless a deeper `AGENTS.md` overrides it.
> Purpose: maximize Codex autonomy while preserving recoverability, secrets, production data, and verifiable quality.

## 1. Autonomy

- Own the implementation end to end. Choose architecture, libraries, refactors, file layout, and implementation details based on the repository and task.
- Do not ask the user to decide routine engineering details that can be resolved from code, tests, documentation, or established conventions.
- Prefer the smallest coherent design that satisfies the requested product behavior and improves maintainability.
- Preserve the existing product identity and working behavior unless the task explicitly changes it.
- Ask for user input only when blocked by missing credentials/permissions, an irreversible or destructive action, a material product-value ambiguity that cannot be inferred, or a significant security/legal/financial consequence.
- Prefer clear goals, invariants, and repository evidence over prescriptive implementation recipes; use engineering judgment unless a hard safety or product boundary requires otherwise.

## 2. Mandatory remote checkpoint before mutation

The user requires a remotely recoverable snapshot before work begins on every new prompt that can mutate code, configuration, repository state, or production data.

Before the first mutation for a new prompt:

1. Inspect the current branch, `git status`, and HEAD SHA.
2. Confirm that the exact current repository state is safely committed. Never commit suspected secrets merely to create a checkpoint.
3. If the current state differs from the last remotely persisted checkpoint, create a checkpoint commit when needed, then create an annotated tag using a clear name such as:
   `checkpoint/YYYYMMDD-HHMM-before-<short-task-slug>`
4. Push the current working branch/commit and the checkpoint tag to the remote before making task changes.
5. Record the checkpoint tag and SHA for the final report.
6. If the exact current SHA already has a remote checkpoint and the repository state has not changed, reuse it rather than creating a duplicate tag.
7. If a remote checkpoint cannot be persisted because of authentication, network, permissions, or another blocker, do **not** start mutating work. Report the blocker.

Never, without explicit user authorization:

- delete checkpoint tags;
- force-push;
- rewrite already-pushed history;
- amend or rebase away a remotely checkpointed state.

Work on a task/feature branch rather than making experimental changes directly on `main`. Do not merge to `main` or deploy destructive production changes unless the user explicitly authorizes that action.

## 3. Secrets and privacy

- Never commit real secrets, credentials, private keys, access tokens, service-role keys, database passwords, OAuth client secrets, production dumps, real user financial data, or private debug logs.
- Frontend-safe public configuration may be referenced through environment variables, but local `.env` files must not be tracked. Keep only a sanitized `.env.example` in Git.
- If a suspected secret is discovered, stop exposing it in output, identify the affected credential by type/name only, and use a rotation-first remediation plan.
- Never place production database backups inside the Git repository.

## 4. Production data and migrations

- Treat user financial data as high-value production data.
- Schema/data migrations must be backward-aware, idempotent where practical, and designed to preserve existing records.
- Before any destructive production migration or bulk data mutation, ensure an independent rollback/backup path exists. A Git checkpoint is not a database backup.
- Prefer additive migrations and verified backfills over destructive rewrites.
- Never silently discard, overwrite, merge, or reinterpret existing financial records without a documented migration rule and verification.
- Maintain row-level ownership protections for all user-scoped Supabase tables.
- For production deployment, domain, OAuth, PWA/Service Worker, or rollback/recovery work, read `docs/PRODUCTION_RELEASE.md` as the detailed release runbook and verify recorded deployment topology against the live environment before relying on it.

## 5. Verification is required

A task is not complete because the UI looks correct or the build succeeds.

After changes, run all relevant checks available in the repository, including at minimum when configured:

- type checking / linting;
- automated tests;
- production build;
- relevant security/dependency checks;
- focused manual or browser smoke verification for changed user flows.

Add or improve tests when changing financial calculations, dates, migrations, sync, authentication boundaries, recurring logic, account balances, categories, budgets, backup/restore, or other data-integrity behavior.

Do not hide, delete, weaken, or skip a failing check merely to make the task appear complete. Fix the cause or report the unresolved blocker.

## 6. Review loop

For substantial tasks, separate implementation from review:

1. Implement.
2. Run automated verification.
3. Perform a correctness/data-integrity review.
4. Perform a security/privacy review.
5. Perform an adversarial/red-team pass for edge cases and regression risks.
6. Repair findings.
7. Repeat until no blocking finding remains or a genuine user-only blocker is reached.

Use independent agents/reviewers when the environment supports them; otherwise perform clearly separated review passes. Do not inflate a quality score or claim perfection without evidence.

## 7. Completion report

When finishing a modifying task, report concisely:

- checkpoint tag + SHA used as the pre-task restore point;
- branch / PR if created;
- what changed and why;
- migrations or production actions performed (or intentionally not performed);
- tests/checks run and their results;
- security/data-integrity review findings;
- any remaining limitations or blockers;
- the exact rollback path.

Leave the worktree in a clean, understandable state and commit the completed work.

