# 轉帳手續費

轉帳金額為目的帳戶實收本金，選填手續費由來源帳戶額外扣除。
例如本金 1,000、手續費 15：來源 -1,015、目的 +1,000、支出 +15。
手續費和轉帳是同一筆資料，編輯、刪除、離線儲存、同步與 JSON 備份一起處理；
清空手續費欄位代表 0。既有未帶 fee 的紀錄視為 0。

手續費計入總支出、洞察、趨勢及整體預算，獨立顯示「手續費」統計分類，
不額外建立交易，也不計入既有使用者分類預算。CSV 轉帳匯出包含 fee 欄位。

## 發布與還原

- 2026-09-19 已套用正式 migration，合併 PR #16 並部署上線；發布 commit 為
  `82261a94213b1268c4570be048f010fd09533680`。
  正式網址已確認手續費欄位及「本金 1,000、手續費 15 → 扣款 1,015、入帳 1,000」預覽正常。
  完整發布與還原紀錄見 `docs/PRODUCTION_RELEASE.md` 的 2026-09-19 紀錄。
- 發布依 `docs/PRODUCTION_RELEASE.md` 驗證即時環境及備份，先套用
  `20260919000000_finance_transfer_fees.sql`，再發布前端；新前端需要 fee 欄位。
- 欄位為 additive；舊 client 遺漏 fee 的寫入會保留既存 fee，新 client 明確送 0 可清除。
- 舊前端不會計算手續費。開始使用前須更新所有裝置與 PWA，避免舊畫面顯示錯誤餘額。
- 一旦出現非零 fee，**不可回滾到未支援 fee 的前端**。停止寫入時從本功能版本執行
  `npm run build:transfer-read-only`，保留手續費計算、資料欄位、轉帳與 tombstone。
  資料庫恢復須使用獨立備份流程，不得刪 fee 欄位或以 Git 還原代替資料庫復原。
- 本次修改前 checkpoint：`checkpoint/20260913-astra-policy-1`，
  SHA `0f60a473033e56ad260ae1079c0955ba7051e3c5`。
  在尚未產生 fee 資料的開發環境，可使用
  `git worktree add --detach ../Expense_Tracker-before-fees checkpoint/20260913-astra-policy-1`
  取回修改前原始碼，不重寫現有分支。
