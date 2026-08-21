# 柴柴極速記帳

柴犬主題、行動裝置優先的個人財務 PWA。它把「錢花在哪裡（分類）」與「錢從哪個帳戶進出（資產帳戶）」分開記錄，並以帳本推導總資產；訪客可完全離線使用，登入後可透過 Supabase 做擁有者隔離的跨裝置同步。

## 目前功能

- 資產帳戶：建立、改名、任意 Emoji／通用向量圖示、期初餘額、啟用／封存、是否納入總資產。
- 收支分類：收入與支出分開、穩定 ID、改名／換圖示／封存後仍可解析歷史交易。
- 日常帳本：收入、支出、帳戶、分類、時間、備註，以及可編輯與 tombstone 刪除。
- 餘額校正：留下獨立可稽核調整紀錄，不混入收入、支出、儲蓄率或預算。
- 財務分析：今日快照、本週（週一至週日）、本月、本年、自訂含結束日、前期比較、分類組成、支出趨勢、平均日支出、最大支出、儲蓄率與帳戶分布。
- 儲蓄目標：配置金額不會讓資產消失；分開顯示總資產、已配置與可配置資產，並阻止超額新增配置。
- 預算：整體或分類預算，支援每週／每月及已用、剩餘、超支狀態。
- 週期收支：收入或支出、每週／每月／每年、開始日、暫停／恢復、截至今日補齊及嚴格冪等去重。
- 可攜資料：完整版本化 JSON 備份、安全合併／明確確認取代還原、匯入容量／筆數防護，以及具穩定欄位的交易 CSV。
- 離線與同步：每位 owner 獨立快照、原子 outbox、重連／手動重試、完整 payload 衝突檢查、刪除 tombstone 與可見同步錯誤。
- 復原保護：本機快照驗證失敗時停止自動覆寫、保留原始內容並提供下載；有效備份還原後才恢復儲存。
- PWA：可安裝 manifest、192/512/maskable icons、Service Worker 預快取與離線殼層。

沒有 AI／Gemini 功能或依賴。

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
- 新輸入金額支援至小數點後兩位，且拒絕非有限值與超出 JavaScript 安全數值範圍的值；畫面採相同精度顯示。

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

Google OAuth 的 Site URL／Redirect URLs 需在 Supabase Dashboard 對應實際預覽與正式網域設定。

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
- `financeEngine.ts`／`budgetEngine.ts`：純函式財務推導。
- `recurrence.ts`：以 rule ID + occurrence date 產生固定 ID；月底採夾限但保留原 anchor。
- `backup.ts`／`legacyMigration.ts`：全量驗證、owner／關聯完整性及 repeat-safe 舊資料轉換。
- `syncEngine.ts`：`snapshot / operation queue / reconcile` 深層模組；衝突先比 `version`，再以 `lastOperationId` 決定。
- `src/data/supabaseRemote.ts`：唯一雲端 adapter，會再次驗證目前登入 owner；每個 query 同時受明確 `user_id` 篩選與 RLS 保護。

本機 key 格式為 `shiba-finance:v3:guest` 或 `shiba-finance:v3:user:<uuid>`。登入不會把訪客資料靜默合併；只有使用者按下「匯入此帳號」時，才會 remap 所有 ID 與關聯後加入該帳號。每位登入 owner 對 guest snapshot 的「匯入／保持分離」決策以不含財務值的指紋記住；同一快照不會反覆提示或重匯，已存在的登入端紀錄也不會被 guest 重匯覆寫。

離線 create/update/delete 會把最新 record snapshot 與 operation ID 一起寫入 owner 快照。刪除保留 tombstone；雲端 trigger 和 client 都先以 `(version, lastOperationId)` 檢查 stale write，再比較完整 app-owned payload。相同 clock 但內容不同會成為可見、保留待處理的衝突，不會假裝成功；單筆 malformed/foreign remote row 會被隔離並回報，其他合法 rows 仍能同步。同步等待期間的新本機操作會 rebase 到結果上，登出或切換 owner 後回來的舊同步結果會被丟棄。

## Supabase migration

Migration：`supabase/migrations/20260821103249_finance_v3_additive_schema.sql`

它會：

1. 保留既有 transactions/goals/subscriptions/budgets 與所有 legacy 字串欄位。
2. 新增 accounts、categories、adjustments、savings_allocations、recurring_rules、settings。
3. 以 UTF-8 base64url 的 owner-aware 穩定 ID 回填帳戶與分類，不改交易金額、類型、文字日期或擁有者。
4. 將 goal `current_amount` 轉成一筆可稽核且可重跑的 allocation；原值仍保留供舊 client／rollback 讀取。
5. 將合法 subscription 從 migration 當日之後轉成月週期規則，不捏造過去期數；不合法資料保留並標示待確認。
6. 新增 owner 複合關聯、user indexes、recurring occurrence 唯一索引、future-write checks 與嚴格 conflict-clock trigger。
7. 提供 mixed-version bridge：migration 後舊 client 新增／修改 transaction、budget 仍會補齊 v3 關聯；舊 goal `current_amount` 變更會原子產生 allocation delta；v3 goal UPSERT 不會覆寫 rollback 用 legacy total/unit。
8. 重建所有財務表 policy 為 `TO authenticated`、`(select auth.uid()) = user_id`，撤銷 anon/public table privileges，再明確授予 authenticated CRUD；未來 public table/function/sequence 預設採 opt-in grants。

### 正式套用前必要步驟

目前 repository 只包含已驗證 migration，**尚未套用 production**。正式執行前必須：

1. 取得獨立、可還原的 production database backup（不可只依賴 Git tag）。
2. 先在 staging／Supabase branch 以 production-like schema 驗證並記錄 row counts。
3. 執行 `npm run verify:migration` 與 migration review。
4. 透過 Supabase CLI 的 reviewed migration workflow 套用；不要把 DB 密碼寫入 repository。
5. 套用後比對 owner/row counts、抽樣 legacy 關聯，並重新跑 Supabase security/performance advisors。

詳細 schema rollback／前向修復流程見 `supabase/ROLLBACK.md`。Migration 是 additive，舊版 client 所需欄位仍在；若新 client 需緊急回退，可先回退前端而不立即刪除 v3 欄表。不要在沒有 backup 的情況下執行 destructive down migration。

## 備份與還原

- JSON backup schema 與本機 envelope 分開版本化，目前 backup `schemaVersion=1`。
- 預設「安全合併」依 ID、version、時間與 operation identity 決定，不會重複加入相同紀錄。
- 「取代目前資料」必須選擇 replace 並輸入 `REPLACE`；整份資料會先驗證，失敗不會部分修改。登入狀態下的還原會把舊備份 rebase 成高於目前本機 clock 的新 mutations，而非重送過期版本。
- 還原會驗證 owner、所有 stable references、分類型別、正數／安全範圍金額、日期、唯一 ID、週期 anchor、單一 collection 最多 50,000 筆，以及最多 5,000,000 字元的 JSON 輸入。
- CSV 是匯出用途，會做 RFC 4180 escaping 與 spreadsheet formula neutralization；本版本不提供 CSV import。

## 已知限制與非目標

- Production schema migration 尚未執行；在套用前，這個分支的 v3 雲端同步不能對舊 schema 完整運作。
- 未在真實登入的兩台裝置執行 browser E2E；owner 隔離、retry、衝突與 tombstone 由自動化 adapter／engine／RLS 測試覆蓋。
- Migration 已在本機 PGlite 覆蓋 fresh、legacy、重跑、RLS、mixed-version bridge 與 conflict clock，但尚未在真實 Supabase/PostgREST staging 走 HTTP 整合。
- 週期交易由 client 在開啟、回到前景或跨日後補齊，不是背景排程服務；長期不開 App 時會在下次開啟補齊。
- 訪客資料使用 browser localStorage，仍受瀏覽器清除資料與 quota 影響；應定期下載 JSON 備份。
- 柴犬／米克斯視覺主題是裝置本機偏好，不跨裝置同步。
- 不支援轉帳、多幣別、信用卡帳單／債務、銀行串接、OCR、AI 顧問、CSV import 或共享家庭帳本。

## 回復與復原

- 任務前遠端 checkpoint：`checkpoint/20260821-180842-before-autonomous-build`，SHA `56df3f31d2a3c7b93954faef9c352859c8f1f3d5`。
- 程式碼回復：從該 tag 建立新 recovery branch，或在保留本分支後部署該已推送 SHA；不要改寫／刪除 checkpoint history。
- 使用者資料回復：優先使用管理頁的 JSON backup 安全合併／明確取代。
- Database：目前沒有 production mutation；未來套用 migration 時，依 `supabase/ROLLBACK.md` 使用事前獨立備份或 additive forward-fix。
