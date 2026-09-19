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

Verification and independent review default to the changed behavior and its
affected dependencies. Full-product E2E is required only when explicitly
requested or when concrete failures or significant cross-cutting risks justify
it. An unchanged unrelated screenshot or icon is not a release gate. When a
review tool needs exclusions, record the baseline and evidence scope rather
than silently marking missing evidence as reviewed. Keep the actual reviewer
conclusion separate from the tool's formal status and follow the user's current
release acceptance criteria.

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

The completed transfer release applied
`20260824023801_finance_resource_abuse_guards.sql` and
`20260828013341_finance_account_transfers.sql`, released the transfer-capable
frontend, and released the server artifact
`supabase/functions/finance-import-historical-transfer-batch`. Its public
handler verifies the Supabase user JWT and complete owner-scoped import/restore
manifest, then uses the server-only service role to enter the single atomic
database transaction. `anon` and ordinary `authenticated` roles must have no
`EXECUTE` privilege on that RPC. Future migration/function releases still
require isolated staging verification, a fresh independent backup/PITR point,
and explicit authorization; never copy a service-role credential into Vercel
or browser code.

---

## Rollback

Frontend rollback and database rollback are separate operations.

After the transfer-fee release, any potentially existing nonzero fee requires a
**fee-aware** frontend as well. Build the emergency `transfer-read-only` mode
from the reviewed fee-capable release commit; an older transfer-only release
omits fees from balances and expense reports. Do not route users to that older
release unless authoritative evidence rules out cloud fees and local pending
fee records. Preserve the additive fee column and records during recovery.
See [TRANSFER_FEES.md](TRANSFER_FEES.md) for the fee-specific release rules.

Use one operational rule for a code-only frontend rollback: **if any
Production `public.transfers` row may exist, deploy a transfer-aware frontend.**
Unless an authoritative, current aggregate check proves the table is empty,
treat transfer rows as potentially present. Do not restore a frontend that
cannot pull, validate, display, and calculate transfers; a clean device can
appear healthy while its account balances and total assets omit cloud transfers.

The primary emergency path is the repository's tested transfer-aware build
mode. From the reviewed transfer-capable release commit, run:

```powershell
npm.cmd ci
npm.cmd run build:transfer-read-only
npm.cmd run preview -- --host 127.0.0.1
```

`build:transfer-read-only` uses Vite mode `transfer-read-only`. It retains local
schema v4, transfer pulls/validation, historical snapshots, tombstones, account
balances, and total-assets calculations, while disabling transfer
create/edit/delete in the UI and rejecting transfer writes (including queued
historical-import batches) at the remote-adapter boundary. Non-transfer reads
and writes continue normally. For a hosted emergency build, configure the
deployment build command as `npm.cmd run build:transfer-read-only`, or set
`VITE_TRANSFER_MUTATIONS_ENABLED=false` for the build. Verify the served bundle
and canonical deployment before routing users to it.

A schema-v3/pre-transfer frontend is historical and conditionally safe only
when authoritative current evidence proves `public.transfers` is empty and all
schema-v4 local raw recovery payloads have been preserved. In particular,
pre-transfer commit `d2510646961ff51f725b2e9a3c91bf9fb740516b` is never an
operationally safe rollback target while a transfer row may exist.

Do not clear browser storage or drop/hide the transfer table or tombstones to
make an older client start. Preserve a raw recovery export and every cloud
transfer row. Prefer a reviewed forward repair whenever it can restore the
normal write path without increasing recovery risk.

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

## Transfer-fee release record — 2026-09-19

- PR: https://github.com/qqaq666ziv-byte/Expense_Tracker/pull/16
- Release commit: `82261a94213b1268c4570be048f010fd09533680` (merged at
  `2026-09-19T15:56:38Z`).
- Vercel production deployment: `dpl_DzLM9ex1q3QeqKvV7rJ2MB6GDFvX`, project
  `prj_PDwYdTxA52vgkfRek2AzNofUJCHW`, Git `main`, state `READY`.
- Canonical URL: https://shiba-expense-tracker.vercel.app; the page, current
  JavaScript `/assets/index-Ble7tv9m.js`, stylesheet `/assets/index-DE5VnswL.css`,
  and `/sw.js` returned HTTP 200 with the expected content types.
- Canonical browser smoke completed after a normal reload updated the old PWA
  shell, without clearing site data. In guest mode the transfer form displayed
  the optional fee and correctly previewed principal 1,000 plus fee 15 as source
  debit 1,015 and destination credit 1,000. No production financial record was
  saved. No browser warning/error was captured in that smoke session.
- Local verification: 46 test files / 505 tests passed; lint, migration
  verification, production build, and transfer-read-only build passed. The
  dependency audit reported no vulnerabilities. Focused local browser checks
  covered balances, fee editing/persistence, and the mobile form.
- Ordinary ChatGPT reviewed the source and test evidence through AutoDev and
  found no remaining confirmed code blocker in round 3. The historical AutoDev
  job `7114bee8-b8ea-4f5d-b2a7-21f925c4724d` retained a pending formal status
  because seven unchanged PNG files lacked separate visual evidence. The user
  explicitly clarified that affected functionality is the release scope and
  authorized deployment. This release does not claim a formal AutoDev PASS or
  a complete-product E2E review; the historical manifest was not rewritten.
- Applied exactly `20260919000000_finance_transfer_fees.sql` to Supabase project
  `rarkcgtgfvwymjuxgfkx`; the subsequent migration dry-run was up to date.
  Verified `fee numeric NOT NULL`, ownership RLS enabled, no anonymous SELECT,
  no ordinary authenticated DELETE on transfers, and server-only import RPC
  execution. No existing financial records were rewritten.
- Aggregate row counts and content fingerprints were identical before/after:

  | Table | Rows | MD5 content fingerprint |
  | --- | ---: | --- |
  | accounts | 14 | `596d8168fe0b80cc3a0494f94d559bfc` |
  | transactions | 118 | `197e079fc863333f4577032a03c00068` |
  | transfers | 0 | `d41d8cd98f00b204e9800998ecf8427e` |
  | savings_allocations | 1 | `3dec2ea4fb11b96a99fe57c556b47606` |

  Fingerprints cover row JSON ordered by owner/id, excluding the new fee field
  for the transfer comparison; no private record contents are stored here.
- Independent backup, outside Git:
  `C:\Users\USER\.codex\backups\Expense_Tracker\20260919-transfer-fees-release`.
  `production.custom` SHA-256
  `51634551A863F33920DE2D6C414D9434710EA3DEA658C9A133C05FD8CE5C2333`;
  `roles.sql` SHA-256
  `95AF5CD4F5924F599B212A6555735E858B2686B287A24AE5004D409E60949C62`.
  Archive listing and full decompression passed; an actual restore was not run.
- Pre-deployment source checkpoint:
  `checkpoint/20260919-2353-before-fees-deploy` at
  `fab60402d874289d3daefa85450271436c445995`.
- Recovery: build `build:transfer-read-only` from the release commit above and
  deploy through the canonical project if transfer writes must be stopped.
  Preserve the fee column, transfer rows, and tombstones. The previous production
  deployment `dpl_B1qByNA1BHTSgBF4qUoTn2tC7RGT` at `0f60a473...` is historical,
  **not** the default rollback target once a cloud or pending local fee may exist.
  A database restore requires separate authorization and a current recovery
  plan that preserves data written after this backup.

---

## Historical release record — 2026-08-24

This is historical topology and release evidence, not the current or latest
Production-state record after the completed transfer release.

Canonical Vercel project ID:

`prj_PDwYdTxA52vgkfRek2AzNofUJCHW`

Recorded production commit:

`3b36bc0d63a635ef66fe2aadb8eb52a610ffd0dd`

Recorded production deployment:

`dpl_14dFNW7J6LfgwLtuMtEuQufxi3KC`

Last verified at:

`2026-08-24T20:13:29+08:00`

Verified production topology and evidence:

- Vercel project metadata links the project above to
  `qqaq666ziv-byte/Expense_Tracker`; this identity was not inferred from the
  display name.
- `shiba-expense-tracker.vercel.app` resolved to the deployment above, built
  from `main` at the recorded commit.
- The canonical URL returned HTTP 200 and served the intended production entry
  bundle `/assets/index-D5mk4P_j.js`; its JavaScript, CSS, manifest, and Service
  Worker resources returned HTTP 200 with the expected content types.
- Two existing browser profiles initially received the prior PWA shell. Normal
  Service Worker update and reload moved both to the recorded bundle without
  deleting site data; the current React UI rendered and its main record,
  insights, assets, and planning surfaces had no blocking console errors.
- The earlier `READY` deployment/canonical mismatch was an alias-routing issue:
  a newer project deployment was ready while the canonical alias still resolved
  to an older deployment. The canonical alias was explicitly assigned to the
  recorded deployment and then verified by hostname.
- This historical release did not include a production database migration or
  bulk financial-data mutation. In particular,
  `20260824023801_finance_resource_abuse_guards.sql` was not deployed as part
  of this 2026-08-24 release; it was applied later as part of the completed
  transfer release.
- Source restore point:
  `checkpoint/20260824-194448-before-auth-production-sync-incident` at
  `ba2e4f282817d1056d38dcce389e5804c0c09ae1`.
- Frontend rollback candidate: the previously canonical deployment
  `dpl_85M2AYQZsnsS4XcZubTfEkBszXqS` at
  `73a679940aa8444cd4cf3a1c5bbb821b699bbcc6`. Reassign only the canonical alias
  for a frontend rollback; do not roll back or mutate production finance data.
