# Expense Tracker — Codex Autonomous Build Specification

> Status: APPROVED BUILD SPEC
> Date: 2026-08-20
> Repository: `qqaq666ziv-byte/Expense_Tracker`
> Companion instructions: read and obey repository-root `AGENTS.md` first.

## 0. Mission

Upgrade the existing Expense Tracker into a reliable, simple personal-finance app without turning it into an overbuilt banking product.

The target experience is:

- fast daily income/expense recording;
- accurate **total assets** derived from real asset accounts such as cash and JKoPay/街口支付;
- clear separation between **what the money was for** (category) and **where the money came from/went** (account);
- trustworthy analytics, budgets, savings, recurring transactions, backup/restore, and cross-device sync;
- strong data integrity, privacy, recoverability, tests, and CI;
- preserve the existing bright Shiba product identity and PWA behavior unless a change is needed for usability/correctness.

Implementation details are intentionally not prescribed. Codex may refactor or redesign internals as needed, but the product rules and acceptance criteria below are authoritative.

---

## 1. Product invariants

These rules must remain true across UI, storage, analytics, sync, backup, and migrations.

### 1.1 Category and account are different concepts

Every normal income/expense transaction must be able to reference both:

- **Category** = why the money changed, e.g. 餐飲、交通、娛樂、零用錢.
- **Account** = where the money is held, e.g. 現金、街口支付.

Example:

- 早餐 NT$80
- type = expense
- category = 餐飲
- account = 街口支付

Effects:

- 餐飲 expense analytics +80
- 街口支付 balance -80
- total assets -80

### 1.2 Total assets are account-based

The homepage primary number remains **總資產**.

`total assets = sum of all active asset-account balances`

The homepage may show a compact breakdown such as:

```text
總資產 NT$3,850
現金       NT$2,300
街口支付   NT$1,550
```

Do not make the account breakdown visually dominate the total-assets number.

### 1.3 Account balance should not drift

Prefer a ledger-derived balance model rather than a freely mutable duplicated balance field.

Conceptually:

`account balance = opening balance + income - expense + non-income/expense adjustments`

If a stored cache is introduced for performance, it must be derivable/reconcilable from authoritative records.

### 1.4 Balance correction is not income

Provide a safe **balance adjustment / balance correction** flow for cases where the system-calculated account balance differs from reality.

An adjustment:

- changes that account balance;
- changes total assets;
- is excluded from income/expense analytics, savings rate, and normal budget spending;
- remains auditable in history.

### 1.5 Savings are allocation, not disappearance of assets

Saving money into a goal must not reduce total assets merely because it was earmarked.

Expose coherent concepts such as:

- total assets;
- allocated savings;
- available/unallocated assets.

A new allocation should not silently exceed available assets. Legacy inconsistencies must be surfaced and migrated safely rather than discarded.

### 1.6 No transfer feature in this scope

Do **not** add a user-facing account-to-account transfer feature now.

However, avoid a schema/design that makes future transfer support prohibitively difficult.

### 1.7 Historical records must survive settings changes

Renaming, re-iconing, reordering, or archiving categories/accounts must not invalidate or delete historical transactions.

Use stable entity identifiers/relations rather than treating display names or emoji as identity.

---

## 2. Required product work

## A. Asset accounts and homepage assets

Implement a simple asset-account model suitable for the current real use case (primarily cash and e-wallet balances).

Required capabilities:

- create account;
- rename account;
- choose/change icon;
- set opening balance;
- view derived current balance;
- reorder if useful to UX;
- archive/inactivate instead of destructive deletion when history exists;
- sync account settings and opening balances per authenticated user;
- allow new income/expense transactions to select the affected account;
- allow existing transactions to preserve/migrate their legacy account/payment-method relation;
- show total assets prominently on the homepage plus a compact account breakdown.

Current scope is **asset accounts only**. Credit-card/debt account modeling is out of scope.

### Migration expectation

Existing transaction `account` strings and existing payment-method data must not simply disappear. Create a deterministic migration/backfill strategy that preserves historical meaning. Migrations should be repeat-safe where practical.

---

## B. Income/expense categories and icon system

Move category configuration from device-only shared local storage to user-owned, cross-device data for authenticated users.

Required category capabilities:

- separate income and expense categories as appropriate;
- stable IDs;
- name;
- icon metadata;
- display order;
- active/archived state;
- cross-device sync;
- safe guest-mode behavior;
- historical transactions continue to resolve archived/renamed categories.

### Icon system

The current small hard-coded emoji set is too restrictive.

Mandatory:

- arbitrary Unicode emoji selection/input;
- a broader generic vector-icon choice suitable for finance, food, transport, entertainment, shopping, phone/e-wallet, etc.;
- the same extensible icon model can be used by accounts and categories while selections remain independent.

Conceptual representation may resemble:

```text
iconType: emoji | vector | custom
iconValue: emoji / icon-key / asset-reference
```

Do not treat this schema example as mandatory if a better implementation exists.

A user-provided custom icon/image is a useful enhancement **only if** it can be implemented safely and synced without external hotlink fragility. It is not a release blocker; arbitrary emoji + vector icons are mandatory.

Do not bundle third-party brand logos merely to imitate a branded payment service unless their use is clearly appropriate. A generic e-wallet/payment icon plus user customization is acceptable.

---

## C. Financial analysis / Insights

### C1. Fix period semantics

Use one shared date-range definition across Insights, Budget, and any other feature.

UI meanings:

- **本週** = current calendar week, Monday through Sunday.
- **本月** = current calendar month.
- **本年** = January 1 through December 31 of the current year.
- **自訂** = inclusive local-date range; the end date must include transactions through the end of that local day.

Do not label rolling 7/30/365-day windows as 本週/本月/本年.

All calculations must use consistent local-time semantics and must handle month/year boundaries and leap years.

### C2. Always-visible today snapshot

At the top of Financial Analysis, add a **今日財務快照** independent of the lower period selector.

At minimum show:

- 今日收入;
- 今日支出;
- 今日淨收支 = 今日收入 - 今日支出;
- 今日支出最多的分類 (by total expense amount for today).

Today = user-local 00:00 through end of local day.

When practical, make summary items useful entry points into the corresponding filtered transactions rather than decorative cards only.

### C3. Period analytics

For the selected period, provide useful, understandable metrics without turning the screen into a chart wall:

- period income;
- period expense;
- period net cash flow;
- expense category composition;
- spending trend;
- comparison with the equivalent previous period;
- average daily expense (for an in-progress current period, use elapsed included days rather than future days);
- largest single expense;
- category change/trend where useful;
- savings rate: `(income - expense) / income`, showing N/A when income is zero rather than dividing by zero;
- budget achievement/usage where relevant;
- account-based breakdown when it improves understanding.

Codex may choose the best combination of cards, lists, and charts. Favor clarity over number of visualizations.

### C4. Remove fake data

Remove the hard-coded/demo 「新窩基金」 values from Insights. If a savings-goal visualization remains, it must use real user data and behave sensibly with no goals.

---

## D. Savings / goals semantics

Preserve useful savings-goal functionality while correcting accounting semantics.

Required behavior:

- a savings allocation does not itself reduce total assets;
- display allocated savings separately from total assets;
- make available/unallocated assets understandable;
- goal progress must come from real goal data, never hard-coded demo values;
- prevent or clearly handle impossible new allocations that exceed available assets;
- preserve existing goal history/data through migration;
- authenticated goal data remains user-scoped and synced.

Do not introduce a full investment or banking ledger.

---

## E. Budget system

Keep the existing weekly/monthly category-budget strengths and make the semantics consistent with the shared calendar-range engine.

Required improvements:

- support an overall total budget plus category budgets;
- clearly show used, remaining, and over-budget states;
- budget calculations use the same transaction/category/date rules as Financial Analysis;
- archived categories do not corrupt historical budget reporting;
- budget data remains user-owned and cross-device synced;
- avoid double-counting or inconsistent definitions between Dashboard and BudgetPlanner.

Do not add complex rollover/custom-period budgeting unless needed to implement the approved scope cleanly.

---

## F. Recurring transactions

Evolve the current fixed-expense/subscription logic into a reliable recurring-transaction system.

Required:

- recurring **income and expense**;
- at least weekly, monthly, and yearly recurrence where feasible without harming reliability;
- start date;
- pause/resume or active/inactive state;
- deterministic next occurrence;
- missed-occurrence/catch-up handling up to the current date;
- strict idempotency: reopening/retrying must not create duplicate occurrences;
- deterministic behavior for dates such as the 29th/30th/31st in shorter months, documented and tested;
- recurring-created transactions must participate normally in account balances, categories, analytics, budgets, sync, export, and backup.

Do not silently invent past occurrences outside the recurring rule's active time range.

---

## G. Backup, export, and restore

Financial data must be portable and recoverable outside the app.

Mandatory:

### CSV

- export transaction data in a stable, understandable CSV format;
- include enough identifiers/display values to remain useful outside the app.

### Full JSON backup

Export a versioned backup that covers all app-owned user data needed for restoration, including as applicable:

- transactions;
- accounts;
- categories;
- goals;
- recurring transactions/subscriptions;
- budgets;
- relevant user settings;
- schemaVersion;
- exportedAt.

### JSON restore/import

- validate structure/version before mutation;
- preserve referential integrity;
- prevent accidental duplicate records;
- fail safely on malformed data;
- do not partially destroy existing data on a failed restore;
- make any destructive replacement mode explicit and guarded.

CSV import is optional for this build if it would compromise reliability or significantly expand scope; JSON round-trip backup/restore is mandatory.

Add a round-trip test: export -> import/restore -> equivalent logical state.

---

## H. Offline sync and account isolation

Replace the current best-effort `synced: false` behavior with a coherent retryable sync model.

Required behaviors for authenticated users:

- queued/pending create, update, and delete operations;
- retry after reconnect;
- visible enough sync state to diagnose unresolved failures without cluttering normal use;
- a failed delete must not later “resurrect” silently from cloud data;
- a failed local edit must not be silently overwritten by stale cloud state;
- deterministic conflict/reconciliation policy, documented in code/tests;
- idempotent retries;
- user A data/settings never leak into user B on the same browser.

### Guest-to-login behavior

Guest data must not silently contaminate an authenticated account.

If guest records exist on first login, use an explicit, safe import/keep-separate decision or another equally clear mechanism. Never silently merge unrelated guest data into the account cache.

Offline design technology is up to Codex (localStorage, IndexedDB, queue abstraction, etc.) as long as the behavior above is reliable.

---

## 3. Repository/security cleanup

### Environment files

- Stop tracking `.env` and `.env.local`.
- Keep a sanitized `.env.example` containing only variables actually required by the current app.
- Do not rewrite Git history solely for the currently tracked env files because the inspected current values did not contain a real private Gemini key or service-role secret; if a real historical secret is discovered during work, switch to rotation-first remediation and report it.

### Remove Gemini remnants

Gemini is no longer used.

- remove `@google/genai` if no real runtime usage exists;
- remove obsolete `GEMINI_API_KEY` documentation/placeholders;
- remove other dead Gemini-related configuration/code;
- verify and remove other obviously unused dependencies only when safely proven unused;
- update lockfile normally.

### Supabase

- preserve/verify RLS ownership on all user-scoped tables;
- new account/category/queue-related tables must not be exposed without appropriate RLS;
- add useful indexes for `user_id` foreign-key/filter paths;
- optimize existing `auth.uid()` RLS expressions when doing so is semantically equivalent and current Supabase guidance supports it;
- keep migrations reviewable and reversible/rollback-aware;
- never embed service-role credentials in frontend code.

---

## 4. Engineering quality

### Automated tests

Add a real automated test setup appropriate to this Vite/React/TypeScript project. The specific framework is Codex's choice.

At minimum cover the following behaviors:

1. calendar week is Monday-Sunday;
2. calendar month does not include the previous month's tail;
3. calendar year boundaries;
4. leap-day behavior (e.g. 2028-02-29);
5. custom end date includes transactions later on that end day;
6. today snapshot uses local-day boundaries;
7. expense is included in its category and deducted from its selected account;
8. income increases the selected account;
9. balance adjustment affects account/total assets but not income or expense metrics;
10. total assets equal aggregate account balances;
11. savings allocation does not reduce total assets;
12. renamed/re-iconed/archived categories preserve historical transactions;
13. recurring occurrence creation is idempotent;
14. recurring catch-up handles missed periods correctly;
15. offline create/update/delete retry successfully;
16. failed delete does not resurrect after reconciliation;
17. guest and authenticated user data stay isolated;
18. JSON backup/restore round trip preserves logical data;
19. migration from existing legacy data preserves transaction amounts/dates/categories/accounts.

### Browser/smoke verification

Add or run at least one browser-level or equivalent end-to-end smoke flow for core user behavior when practical, for example:

- open app in guest/test state;
- create an account with opening balance;
- create an expense using a category + account;
- verify account and total-assets change;
- verify Today's expense/Insights reflects it;
- archive/rename a category and confirm history remains readable.

Preserve PWA installability/offline-shell behavior and mobile responsive usability.

### CI

Add GitHub Actions CI for pull requests and relevant branch pushes. It should include, as appropriate:

- clean install (`npm ci`);
- typecheck/lint;
- automated tests;
- production build;
- a reasonable dependency/security audit gate for high/critical findings, without hiding failures.

CI must not require committing real secrets.

### Maintainability and bundle

- Refactor oversized components/services when it materially improves correctness, testability, or maintainability.
- Do not refactor merely to satisfy an arbitrary file-size rule.
- Reduce obvious unnecessary bundle weight/dead dependencies; use lazy loading/code splitting when it provides a real benefit.
- Do not sacrifice clarity or reliability solely to chase a bundle-size number.

---

## 5. Data migration and compatibility rules

Existing user data is production data.

The implementation must:

- preserve existing transactions, goals, budgets, subscriptions/recurring data, and user ownership;
- migrate legacy string-based account/payment-method references deterministically;
- avoid silently changing transaction amount/type/date/category meaning;
- preserve legacy data even if a newer model has richer IDs/relations;
- be safe to retry where practical;
- provide a rollback path for schema/data migrations;
- test migration against representative legacy fixtures before production application;
- document any visible one-time behavior change, especially the corrected savings/total-assets semantics.

If changing the legacy text date storage format is not necessary for correctness, a well-tested canonical parsing/date-range layer is acceptable. If storage is migrated, preserve the original local-time meaning and prove it with migration tests; do not guess historical timezone offsets.

---

## 6. Explicit non-goals for this build

Do not add these unless they become necessary to complete an approved requirement:

- account-to-account transfer UI;
- receipt OCR;
- multi-currency;
- automatic bank synchronization;
- AI financial advisor;
- family/shared-account features;
- debt/loan management;
- full credit-card billing model;
- transaction tags;
- split transactions;
- refund workflow;
- receipt/file attachments;
- bulk transaction management;
- complex budget rollover/custom periods.

Keep the product focused.

---

## 7. Autonomous execution loop

Codex should execute this as an end-to-end quality sprint rather than waiting for step-by-step prompts.

1. Obey `AGENTS.md` and establish the remote pre-task checkpoint.
2. Audit the current repository/data model before editing.
3. Create a coherent implementation plan and dependency order internally.
4. Implement in safe increments with commits.
5. Add migrations and tests alongside the behavior they protect.
6. Run typecheck/tests/build continuously.
7. Run a dedicated correctness/data-integrity review.
8. Run a dedicated security/privacy review.
9. Run an adversarial edge-case/red-team review.
10. Repair findings and repeat verification.
11. Do not stop at the first green build if blocking correctness/security findings remain.
12. Produce a final quality report and Draft PR when the environment permits.

Routine implementation choices should be made autonomously. Only escalate genuine blockers described in `AGENTS.md`.

---

## 8. Definition of Done

The sprint may be called complete only when all of the following are true, or an explicit unavoidable blocker is documented:

- approved product behaviors above are implemented;
- existing user data has a safe migration path with no known silent-loss scenario;
- account/category ownership and RLS are verified;
- financial period calculations are consistent across features;
- total-assets/account/savings semantics are internally consistent;
- offline create/update/delete cannot knowingly lose or resurrect data in tested scenarios;
- backup JSON round-trip works;
- Gemini/dead env remnants are cleaned up;
- `.env` files are no longer tracked;
- automated tests cover critical financial/date/sync/migration rules;
- CI is green;
- production build succeeds;
- core mobile/PWA smoke flow is verified;
- `README.md` is updated to accurately reflect the final implemented features, setup/environment variables, account/category/savings semantics, backup/restore behavior, sync/offline behavior, migrations, and any remaining limitations; stale or removed Gemini-related documentation is removed;
- no known blocking security or data-integrity finding remains;
- changes are committed on a task branch;
- a Draft PR is prepared when possible;
- `QUALITY_REPORT.md` (or equivalent final report) records evidence, remaining limitations, and rollback instructions.

### Quality scoring

Target 10/10 against this specification, but do not manufacture a perfect score.

A suggested review weighting:

- Functional/product correctness: 25
- Financial/data integrity: 20
- Sync/offline reliability: 15
- Security/privacy/migrations: 15
- Automated tests + CI evidence: 10
- UX/mobile/PWA regression quality: 10
- Maintainability/documentation: 5

If the measured result is 9.4/10, report 9.4/10 and explain the remaining gap. If the gap is fixable within scope, continue the repair loop instead of stopping merely because the app “mostly works.”

---

## 9. Final deliverables

Expected final artifacts from Codex:

- implementation commits on a task branch;
- database migration files where required;
- automated tests;
- GitHub Actions workflow;
- updated `.env.example` and dependency cleanup;
- updated README/user-facing documentation for changed semantics and backup/restore;
- `QUALITY_REPORT.md` or equivalent evidence report;
- Draft PR with concise change summary, testing evidence, migration notes, known limitations, and rollback checkpoint tag/SHA;
- preview/deployment URL when the connected environment supports a safe preview deployment.

Do not merge or perform destructive production rollout solely to satisfy this document; those actions require the authorization rules in `AGENTS.md`.

