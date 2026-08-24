# Production Release — Expense Tracker

This document defines the canonical production release contract for 柴柴記帳.

It exists to prevent deployments from being considered successful merely because
a build completed or Vercel returned `READY`.

The canonical user-facing production site is the source of truth for release
verification.

---

## Canonical production identity

Repository:

`qqaq666ziv-byte/Expense_Tracker`

Production branch:

`main`

Canonical production URL:

`https://shiba-expense-tracker.vercel.app`

Production Supabase project:

`rarkcgtgfvwymjuxgfkx`

The canonical production URL must not be silently replaced by another
`*.vercel.app` deployment URL.

A temporary Preview or alternate Vercel URL may be used for validation, but it
does not become production unless the user explicitly changes this contract.

---

## Vercel project identity

The canonical production Vercel project is the verified project intended to serve:

`shiba-expense-tracker.vercel.app`

Current domain ownership must be verified against the intended production repository,
release, and deployment topology.

If the canonical domain is attached to an obsolete or unintended Vercel project,
treat that as a deployment-topology incident to resolve, not as evidence that the
current owner is authoritative.

Do not infer the correct project from its display name.

---

## Release philosophy

The agent owns the implementation and release mechanics.

Choose the safest and simplest release path supported by the current repository
and deployment environment.

Prefer evidence from Git, CI, Vercel, Supabase, and the running application over
assumptions based on project names or previous deployments.

Do not create redundant deployments merely to obtain a green `READY` status.

---

## Before production release

Establish the exact release candidate.

Confirm:

- the intended changes are committed;
- the intended release commit exists on GitHub;
- required CI checks pass;
- production build succeeds;
- the target Vercel project is the verified project intended to serve the canonical production URL;
- required production environment variables are configured on that project;
- the release does not require an unauthorized destructive database operation.

For changes affecting financial data, authentication, sync, migrations, or
owner isolation, ensure that a suitable rollback or recovery path exists before
production mutation.

A Git checkpoint protects source code.

It does not replace a database backup.

---

## Deployment

Use the repository's established production deployment mechanism when it is
healthy.

If merging or pushing `main` already triggers the canonical Vercel production
deployment, do not create an additional manual production deployment without a
specific reason.

If a manual deployment is necessary, verify its Vercel project and target before
executing it.

The existence of a deployment whose state is `READY` is not sufficient evidence
that production has been released successfully.

---

## Canonical post-deploy verification

Always verify the canonical URL itself:

`https://shiba-expense-tracker.vercel.app`

The release is complete only when the canonical site is serving the intended
application.

At minimum, verify:

- HTTP response succeeds;
- the page renders rather than returning a blank application shell;
- the expected current product version/UI is present;
- required JS/CSS/chunks load successfully;
- there is no blocking browser runtime error;
- authentication can begin correctly when relevant;
- Supabase connectivity works when relevant;
- the changed user flow passes an appropriate smoke test.

For sync/data-integrity changes, also verify that the expected cloud state is
preserved and that new sync errors are not being generated.

Do not create, edit, or delete genuine user financial records merely to perform
a smoke test unless the user explicitly authorizes it.

---

## PWA and cache awareness

柴柴記帳 is a PWA.

When a new deployment appears inconsistent with the release candidate, distinguish
between:

- a stale client or Service Worker;
- a broken production bundle;
- incorrect environment configuration;
- an incorrect Vercel project/domain mapping.

Do not immediately delete production data or roll back source code merely
because one client displays stale content.

Use browser/network evidence to identify the layer that is actually failing.

---

## Supabase production safety

The production database contains real user financial data.

Preserve:

- owner-scoped RLS;
- financial record ownership;
- sync version/conflict semantics;
- tombstone semantics;
- migration history.

Do not weaken a data-integrity guard merely to make a failing client write
succeed.

If a guard rejects a write, determine whether the client operation is stale,
invalid, or conflicting before changing the guard.

Do not bulk rewrite, delete, reassign, or merge real financial records without
an explicit migration/recovery rule and appropriate authorization.

---

## Rollback

Frontend rollback and database rollback are separate operations.

A frontend regression may be mitigated by restoring a previously verified
Vercel deployment while leaving additive database schema changes intact.

Do not reverse production database migrations merely because the frontend
requires rollback unless database rollback is independently justified and safe.

Before a release, identify the previous known-good production deployment when
possible.

After a successful release, update the release record with:

- release commit SHA;
- Vercel deployment ID;
- canonical Vercel project ID;
- canonical URL verification result;
- any production migration performed;
- rollback deployment/reference.

---

## Incident handling

If production is broken:

1. Preserve evidence and establish the current Git/Vercel/Supabase state.
2. Determine whether the failure is source, build, runtime, environment,
   cache/PWA, authentication, sync, database, or domain-routing related.
3. Repair the smallest confirmed root cause.
4. Verify the canonical production URL.
5. Preserve production financial data throughout the incident unless a
   specifically authorized recovery operation requires otherwise.

Do not stack speculative fixes across multiple layers at once.

---

## Release record

Update this section after the current production incident is fully resolved.

Canonical Vercel project ID:

`TO_BE_VERIFIED`

Latest known-good production commit:

`TO_BE_VERIFIED`

Latest known-good production deployment:

`TO_BE_VERIFIED`

Last verified at:

`TO_BE_VERIFIED`
