# Code smell 檢查與改善 — 2026-09-27

本次依 [Martin Fowler 對 Code Smell 的說明](https://martinfowler.com/bliki/CodeSmell.html)，將 smell 當作追查設計問題的線索，再以程式、資料流及回歸測試確認是否需要改善。檢查涵蓋 UI、狀態管理、儲存／同步相依與財務領域的重複規則、責任分工、型別及生命週期。函式長度本身不作為缺陷結論。

基準版本：`8f97b3e512cc13ec222458f19edc22274472c39c`。
修改前遠端 checkpoint：`checkpoint/20260927-162459-before-code-smell-refactor`，已確認遠端 tag 指向上述 SHA。
工作分支：`codex/code-smell-refactor`，使用獨立 worktree；原始 `main` 維持乾淨及原 SHA。

## 第一階段已改善的六項問題

| 位置 | 設計問題及實際影響 | 改善 |
| --- | --- | --- |
| `src/domain/financeEngine.ts` | 累計、今日、期間摘要分別重複收入／支出／分類彙總規則，修訂容易漏改。 | 共用 `summarizeCashFlow`；單次彙總保留分類名稱快照，避免逐分類重掃交易。一次洞察計算共用同份分析投影，保持各期間獨立篩選。 |
| `src/components/HomeView.tsx` | 今日摘要把 `new Date()` 隱藏於只依賴帳本的 memo，跨日後可繼續顯示昨天。 | 重用既有 `useCalendarReference`，午夜及返回頁面時更新；不清除輸入草稿、不產生財務寫入。 |
| `src/components/HomeView.tsx` | 新增表單的記憶選項與編輯初始化共用 effect；跨收支類型編輯時，舊偏好可覆寫交易原帳戶／分類。 | 記憶選項只初始化新增交易，編輯紀錄時保留原父項；新增模式仍可使用偏好。 |
| `src/app/localDurability.ts` | 對 IndexedDB 讀取值直接套用可信型別；缺失／null state 造成 TypeError，跳過復原鎖定。falsy 損壞資料也可能被當作沒有資料。 | 驗證前維持 `unknown`，僅 `undefined` 代表無資料。保留完整原始來源，拒絕一般寫入，僅允許精確來源的明確復原。 |
| `src/app/useFinanceApp.ts` | 訪客匯入使用新讀取快照，卻沿用舊畫面的指紋；若舊指紋已有成功收據，新增交易可被略過卻顯示完成。 | 匯入內容、重試識別碼及已處理指紋均取自同一份重新讀取的訪客資料。 |
| `src/app/categoryOrder.ts`、`state.ts`、`useFinanceApp.ts` | 類別排序在衝突鎖定及實際寫入各有一份，owner 條件已出現差異，形成規則漂移風險。 | 共用 `planCategoryReorder` 的實際變更集合，保留 owner／kind／刪除篩選、封存分類及原排序平手規則。 |

## 第一階段驗證證據（`59fa640`）

回歸測試先重現問題，再修正：

- 首頁：3 項失敗、1 項成功，exit 1；失敗包含兩個跨日案例及只改備註卻改掉帳戶／分類。修正後 Home、owner boundary、calendar 的 47 項相關測試通過。
- 儲存：原有 14 項成功、新增 missing／null state 兩項失敗，exit 1。修正後包含完整 raw、拒絕 stale recovery、阻止一般寫入及 falsy envelope 的 20 項測試通過。
- 訪客匯入：兩項新增測試皆失敗，exit 1；分別證明指紋混用與舊收據導致漏匯。修正後兩項通過。
- 財務重構：先以舊實作確認新增的分類快照、同額排序、逐筆取整、期間分隔及不修改來源測試通過，再抽取共用計算。

第一階段整合驗證：

| 指令／檢查 | 結果 |
| --- | --- |
| `npm run lint`（TypeScript 型別檢查） | 成功 |
| `npm test -- --reporter=dot` | 48 個測試檔、534 項測試通過，exit 0 |
| `npm run build` | Vite 正式建置及 PWA 產物成功，exit 0 |
| `npm run verify:migration` | 本機 PGlite 驗證成功，exit 0；未連外部資料庫 |
| `npm audit --audit-level=high` | 0 vulnerabilities，exit 0 |
| `git diff --check` | 成功 |

Codex 內建瀏覽器以 `127.0.0.1:8899` 的隔離訪客帳本實際操作：新增支出 100、薪資收入 200、零用錢收入 50；記住不同收入分類後從支出模式編輯薪資，只改備註，原分類仍為薪資。洞察顯示收入 250、支出 100、淨收支 150。再新增測試帳戶，轉帳 100、手續費 15；來源餘額 50、目的餘額 85、總資產 135，洞察支出 115、收入 250、淨收支 135。全部為本機合成資料。

## 審查與範圍

獨立子代理分別複查財務／首頁與儲存／匯入／排序的正確性、資料完整性、安全及邊界情境，未發現阻擋問題。保留金額 minor-unit 規則、歷史轉帳手續費語義、owner／generation 隔離、同步衝突鎖及精確來源復原規則。

第一階段未新增依賴。兩階段皆未修改資料庫 migration、未合併 main，亦未部署正式環境或操作正式財務資料。未變更的圖片及歷史文件與此變更無相依，不在逐一視覺驗收範圍。這是有具體證據的程式結構改善及相關驗證，不代表完整 Production E2E 或全專案零缺陷保證。

## 第二階段：核心控制流程與品質檢查

補充審查的基準仍是 `main` 的 `8f97b3e`；跨日問題已在第一階段修正，其餘建議逐項對照目前分支後改善。第二階段開始前另建立並推送 `checkpoint/20260927-175800-before-sync-smell-followup`，指向 `59fa6408cf1d2b81a69e1330428a9f74dba032f2`。

| 位置 | 改善及保留的邊界 |
| --- | --- |
| `domain/model.ts`、`syncConflict.ts`、`syncEngine.ts` | 新的待同步作業使用有型別的 `conflict`：payload、batch、transfer-dependency（含 accountIds）、unresolved。明確 `null` 代表沒有機器衝突意義；`lastError` 只供診斷。僅缺少 metadata 的舊資料經集中 adapter 解讀舊字串，保留相容性；無效 metadata 不回退猜測，而是拒絕同步並走原始資料復原保護。 |
| `domain/syncEngine.ts` | 抽出 `planSyncWrites`，以 ready／failed 結果及唯讀 Map／Set 交付寫入前計畫。主流程保留套用、拉取、合併及補償順序；前置 pull 失敗仍不傳送任何作業。這是第一個明確階段邊界，後續合併與補償尚未全部拆開。 |
| `app/state.ts` | 驗證 outbox／bootstrap 的衝突 metadata，初始化指紋保留其機器意義。跨分頁增加或明確移除衝突鎖時，較舊同步結果保留完整最新本機快照，避免清除／復活衝突，以及 outbox 與可見紀錄不一致；單純文案和重試次數不會阻止完成。 |
| `app/ordinaryMutationPolicy.ts`、`useFinanceApp.ts` | 集中一般寫入的 bootstrap／recovery 政策和原通知文字。owner、同步 token、財務依賴及提交當下最新資料的驗證仍保留；備份復原、衝突處理、legacy 決定及訪客匯入的特殊規則不套用錯誤的共用限制。 |
| `app/useFinanceApp.ts` | 分開本機訪客鏡像與登入後的訪客提示讀取；owner 切換、focus、可見性及相關 storage 事件才刷新，合併進行中的刷新並拒絕過期 owner／generation 回應。登入帳本一般修改或同步完成不再額外讀取訪客資料，真正匯入仍重新讀取最新快照。 |
| `components/homeEditorState.ts`、`HomeView.tsx` | 四種互斥狀態表達新增／編輯收支及轉帳；集中模式切換、編輯、重設及交換帳戶。轉帳帳戶 ID 與快照一起移動，保留上次收支類型／帳戶、草稿、原交易編輯身分及背景更新保護。 |
| `eslint.config.js`、`package.json`、`tsconfig.json`、CI | 分離 `typecheck` 與真正 ESLint；將 React Hooks 呼叫規則、依賴陣列及未使用停用註解設為錯誤，啟用 `strictNullChecks`。修正初次掃描的 5 個 Hooks 問題及 7 個空值問題，移除原本兩處 Hooks 規則停用，未以新增 `any`／非空斷言掩蓋生產程式問題。 |

此處 lint 僅宣稱已啟用的兩項 Hooks 規則，並非所有 ESLint／React Compiler 規則；TypeScript 也尚未全面啟用 `strict`。開發依賴新增 ESLint、TypeScript parser 與 Hooks plugin，鎖檔新增 74 個套件，既有套件版本均未改動。規則依據參考 [React 官方 ESLint plugin 文件](https://react.dev/reference/eslint-plugin-react-hooks)。

### 第二階段驗證

- typed conflict 的第一批 4 個回歸測試先在舊實作失敗（exit 1），涵蓋文案獨立、明確清除及無效 metadata；另驗證舊字串、重新載入、batch／transfer 確認及一般錯誤含舊 prefix 的情境。
- 訪客刷新先有 3 個失敗案例（exit 1）；改善後 10 項測試通過，包含多餘讀取、事件刷新、owner 過期回應與持續同步失敗不熱迴圈。
- 同 ID 同步競態的 3 個案例先失敗（exit 1），修正後保留新鎖及明確解除結果，並驗證完整快照可重新載入。
- 首頁 3 個新增轉換回歸先在原實作通過，再於 reducer 重構後通過，避免把既有產品行為誤當重複狀態刪除。
- 不同實作者交叉進行正確性、資料完整性、安全／隱私及對抗情境複查；發現的初始化指紋及跨分頁衝突鎖風險均已修正，未留下阻擋問題。此為本地子代理審查，不宣稱是一般 ChatGPT 對新程式碼的獨立審查。

| 最終整合指令／檢查 | 結果 |
| --- | --- |
| `npm run typecheck` | 含 `strictNullChecks`，成功，exit 0 |
| `npm run lint` | ESLint Hooks 檢查成功，無警告，exit 0 |
| `npm test -- --reporter=dot` | 51 個測試檔、601 項測試通過，exit 0 |
| `npm run build` | Vite 正式建置及 PWA 產物成功，exit 0 |
| `npm run verify:migration` | 本機 PGlite 驗證成功，exit 0；未連外部資料庫 |
| `npm audit --audit-level=high` | 0 vulnerabilities，exit 0 |
| `git diff --check` | 成功 |

內建瀏覽器另以 `127.0.0.1:8899` 的既有合成帳本確認收入編輯保留薪資／現金、切換到轉帳後只編輯轉帳、來源／目的交換、回到新增收入時不保留舊編輯身分。洞察維持支出 115、收入 250、淨收支 135；將自訂結束日改到合成交易前一天後，期間摘要重算為 0。此次未新增財務紀錄，Console 無 warning／error；測試分頁及本機 server 已關閉。

訪客提示未新增跨分頁 IndexedDB 即時推播協定；讀取於上述事件刷新，真正匯入時仍會重新讀取。沒有執行真實登入／雲端同步或 Production E2E。

## 還原

PR 尚未合併時，原 `main` 即為修改前版本。要在乾淨的工作區檢視／使用修改前的完整原始碼，可建立獨立還原分支：

```powershell
git switch -c codex/restore-before-code-smell checkpoint/20260927-162459-before-code-smell-refactor
```

需撤回已提交的改善時，使用一般 `git revert` 撤回本 PR 的 commit，保留 checkpoint 及既有歷史。上述皆為原始碼還原，不清除瀏覽器資料、不回滾資料庫，也不會自動部署；正式環境復原另依 `docs/PRODUCTION_RELEASE.md` 驗證及授權執行。

僅查看或還原到第二階段修改前的原始碼，可在乾淨工作區使用：

```powershell
git switch -c codex/restore-before-sync-smell-followup checkpoint/20260927-175800-before-sync-smell-followup
```
