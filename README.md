# 柴柴極速記帳

柴犬主題、行動裝置優先的個人財務 PWA。它把「錢花在哪裡（分類）」與「錢從哪個帳戶進出（資產帳戶）」分開記錄，並以帳本推導總資產；訪客可完全離線使用，登入後可透過 Supabase 做擁有者隔離的跨裝置同步。

## 目前功能

- 資產帳戶：建立、改名、任意 Emoji／通用向量圖示、期初餘額、啟用／封存、是否納入總資產。
- 收支分類：收入與支出分開、穩定 ID、持久化顯示順序，改名／換圖示／封存後仍可解析歷史交易。
- 日常帳本：收入、支出、帳戶、分類、時間、備註，以及可編輯、tombstone 刪除與每次 30 筆的完整歷史漸進載入。
- 餘額校正：留下獨立可稽核調整紀錄，不混入收入、支出、儲蓄率或預算。
- 財務分析：今日快照、本週（週一至週日）、本月、本年、自訂含結束日、同等已經過天數的前期比較、分類組成、支出趨勢、平均日支出、最大支出、儲蓄率與帳戶分布。
- 儲蓄目標：配置金額不會讓資產消失；分開顯示總資產、已配置與可配置資產，並在 client 與 migration 後的 database transaction 兩層阻止超額新增配置。封存目標仍會顯示，可重新啟用，或將原配置標成保留稽核資料的 tombstone 來釋放 earmark；兩台離線裝置釋放同一來源時不會重複釋放。
- 預算：整體或分類預算，支援每週／每月及已用、剩餘、超支狀態。
- 週期收支：收入或支出、每週／每月／每年、開始日、暫停／恢復、截至今日補齊及嚴格冪等去重；單次補登上限 500 筆，超過會整批 fail-closed，不建立交易也不推進游標。
- 可攜資料：完整版本化 JSON 備份、安全合併／明確確認取代還原、匯入容量／筆數防護，以及具穩定欄位的交易 CSV。
- 離線與同步：每位 owner 獨立快照、原子 outbox、重連／手動重試、完整 payload 與最終跨表 graph 驗證、刪除 tombstone 與可見同步錯誤。
- 寫入邊界：client 在建立 outbox 前依 UTF-8 bytes 拒絕無法被 server 接受的欄位；待套用的 additive guard migration 另限制文字、safe monetary magnitude 與每 owner 列數，tombstone 也計入 quota。
- 復原保護：本機快照驗證失敗時停止本機覆寫、所有 UI 新增／修改／刪除、週期補登及遠端 pull/apply，保留原始內容並提供下載；被封鎖的表單會保留輸入且明示未執行，只有整份有效備份完成驗證且新的 owner snapshot 已成功持久化後才解除保護。
- PWA：可安裝 manifest、192/512/maskable icons、Service Worker 預快取與離線殼層。

## 財務語義

```text
帳戶餘額 = 期初餘額 + 該帳戶收入 - 該帳戶支出 + 餘額校正
總資產   = 所有啟用且勾選「納入總資產」帳戶的餘額總和
可配置資產 = 總資產 - 已配置儲蓄
```

- 一般交易一定同時參照分類與帳戶。
- 餘額校正只改變帳戶／總資產，不屬於收入或支出。
- 配置到儲蓄目標只是 earmark，不會降低總資產。
- 封存使用 `isActive=false`；有歷史的帳戶／分類不會被實體刪除。
- 本版本只建模資產帳戶。舊資料中無法確定為資產的 `Card` 等付款方式會保留、標示待確認，且預設不納入總資產。
- 新輸入金額支援至小數點後兩位，且拒絕非有限值或絕對值超過 `100,000,000` 的值；八個 backup collections 各自最多 50,000 筆，因此即使跨所有集合聚合，換算成 minor units 後仍在精確整數範圍內。所有衍生財務加總／比較會先換成兩位小數 minor units 運算，避免 `0.1 + 0.2` 浮點尾差；若內部呼叫端越過完整 domain ceiling，則明確 fail-closed，不會回傳差一分的結果。既有備份／legacy 紀錄支援最多六位小數原值 round-trip，只在衍生計算時四捨五入；更多精度會在還原／remote pull 時隔離並回報，而非靜默改寫。

## 本機開發

需求：Node.js 24、npm 11（CI 同樣使用 Node 24）。

```bash
npm ci
cp .env.example .env.local
npm run dev
```

Windows PowerShell 可用：

```powershell
Copy-Item .env.example .env.local
npm.cmd run dev
```

預設開發網址是 `http://localhost:8888`。未設定 Supabase 時，App 仍能以隔離的訪客離線模式使用。

### 環境變數

| 變數 | 必要性 | 用途 |
| --- | --- | --- |
| `VITE_SUPABASE_URL` | 雲端同步才需要 | Supabase 專案 URL |
| `VITE_SUPABASE_ANON_KEY` | 雲端同步才需要 | 前端可公開的 publishable key 或 legacy anon key |

任何 `VITE_` 變數都會進入瀏覽器 bundle；絕對不要使用 `service_role`、資料庫密碼或 OAuth client secret。`.env` 與 `.env.local` 已被忽略，只追蹤無秘密的 `.env.example`。

Google OAuth 的 Site URL／Redirect URLs 需在 Supabase Dashboard 對應實際預覽與正式網域設定。正式 Site URL 應使用穩定正式網域；本專案的 Vercel Preview 應另加入 project-scoped allowlist `https://shiba-expense-tracker-*-ziv-s-projects3.vercel.app/**`。若缺少這條規則，`redirectTo: window.location.origin` 會被 Supabase 拒絕並 fallback 到 Site URL，使 Preview 登入後跳到舊正式站。

Vercel 的兩個 `VITE_SUPABASE_*` 變數必須同時啟用 **Production and Preview**；只設 Production 會讓 Preview build 在編譯時移除登入／同步能力。Repository 的 `vercel.json` 會為所有部署路由設定 CSP、`nosniff`、referrer、permissions 與 anti-framing headers；CSP 的 Supabase host 已 pin 到本專案，若要部署到另一個 Supabase project，必須同步更新該 allowlist 與測試。

## 驗證命令

```bash
npm run lint               # TypeScript noEmit
npm test                   # Vitest 領域／遷移／同步測試
npm run verify:migration   # 本機 PGlite：DDL、backfill、RLS、重跑、clock
npm run build              # production PWA build
npm audit --audit-level=high
npm run preview
```

CI 位於 `.github/workflows/ci.yml`，在 pull request、`main` 與 `codex/**` push 上執行乾淨安裝、上述檢查及 high/critical dependency gate，不需要任何秘密。

## 資料與同步架構

核心模型位於 `src/domain/`：

- `dateRange.ts`：所有分析與預算共用的本地日曆區間。
- `money.ts`／`financeEngine.ts`／`budgetEngine.ts`：minor-unit 金額運算與純函式財務推導。
- `recurrence.ts`／`recurringSafety.ts`：以 rule ID + occurrence date 產生固定 ID；月底採夾限但保留原 anchor，並對大量 catch-up 與失效 parent fail-closed。
- `backup.ts`／`legacyMigration.ts`：全量驗證、owner／關聯完整性及 repeat-safe 舊資料轉換。
- `syncEngine.ts`：`snapshot / operation queue / reconcile` 深層模組；衝突先比 `version`，再以 `lastOperationId` 決定。
- `src/data/supabaseRemote.ts`：唯一雲端 adapter，會再次驗證目前登入 owner；每個 query 同時受明確 `user_id` 篩選與 RLS 保護。

本機 key 格式為 `shiba-finance:v3:guest` 或 `shiba-finance:v3:user:<uuid>`。登入不會把訪客資料靜默合併；只有使用者按下「匯入此帳號」時，才會 remap 所有 ID 與關聯後加入該帳號。每位登入 owner 對 guest snapshot 的「匯入／保持分離」決策以不含財務值的指紋記住；同一快照不會反覆提示或重匯。若後續訪客快照與已匯入的同來源紀錄內容不同，整次匯入會原子中止、顯示衝突數量且不記為已處理；登入端紀錄不會被靜默覆寫。匯入時必須先成功寫入 owner snapshot 才會記住該指紋；quota／storage 失敗不會把尚未落盤的匯入藏起來，復原保護中的帳號也禁止匯入覆寫。

若升級時發現舊版的 authenticated owner cache，App 會先以 **0 apply** 拉取並驗證完整雲端 graph；候選快取不會被自動排入 outbox。遠端讀取成功後，使用者可先下載候選 JSON，再明確選擇「匯入舊版本機資料」或「保留雲端資料」。遠端 pull 有錯、owner 不符或 graph 不完整時會維持 pending gate，期間禁止本機 mutation，但保留手動重試同步。

離線 create/update/delete 會把最新 record snapshot 與 operation ID 一起寫入 owner 快照。刪除保留 tombstone；雲端 trigger 和 client 都先以 `(version, lastOperationId)` 檢查 stale write，再比較完整 app-owned payload。相同 clock 但內容不同、或遠端在仍有 pending local edit/delete 時勝出，會成為可見且保留待處理的衝突，不會假裝成功；單筆 malformed、foreign-owner、非正交易金額、不安全數值、跨表引用遺失／型別不符或其他違反 domain 契約的 remote row 會被隔離並回報，其他合法 rows 仍能同步。每個 monetary column 會另外以 PostgREST `numeric::text` projection 取得原始 decimal，再轉成 JavaScript number，避免 JSON parser 先降精度後逃過檢查。同步等待期間的新本機操作會 rebase 到結果上，登出或切換 owner 後回來的舊同步結果會被丟棄；登出只切換驗證狀態，不會刪除 owner cache 或訪客資料，避免跨分頁競態造成未同步資料遺失。v3 Data API 請求會送出非秘密的 `x-shiba-finance-client: v3` capability header，以便 owner 在 RLS 下拉取 tombstone／封存列；此 header 不是身分驗證邊界。

## Supabase migration

Migrations（依時間順序）：

1. `supabase/migrations/20260821103249_finance_v3_additive_schema.sql` — v3 additive schema／backfill／RLS／mixed-version bridge；已套用 production。
2. `supabase/migrations/20260824023801_finance_resource_abuse_guards.sql` — future-write UTF-8 text、safe numeric 與 per-owner row guards；已在本機驗證，尚未獲授權套用 production。

它會：

1. 保留既有 transactions/goals/subscriptions/budgets 與所有 legacy 字串欄位。
2. 新增 accounts、categories、adjustments、savings_allocations、recurring_rules、settings。
3. 以 UTF-8 base64url 的 owner-aware 穩定 ID 回填帳戶與分類，不改交易金額、類型、文字日期或擁有者。
4. 將 goal `current_amount` 轉成一筆可稽核且可重跑的 allocation；原值仍保留供舊 client／rollback 讀取。
5. 將合法 subscription 從 migration 當日之後轉成月週期規則，不捏造過去期數；migration 後的舊 client 新增／修改會同步規則，變成無效內容時會 fail-closed 停用規則，修正後可安全恢復。
6. 將 legacy 四表的全域 `PRIMARY KEY(id)` 安全轉為 `(user_id,id)`；若發現未知 incoming FK 會讓整筆 migration rollback，不會 cascade/drop 外部依賴。
7. 新增 owner 複合關聯、user indexes、recurring occurrence 唯一索引、future-write checks 與嚴格 conflict-clock trigger。
8. 提供雙向 mixed-version bridge：舊 client 新增／修改 transaction、budget 仍會補齊 v3 關聯；舊 goal `current_amount` 變更會原子產生 allocation delta，v3 allocation 也會原子回寫 rollback-readable legacy total；舊 subscription 與可表示的 v3 monthly rule 會雙向投影，暫停／封存 parent 會在同一 transaction 停用 schedule；四張 legacy 表的實體刪除會轉為 owner-scoped tombstone。
9. 以 owner-scoped advisory transaction lock 與 server ledger sum 阻止兩台裝置合計超額配置；allocation 的目標／金額／發生日是不可改寫的稽核事件，修正以新 delta 表示，且新操作不得讓單一目標淨配置變成負數；active recurring rule 只有在同 owner 的 active account 與相符 category 存在時才可建立／恢復，既有分類的收入／支出型別也不可直接改寫而破壞規則語義。
10. 重建所有財務表 policy 為 `TO authenticated`、`(select auth.uid()) = user_id`，撤銷 anon/public table privileges，再按用途明確授權：四張 legacy 表保留受 trigger 保護的 `DELETE` 以建立 tombstone，v3-only 表只開放 `SELECT/INSERT/UPDATE`，不可用實體刪除繞過稽核資料；headerless 舊 client 不會把 tombstone／封存列重載成 live data，v3 owner 仍可完整 reconcile；未來 public table/function/sequence 預設採 opt-in grants。

第二支 migration 另外以 revoke-execute 的 `SECURITY DEFINER` trigger 計算完整 owner row count，避免 headerless legacy RLS 隱藏 tombstone 後繞過 quota；dynamic table target 是固定 allowlist。所有 checks 採 `NOT VALID`，不會掃描或重寫既有列，但會限制之後 INSERT／UPDATE。若 preflight 發現既有超限列，必須先備份並建立明確縮短／保留規則；不可直接套用後讓該列無法更新。

### Production 狀態與下一支 migration gate

2026-08-24 已確認 production 外部備份位於 repository 之外，並已套用第一支 `finance_v3_additive_schema`。套用後證據：43 筆 transactions、1 筆 goal，v3 tables／34 owner policies／RLS 存在，missing relation 與 orphan count 均為 0，舊 production frontend 仍可運作。未執行資料刪除或 reinterpretation。

第二支 guard migration **尚未套用 production**。2026-08-24 唯讀 preflight 對目前非空表的所有對應文字與 numeric 欄得到 0 violations，owner row maxima 也低於 quota；正式套用仍需要使用者另行授權。獲授權後必須：

1. 確認現有外部 backup／PITR 仍是可用 restore point，並記錄 migration 前 row counts。
2. 再跑文字、numeric、quota preflight；任何 violation 都先停止並設計資料保留修復。
3. 執行 `npm run verify:migration` 與 migration review。
4. 只透過 reviewed Supabase migration workflow 套用；不要把 DB 密碼寫入 repository。
5. 套用後重跑 row/orphan/RLS、PostgREST authenticated write rejection 與 Supabase security/performance advisors。

詳細 schema rollback／前向修復流程見 `supabase/ROLLBACK.md`。Migration 以資料保留及向後相容為原則：舊版 client 所需欄位仍在，但會把 legacy 全域主鍵改為 owner-scoped 複合主鍵並收緊權限。若新 client 需緊急回退，可先回退前端而不立即刪除 v3 欄表或撤回安全 constraint。不要在沒有 backup 的情況下執行 destructive down migration。

## 備份與還原

- JSON backup schema 與本機 envelope 分開版本化，目前 backup `schemaVersion=1`。
- 預設「安全合併」依 ID、version、時間與 operation identity 決定，不會重複加入相同紀錄。
- 「取代目前資料」必須選擇 replace 並輸入 `REPLACE`；整份資料會先驗證，失敗不會部分修改。登入狀態下的還原會把舊備份 rebase 成高於目前本機 clock 的新 mutations，而非重送過期版本。
- 還原會驗證 owner、所有 stable references、分類型別、正數／非零 delta／安全範圍金額、date-only recurrence/occurrence、唯一 ID、週期 anchor、單一 collection 最多 50,000 筆，以及最多 5,000,000 UTF-8 位元組的 JSON 輸入。匯出也使用相同位元組上限；若現有資料已大到無法產生可重新匯入的備份，會明確拒絕而不是下載一份無法 round-trip 的檔案，中文與 Emoji 也不會因字元／檔案大小單位不同而產生假成功。
- JSON 字串匯入會使用標準 `JSON.parse` reviver 的 raw `context.source` 驗證 monetary token；不支援此 2025 baseline API 的舊瀏覽器會明確拒絕還原並要求更新，不會先轉成 `number` 後靜默接受已降精度值。
- CSV 是匯出用途，會做 RFC 4180 escaping 與 spreadsheet formula neutralization；本版本不提供 CSV import。

## 已知限制與非目標

- 第二支 server resource guard migration 尚未獲授權套用 production；目前正式 schema 已是 v3，但 server 端 text/numeric/quota 新防護仍以既有 PostgREST／平台限制為主。
- 套用第二支 guard 後，兩台裝置若同時在相同 owner／entity 的配額前一筆離線新增，後到 server 的操作可能收到 `54000` 並保留在 pending outbox。由於 tombstone 也計入安全配額，刪除該本機紀錄不能自動釋放 server row；請先下載 JSON 備份並保留 pending snapshot，再由維護者唯讀核對該 ID 未上雲、建立獨立資料庫備份，最後以經審查的 quota 擴充或資料保留修復解除，不能直接清除 outbox 假裝同步成功。
- 最新 Preview 已完成本機資料的新增、編輯、重新載入持久化與分析聚合 E2E，live CSP／HSTS／anti-framing 等 headers 亦已確認；但 production Supabase 尚未加入上述 Preview Redirect URL allowlist，因此 Preview Google OAuth 仍會 fallback 到舊 Site URL，是發布前 High 外部設定 blocker。相同 release candidate 已透過已允許的 `http://127.0.0.1:8888` 在兩個獨立瀏覽器 session 完成真實 Google OAuth、保持訪客資料分離、拉取既有 43 筆 transactions 並收斂為「已同步」；未新增、編輯或刪除任何 production 財務紀錄。真實雲端 edit/delete、離線重連不復活仍留待 allowlist 修正後 smoke；owner 隔離、retry、衝突與 tombstone 已由 adapter／engine／PGlite RLS 測試覆蓋。
- Migration 已在本機 PGlite 覆蓋 fresh、legacy、重跑、RLS、mixed-version bridge、conflict clock 與 resource guards；第一支已在真實 production schema 執行並通過 row/orphan/RLS 核對，第二支尚未執行真實 PostgREST rejection smoke。
- Supabase Security Advisor 仍有「Leaked Password Protection Disabled」既存警告；應依 [Supabase password security 指南](https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection)於 Auth 設定啟用並重跑 advisor。
- 週期交易由 client 在開啟、回到前景或跨日後補齊，不是背景排程服務；長期不開 App 時會在下次開啟補齊。
- 訪客資料使用 browser localStorage，仍受瀏覽器清除資料與 quota 影響；應定期下載 JSON 備份。
- 柴犬／米克斯視覺主題是裝置本機偏好，不跨裝置同步。
- 不支援轉帳、多幣別、信用卡帳單／債務、銀行串接、OCR、AI 顧問、CSV import 或共享家庭帳本。

## 回復與復原

- 任務前遠端 checkpoint：`checkpoint/20260821-180842-before-autonomous-build`，SHA `56df3f31d2a3c7b93954faef9c352859c8f1f3d5`。
- 中斷續作前遠端 checkpoint：`checkpoint/20260823-105721-before-resume-interrupted-build`，SHA `ba3e5de15a83cf314c3a3a64a7fc3580fd625fee`。
- 本次 production E2E release gate 前 checkpoint：`checkpoint/20260824-101753-before-production-e2e-release-gate`，SHA `5fb688f32cdaa54d0734de6b28d1b59cbde6516f`。
- 程式碼回復：只撤銷本次 release-gate 修補時從最新 checkpoint 建立 recovery branch；回到整個建置前則使用最早 checkpoint。三個 tag 均已推送；不要改寫／刪除 checkpoint history。
- 使用者資料回復：優先使用管理頁的 JSON backup 安全合併／明確取代。
- Database：第一支 v3 additive migration 已在外部 backup 後套用；第二支 guard migration未套用。Schema 回復與 additive forward-fix 依 `supabase/ROLLBACK.md`，不可把 Git tag 當作 database backup。
