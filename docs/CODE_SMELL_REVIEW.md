# Code smell 檢查與改善 — 2026-09-27

本次依 [Martin Fowler 對 Code Smell 的說明](https://martinfowler.com/bliki/CodeSmell.html)，將 smell 當作追查設計問題的線索，再以程式、資料流及回歸測試確認是否需要改善。檢查涵蓋 UI、狀態管理、儲存／同步相依與財務領域的重複規則、責任分工、型別及生命週期。函式長度本身不作為缺陷結論。

基準版本：`8f97b3e512cc13ec222458f19edc22274472c39c`。
修改前遠端 checkpoint：`checkpoint/20260927-162459-before-code-smell-refactor`，已確認遠端 tag 指向上述 SHA。
工作分支：`codex/code-smell-refactor`，使用獨立 worktree；原始 `main` 維持乾淨及原 SHA。

## 已改善的六項問題

| 位置 | 設計問題及實際影響 | 改善 |
| --- | --- | --- |
| `src/domain/financeEngine.ts` | 累計、今日、期間摘要分別重複收入／支出／分類彙總規則，修訂容易漏改。 | 共用 `summarizeCashFlow`；單次彙總保留分類名稱快照，避免逐分類重掃交易。一次洞察計算共用同份分析投影，保持各期間獨立篩選。 |
| `src/components/HomeView.tsx` | 今日摘要把 `new Date()` 隱藏於只依賴帳本的 memo，跨日後可繼續顯示昨天。 | 重用既有 `useCalendarReference`，午夜及返回頁面時更新；不清除輸入草稿、不產生財務寫入。 |
| `src/components/HomeView.tsx` | 新增表單的記憶選項與編輯初始化共用 effect；跨收支類型編輯時，舊偏好可覆寫交易原帳戶／分類。 | 記憶選項只初始化新增交易，編輯紀錄時保留原父項；新增模式仍可使用偏好。 |
| `src/app/localDurability.ts` | 對 IndexedDB 讀取值直接套用可信型別；缺失／null state 造成 TypeError，跳過復原鎖定。falsy 損壞資料也可能被當作沒有資料。 | 驗證前維持 `unknown`，僅 `undefined` 代表無資料。保留完整原始來源，拒絕一般寫入，僅允許精確來源的明確復原。 |
| `src/app/useFinanceApp.ts` | 訪客匯入使用新讀取快照，卻沿用舊畫面的指紋；若舊指紋已有成功收據，新增交易可被略過卻顯示完成。 | 匯入內容、重試識別碼及已處理指紋均取自同一份重新讀取的訪客資料。 |
| `src/app/categoryOrder.ts`、`state.ts`、`useFinanceApp.ts` | 類別排序在衝突鎖定及實際寫入各有一份，owner 條件已出現差異，形成規則漂移風險。 | 共用 `planCategoryReorder` 的實際變更集合，保留 owner／kind／刪除篩選、封存分類及原排序平手規則。 |

## 驗證證據

回歸測試先重現問題，再修正：

- 首頁：3 項失敗、1 項成功，exit 1；失敗包含兩個跨日案例及只改備註卻改掉帳戶／分類。修正後 Home、owner boundary、calendar 的 47 項相關測試通過。
- 儲存：原有 14 項成功、新增 missing／null state 兩項失敗，exit 1。修正後包含完整 raw、拒絕 stale recovery、阻止一般寫入及 falsy envelope 的 20 項測試通過。
- 訪客匯入：兩項新增測試皆失敗，exit 1；分別證明指紋混用與舊收據導致漏匯。修正後兩項通過。
- 財務重構：先以舊實作確認新增的分類快照、同額排序、逐筆取整、期間分隔及不修改來源測試通過，再抽取共用計算。

最後整合驗證：

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

本次未新增依賴、未修改資料庫 migration、未合併 main，亦未部署正式環境或操作正式財務資料。未變更的圖片及歷史文件與此變更無相依，不在逐一視覺驗收範圍。這是有具體證據的程式結構改善及相關驗證，不代表完整 Production E2E 或全專案零缺陷保證。

## 還原

PR 尚未合併時，原 `main` 即為修改前版本。要在乾淨的工作區檢視／使用修改前的完整原始碼，可建立獨立還原分支：

```powershell
git switch -c codex/restore-before-code-smell checkpoint/20260927-162459-before-code-smell-refactor
```

需撤回已提交的改善時，使用一般 `git revert` 撤回本 PR 的 commit，保留 checkpoint 及既有歷史。上述皆為原始碼還原，不清除瀏覽器資料、不回滾資料庫，也不會自動部署；正式環境復原另依 `docs/PRODUCTION_RELEASE.md` 驗證及授權執行。
