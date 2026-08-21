# Expense Tracker v3 — 品質認證

日期：2026-08-21  
分支：`codex/expense-tracker-autonomous-build`  
任務前復原點：`checkpoint/20260821-180842-before-autonomous-build` / `56df3f31d2a3c7b93954faef9c352859c8f1f3d5`

## 結論

目前評分：**9.2 / 10**。這不是 10/10：已審查的 Supabase migration 尚未在真實 staging／PostgREST 執行，登入後的雙裝置同步也尚未做瀏覽器端端到端觀察。領域邏輯、本機遷移 harness、訪客產品流程、PWA 離線殼層、復原保護與資料完整性規則已有可重現證據。

| 項目 | 權重 | 得分 | 證據／缺口 |
| --- | ---: | ---: | --- |
| 功能與產品正確性 | 25 | 24 | 規格內帳戶、分類、分析、目標、預算、週期、備份與同步介面均完成；核心行動版流程已實測。 |
| 財務與資料完整性 | 20 | 19 | 共用日曆引擎、帳本餘額、校正、配置不變量、穩定 legacy ID、還原驗證及 mixed-version bridge 均有測試。 |
| 同步與離線可靠性 | 15 | 13.5 | CRUD retry、tombstone、完整 payload 衝突、malformed row 隔離與 PWA 離線重載已驗證；缺真實雙裝置 E2E。 |
| 安全、隱私與遷移 | 15 | 13 | owner-scoped adapter、RLS／grants migration 與 PGlite RLS 測試通過；production migration 等待獨立 DB 備份與 staging。 |
| 自動測試與 CI | 10 | 9 | 乾淨安裝與所有本機門檻通過，GitHub Actions 已加入；Draft PR 建立後仍須取得遠端綠燈。 |
| UX、行動版與 PWA | 10 | 9 | 390×844 核心流程、無水平溢位、manifest、受控 Service Worker、離線重載與一般流程零 console 訊息通過；裝置矩陣有限。 |
| 維護性與文件 | 5 | 4.5 | 深層 domain seams、版本化 migration、README、CI 與 rollback 手冊齊全；部分 UI panel 仍偏大。 |
| **合計** | **100** | **92** | **9.2 / 10** |

## 自動化證據

在 Vite 驗證程序完全停止後，以鎖定檔重建依賴並執行：

- `npm ci`：394 packages 成功安裝；audit 結果 0 vulnerabilities。
- `npm run lint`：TypeScript `--noEmit` 通過。
- `npm test`：13 個 test files、102 個 tests 全數通過。
- `npm run verify:migration`：9 組 PGlite 驗證全數通過，涵蓋 fresh/retry-safe DDL、future default grants、future-write checks、deterministic backfill、v3 goal UPSERT 保護、mixed-version bridge、goal allocation audit、RLS owner isolation、stale clock，以及 exact retry／same-clock divergent payload 拒絕。
- `npm run build`：Vite 8.2.2 production PWA build 通過；主 chunk 494.38 kB（gzip 143.94 kB），PWA precache 13 entries／572.66 KiB。
- `npm audit --audit-level=moderate`：0 vulnerabilities；因此亦滿足 CI 的 `--audit-level=high` gate。

## 瀏覽器與 PWA 證據

以 production preview、全新 Playwright session、390×844 viewport 執行：

1. 建立 `街口支付`，期初餘額 $1,000；總資產與可配置資產都成為 $1,000。
2. 新增 $20 現金支出與 $30 `街口支付` 支出；總資產成為 $950，現金為 -$20，`街口支付` 為 $970，兩筆歷史帳本均指向正確帳戶。
3. Insights 在第一筆支出後顯示今日支出 $20、淨收支 -$20、餐飲 $20 與總資產 $980。
4. 將 `餐飲` 改名／換圖示為 `外食`／🥢後封存；兩筆歷史交易仍顯示新名稱、圖示、原帳戶與金額，新增表單不再列出該封存分類。
5. 金額 `0.005` 被拒絕並顯示「最多兩位小數」；`0.5` 成功記帳，月平均每日支出顯示 `$0.02`，未出現冗長浮點尾數。
6. 自訂日期清空開始日後顯示 `請同時選擇開始日與結束日。`，頁面未白屏。
7. 390px viewport 的 `scrollWidth` 與 `clientWidth` 同為 390；一般流程 console 為 0 errors、0 warnings。
8. Service Worker scope 為 preview root 且控制頁面；強制離線後仍可重新載入並保留本機財務狀態。
9. 將 `shiba-finance:v3:guest` 寫入損毀 JSON 後，App 顯示復原保護與原始快照下載，停止 autosave；重新讀取 key 仍是原始 `{broken-json`。此故障路徑為 0 errors、2 個預期 recovery warnings。

## 資料遷移認證

- 本機 legacy migration 保留 transaction amount/type/date/category/account/note、owner、goal、budget 與 subscription 語義。
- 產生的 ID 具 owner namespace，對重跑、輸入重排、duplicate 與 explicit/generated collision 保持穩定。
- 已知現金／電子錢包會納入資產；無法確認的 `Card` 類舊付款方式仍保留關聯，但標記待確認且預設排除總資產。
- 舊 goal `current_amount` 轉為單一 deterministic allocation；retry 不會重複累計，v3 UPSERT 不會抹除 legacy total/unit。
- 舊 subscription 只從 migration cutover 當日後建立週期規則，不捏造過往發生紀錄。
- SQL 採 additive schema，保留 rollback 所需 legacy fields；production 執行刻意未做，因 Git checkpoint 不是資料庫備份。

## 獨立審查與修補

- 正確性／資料完整性審查修正：custom range 白屏、overall budget round-trip、adjustment audit history、local-date trend、日期 reference 更新與輸入空值。
- 安全／隱私審查修正：strict grants/default privileges、future-write checks、mixed-version bridge、goal allocation audit、same-clock divergent payload、owner verification 與 v3 goal legacy-field 保護。
- 對抗式／UX 審查修正：完整 persisted payload 驗證、malformed/foreign row 隔離、unresolved conflict 重排、guest import fingerprint、owner switch stale-result 防護、損毀快照 fail-closed 與封存影響提示。
- 上述修補後已重跑完整自動化與 production browser smoke；目前沒有已知可在此範圍合理修復的 blocking finding。

## 剩餘限制與發布門檻

1. 取得獨立 production database backup，並證明可還原。
2. 在 Supabase branch／staging 套用 migration，核對 owner/row counts，走 PostgREST HTTP 整合並重跑 security/performance advisors。
3. 經另行授權後才可套用 production migration；完成後再做真實 Google OAuth 與兩裝置同步 smoke。
4. Draft PR GitHub Actions 必須綠燈後才符合 merge gate；本文件會在 PR 建立後補上遠端結果。
5. CSV import、轉帳、多幣別、信用卡／債務模型皆是明確非目標。

## 回滾

- 程式碼：從 `checkpoint/20260821-180842-before-autonomous-build`（`56df3f31d2a3c7b93954faef9c352859c8f1f3d5`）建立 recovery branch，或重新部署該已推送 SHA；不可 force-push 或刪除 checkpoint tag。
- 本機使用者資料：使用管理頁的版本化 JSON backup；replace 必須明確選擇並輸入 `REPLACE`。
- Supabase：本次未執行 production migration。未來 rollout 應使用獨立的 migration 前 DB backup，或採 `supabase/ROLLBACK.md` 的 additive forward-fix；不得臨時採用 destructive down migration。
