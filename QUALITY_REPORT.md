# Expense Tracker v3 — 品質認證

- 日期：2026-08-24
- 分支：`codex/expense-tracker-autonomous-build`
- 任務前復原點：`checkpoint/20260821-180842-before-autonomous-build` / `56df3f31d2a3c7b93954faef9c352859c8f1f3d5`
- 中斷續作復原點：`checkpoint/20260823-105721-before-resume-interrupted-build` / `ba3e5de15a83cf314c3a3a64a7fc3580fd625fee`
- Production E2E release gate 復原點：`checkpoint/20260824-101753-before-production-e2e-release-gate` / `5fb688f32cdaa54d0734de6b28d1b59cbde6516f`
- v3 production release 前復原點：`checkpoint/20260824-1158-before-v3-production-release` / `a1d3ebfd45f9a9f4fb7451ee6dc123bfe18ef643`

## 結論

目前 release candidate 評分：**9.3 / 10**，但發布判定是 **No-Go（外部 OAuth 設定 blocker）**。這不是 10/10：第一支 Supabase migration、獨立 backup、production 資料完整性核對、最新 Preview 本機 CRUD、兩個獨立 session 的真實 Google OAuth 唯讀同步與 live headers 均已完成；然而 production Supabase 尚未允許 Vercel Preview Redirect URL，Preview 登入會 fallback 到舊 Site URL。第二支 server resource guard 仍未獲授權套用，正式 Codex Security Standard Scan 也受 Windows `cp950` launcher 問題阻擋。領域邏輯、本機 migration harness、production v3 schema、PWA 離線殼層、復原保護與資料完整性規則已有可重現證據。

| 項目 | 權重 | 得分 | 證據／缺口 |
| --- | ---: | ---: | --- |
| 功能與產品正確性 | 25 | 24 | 規格內帳戶、分類、分析、目標、預算、週期、備份與同步介面均完成；核心行動版流程已實測。 |
| 財務與資料完整性 | 20 | 19 | 共用日曆引擎、帳本餘額、校正、配置不變量、穩定 legacy ID、還原驗證及 mixed-version bridge 均有測試。 |
| 同步與離線可靠性 | 15 | 13.5 | CRUD retry、tombstone、完整 payload 衝突、malformed row 隔離、PWA 離線重載及兩個獨立 browser session 的真實 OAuth pull 已驗證；Preview Redirect allowlist 與真實雲端 edit/delete/reconnect 尚缺。 |
| 安全、隱私與遷移 | 15 | 13.5 | owner-scoped adapter、production RLS／grants migration、PGlite RLS、保留式登出、CSP 與 resource guard 測試通過；第二支 guard 待授權及正式 scan。 |
| 自動測試與 CI | 10 | 9 | 乾淨安裝與所有本機門檻通過；Draft PR 最新 commit 的兩個 GitHub Actions verify 與 Vercel checks 全數綠燈。 |
| UX、行動版與 PWA | 10 | 9 | 390×844 核心流程、無水平溢位、manifest、受控 Service Worker、離線重載與一般流程零 console 訊息通過；裝置矩陣有限。 |
| 維護性與文件 | 5 | 4.5 | 深層 domain seams、版本化 migration、README、CI 與 rollback 手冊齊全；部分 UI panel 仍偏大，日期驗證內仍有可整理的低風險重複。 |
| **合計** | **100** | **93** | **9.3 / 10** |

## 自動化證據

在 Vite 驗證程序完全停止後，以鎖定檔重建依賴並執行：

- `npm ci`：394 packages 成功安裝；audit 結果 0 vulnerabilities。
- `npm run lint`：TypeScript `--noEmit` 通過。
- `npm test`：28 個 test files、189 個 tests 全數通過；除既有財務／日期／同步／復原案例外，新增 UTF-8 multibyte、safe monetary／legacy precision write limits、精確聚合 fail-closed、authenticated restore、owner quotas 與 security header config。
- `npm run verify:migration`：12 組 PGlite 驗證全數通過；除既有 fresh/retry-safe DDL、backfill、mixed-version、RLS 與 conflict clock 外，新增 70 個 text checks、9 個 numeric checks、9 個 quota triggers、unsafe numeric 拒絕、滿額精確 UPSERT、跨 owner 配額及 legacy RLS 隱藏 tombstone 仍計入 quota。
- `npm run build`：Vite 8.2.2 production PWA build 通過且沒有 chunk-size warning；app 主 chunk 312.93 kB（gzip 97.82 kB）、Supabase vendor 208.11 kB（gzip 53.77 kB），PWA precache 14 entries／603.19 KiB。
- `npm audit --audit-level=moderate`：0 vulnerabilities；因此亦滿足 CI 的 `--audit-level=high` gate。

## 瀏覽器與 PWA 證據

以 production preview、全新 Playwright session、390×844 viewport 執行完整探索流程及最終修補後 smoke：

1. 建立 `街口支付`，期初餘額 $1,000；總資產與可配置資產都成為 $1,000。
2. 新增 $20 現金支出與 $30 `街口支付` 支出；總資產成為 $950，現金為 -$20，`街口支付` 為 $970，兩筆歷史帳本均指向正確帳戶。
3. Insights 在第一筆支出後顯示今日支出 $20、淨收支 -$20、餐飲 $20 與總資產 $980。
4. 將 `餐飲` 改名／換圖示為 `外食`／🥢後封存；兩筆歷史交易仍顯示新名稱、圖示、原帳戶與金額，新增表單不再列出該封存分類。
5. 金額 `0.005` 被拒絕並顯示「最多兩位小數」；`0.5` 成功記帳，月平均每日支出顯示 `$0.02`，未出現冗長浮點尾數。
6. 自訂日期清空開始日後顯示 `請同時選擇開始日與結束日。`，頁面未白屏。
7. 390px viewport 的 `scrollWidth` 與 `clientWidth` 同為 390；一般流程 console 為 0 errors、0 warnings。
8. Service Worker scope 為 preview root 且控制頁面；強制離線後仍可重新載入並保留本機財務狀態。
9. 將 `shiba-finance:v3:guest` 寫入損毀 JSON 後，App 顯示復原保護與原始快照下載，停止 autosave；重新讀取 key 仍是原始 `{broken-json`。此故障路徑為 0 errors、2 個預期 recovery warnings。
10. 最終 production bundle 以 390×844 行動版 override 建立 $0.1 與 $0.2 餐飲支出，首頁／Insights 均精確顯示 $0.3／-$0.3，極大兩位小數輸入未新增交易；瀏覽內容區 `scrollWidth`／`clientWidth` 同為 375、無水平溢位，週期頁顯示 500 筆整批上限，Service Worker 受控，正常 console 0 errors／0 warnings，強制離線重載後仍保留帳本。另一個全新 session 另證明損毀 raw key 原樣保留，為 0 errors／2 個預期 warnings。
11. 最新 Vercel Preview `shiba-expense-tracker-vcy7rrchl-ziv-s-projects3.vercel.app` 載入 production bundle，Supabase env 存在；實際 response 為 200，CSP pin 到正式 Supabase host，HSTS、`nosniff`、strict referrer、permissions policy 與 anti-framing headers 均生效。
12. 該 Preview 的 guest origin 建立 $1.23 測試支出、重新載入後保留，再編輯為 $2.34；首頁餘額與分析的今日／期間／分類／趨勢數值同步更新。這筆 synthetic record 只存在於該 ephemeral Preview origin 的本機儲存，未送入 production Supabase。
13. Preview Google OAuth 實測會導向舊 Site URL；程式已送 `redirectTo: window.location.origin`，根因是 Supabase production Redirect URL allowlist 未包含 Preview hostname。依官方 wildcard 規則，需加入 `https://shiba-expense-tracker-*-ziv-s-projects3.vercel.app/**` 後重測。
14. 相同 release candidate 透過已允許的 `http://127.0.0.1:8888`，分別在 Codex in-app Browser 與 Chrome 兩個獨立 session 完成 Google OAuth；兩者都明確選擇保持訪客資料分離，從待同步收斂到「已同步」，並讀到相同 43 筆 production transaction rows；UI 顯示 39 筆 active 帳本項目，第一批之後可再載入其餘 9 筆 active 歷史。交易、目標與配置筆數前後未變；console 無 error，僅有 `gotrue-js` 對約 1–2 秒時鐘差的非阻斷 warning。

## 資料遷移認證

- 本機 legacy migration 保留 transaction amount/type/date/category/account/note、owner、goal、budget 與 subscription 語義。
- 產生的 ID 具 owner namespace，對重跑、輸入重排、duplicate 與 explicit/generated collision 保持穩定。
- 已知現金／電子錢包會納入資產；無法確認的 `Card` 類舊付款方式仍保留關聯，但標記待確認且預設排除總資產。
- 舊 goal `current_amount` 轉為單一 deterministic allocation；retry 不會重複累計，v3 UPSERT 不會抹除 legacy total/unit。
- 舊 subscription 只從 migration cutover 當日後建立週期規則，不捏造過往發生紀錄。
- SQL 採資料保留、向後相容演進，保留 rollback 所需 legacy fields，並把 legacy 全域 `id` 主鍵改為 owner 複合主鍵；未知 incoming FK 會整筆 rollback。第一支 production migration 在 repository 外獨立 backup 後完成。
- 2026-08-24 production 最新核對：migration history 只含 `20260821103249 finance_v3_additive_schema`；43 transactions、1 goal、5 accounts、16 categories、2 settings，transaction account/category orphan 均為 0，10 張 user-scoped table 全部 RLS enabled、34 owner policies；舊 production frontend 仍可運作。
- 第二支 resource guard 未套 production。正式唯讀 preflight 對目前非空表的 text/numeric checks 得到 0 violations，各 owner count 低於 quota；它仍需另行授權與套用後 PostgREST rejection smoke。
- 即使 client 先檢查 owner ceiling，兩台裝置在配額邊界同時離線新增仍可能讓後到者收到 server `54000` 並永久 pending；tombstone 列也計 quota，因此使用者端刪除不是安全復原。README 已記錄先備份、唯讀核對與經審查的 server-side recovery 路徑；目前沒有會靜默丟棄 local-only 財務列的按鈕。

## 獨立審查與修補

- 正確性／資料完整性審查修正：custom range 白屏、overall budget round-trip、adjustment audit history、local-date trend、日期 reference 更新與輸入空值。
- 安全／隱私審查修正：strict grants/default privileges、future-write checks、mixed-version bridge、goal allocation audit、same-clock divergent payload、owner verification 與 v3 goal legacy-field 保護。
- 對抗式／UX 審查修正：完整 persisted payload 驗證、malformed/foreign row 隔離、unresolved conflict 重排、guest import fingerprint、owner switch stale-result 防護、損毀快照 fail-closed 與封存影響提示。
- 固定點程式審查修正：非法或超安全範圍遠端財務列與破損跨表引用隔離、訪客重複匯入衝突原子中止及 snapshot-first 持久化、封存目標仍可見且以來源 allocation tombstone 防止雙裝置重複釋放、帳本分批載入，以及跨裝置 `sortOrder` 一致呈現與新增項目 max+1 排序。
- 最終複審修正：reconcile 後依最終 winners 重驗完整 graph、zero-delta 與 date-only backup 邊界、同順位帳戶穩定排序、進行中期間對等上期、損毀快照對所有遠端 sync fail-closed，以及 legacy subscription I/U/D、四表 delete tombstone、owner-scoped primary key 與未知 FK 原子中止。
- 中斷續作最終安全審查修正：以 minor units 消除衍生金額浮點尾差；週期補登 500 筆整批上限與失效 parent fail-closed；authenticated 舊版快取先做 0-apply 雲端拉取且不得自動排入 outbox；localStorage 讀取例外、超大備份、跨 owner stale callback 與同步中的本機新操作皆維持 fail-closed／可恢復狀態。
- Database 對抗式複審修正：配置容量改用 owner advisory lock 與 server ledger sum；allocation 經濟欄位不可改寫、不得產生負目標總額且不竄改 goal conflict clock；封存 parent 原子暫停排程；分類型別不可變；只有 legacy bridge 可做受控實體 `DELETE`，v3-only 表沒有 `DELETE` policy／grant。
- 最後 fixed-point 修正：正負 legacy allocation 的目標刪除不再受列順序誤擋，刪除後 legacy total 歸零且只消耗一次 clock；復原保護封鎖 UI mutation 與週期實體化並以 boolean applied contract 防止表單假成功；主題 storage denial 可安全 fallback；備份匯出／匯入／File gate 統一 UTF-8 位元組；支援長 ZWJ Emoji，極大金額以精確 cents 對照拒絕靜默 rounding。
- Release-gate red-team 修正：client/server UTF-8 write limits 對齊；單筆 1 億 safe monetary magnitude、最多六位 legacy 精度與 owner quotas fail-closed，確保八個滿額 backup collections 的跨集合 minor-unit 聚合仍精確；新 UI 輸入維持兩位小數，backup 以 raw JSON token、remote 以 `numeric::text` projection 在轉 `number` 前驗證精度，越界聚合也會 round-trip 驗證並拋錯而不回傳錯一分結果；quota 使用固定 allowlist 的 private `SECURITY DEFINER` trigger 讀取 RLS 隱藏 tombstone；撤回有跨分頁競態的登出清快取功能，登出一律保留 owner cache；CSP 移除 Preview Toolbar third-party script、pin 正式 Supabase host。
- 收尾階段唯一一次 Codex Security Standard Scan 已依正式技能啟動；即使 target 改為指向相同工作樹的 ASCII junction，Windows launcher 讀取 Git metadata 時仍發生 `UnicodeDecodeError: cp950`，因此沒有 scan ID 或 sealed report；未改用其他模式或重複嘗試冒充成功。獨立 security reviewer 最終 P0／P1／P2 均為 0，人工 attack-path pass 亦完成，正式掃描器缺口保留為工具限制。
- 上述修補後完整自動化綠燈；程式碼層目前沒有已知 blocking finding。Preview OAuth allowlist 是本次 E2E 新發現的 High 外部設定 blocker；依收尾指示不再展開新 fixed-point loop，其餘 scan／migration 與非阻斷項目列於下節。

## 剩餘限制與發布門檻

1. **High／發布 blocker：**在 Supabase Auth URL Configuration 新增 `https://shiba-expense-tracker-*-ziv-s-projects3.vercel.app/**`，再由最新 Preview 重跑 Google OAuth。程式端 `redirectTo` 已正確，現有權限可查 production DB 但不能改 Auth 設定，控制台另要求使用者登入，因此未安全繞過。
2. allowlist 修正後完成 Preview 上的真實雲端 edit/delete、離線 outbox 重連與不復活 smoke；本次已完成 Preview guest CRUD／reload／analytics，以及兩個獨立 session 的 localhost 真實 OAuth pull。為避免污染財務帳本，本次沒有建立 production 測試交易。
3. 取得使用者另行授權後才可套用第二支 production resource guard migration；未授權前只保留 reviewed migration/preflight，不做 DDL。
4. Codex Security launcher 的 `cp950` 中文路徑錯誤仍待工具端修復；本 release 沒有可封存的正式 scan artifact，已以獨立 reviewer 與人工 attack-path 審查降級替代，不再於本 Goal 重試。
5. Draft PR 已更新，最新 release-candidate commit 的兩個 GitHub Actions verify、Vercel deployment 與 Preview Comments checks 均綠燈；PR 保持 Draft，不得自行 merge。
6. CSV import、轉帳、多幣別、信用卡／債務模型皆是明確非目標。

### 非阻斷 follow-up

- `moneyLexemeDecimalPlaces` 對可用整數 coefficient 尾零抵銷負 exponent 的科學記號表示較保守，例如 `10000000e-7` 會被當成七位小數而拒絕；此路徑 fail-closed、不會改寫資料。App 自身 `JSON.stringify` 不會為目前合法一般金額產生這種等價表示，後續可在不影響本 release 的情況下正規化 coefficient 再判定 scale。
- 兩個 OAuth E2E session 均出現 `gotrue-js` 對約 1–2 秒 client/server clock 差的 warning，但 token 可正常建立、資料可完整拉取且狀態收斂為「已同步」；目前沒有正確性影響，後續可在平台／依賴更新時再核對。

## 回滾

- 程式碼：本次正式發布前的精確 RC 復原點是 `checkpoint/20260824-1158-before-v3-production-release`（`a1d3ebfd45f9a9f4fb7451ee6dc123bfe18ef643`）。若 production frontend 發生 release-blocking regression，Vercel 應先 rollback 到上一個已知正常的 production deployment `dpl_6ejsiuY1gFcGne5F7U44kuUeFdWj`（main `5fcebebe4b924b94929a4e0c638437796ef2ef9c`），保留已套用且向後相容的 v3 additive schema；若要回到整個建置前，再使用 `checkpoint/20260821-180842-before-autonomous-build`。所有 checkpoint 均已推送；不可 force-push 或刪除 tag。
- 本機使用者資料：使用管理頁的版本化 JSON backup；replace 必須明確選擇並輸入 `REPLACE`。
- Supabase：第一支 v3 migration 的 exact rollback 是 repository 外獨立 backup／PITR；第二支 guard 尚未執行。未來 rollout 優先 additive forward-fix，任何 guard removal 都需 fresh backup、另行授權與 reviewed transaction；不得臨時採 destructive down migration。
