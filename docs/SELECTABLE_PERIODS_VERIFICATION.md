# 指定週／月：驗證紀錄

日期：2026-10-13。範圍為財務洞察的週／月期間選擇，不包含暫停中的 PR #21。

## 行為與日期規則

- 原有「本週／本月」改為「週／月」；可用日期欄選擇週內任一天、月份欄指定月份，也能前後切換及回本週／本月。
- 沿用 `dateRange.ts` 的裝置當地時間、週一至週日規則，顯示含年份的實際起迄日期。月份從第一日到最後一日，包含結束日全部時間。
- 選定區間共用於收入、支出、淨收支、日均、上期比較、分類占比、轉帳手續費明細與支出趨勢。
- 完成的歷史週／月以完整上期比較，日均使用完整期間天數；目前週期保留截至今日的日均及等長上期比較規則。
- 今日收支及目前週／月預算進度仍依真實時鐘計算，預算區塊標示「目前週／月」。今日、本年、自訂期間及返回記帳功能保留。
- 週、月各自保留選擇；回本期後恢復跨午夜／焦點更新。裝置時區變更後重新解析所選當地日期，避免以舊時區的 instant 顯示錯週／錯月。
- 清空日期時顯示欄位錯誤並暫停所選期間統計，仍可按回本期復原。

## 自動檢查

| 檢查 | 結果 |
| --- | --- |
| `npm ci --cache /tmp/expense-tracker-npm-cache` | 通過，依 lockfile 安裝，未增減依賴 |
| `npm run typecheck` | 通過 |
| `npm run lint` | 通過，零警告 |
| `npm test` | 54 個測試檔、637 項測試通過 |
| `VITE_SUPABASE_URL= VITE_SUPABASE_ANON_KEY= npm run build` | production PWA build 通過 |
| `npm run verify:migration` | 通過；僅在獨立 PGlite 使用合成資料，未連接外部資料庫 |
| `npm audit --cache /tmp/expense-tracker-npm-cache --audit-level=high` | 通過，0 vulnerabilities；package/lockfile 未修改 |
| 台北／紐約／聖地牙哥 `TZ` focused tests | 每個時區 4 檔、67 項全通過 |

Focused tests：`src/app/periodSelection.test.ts`、`src/domain/dateRange.test.ts`、`src/domain/financeEngine.test.ts`、`src/components/InsightsView.periods.test.tsx`。

新增／覆核案例包括跨月、跨年週、月末前後切換、閏日、首尾日時間邊界、空期間、轉帳手續費、完整歷史比較及日均、清空／非法輸入、反覆切換、午夜更新、夏令時間及使用中變更裝置時區。

## 瀏覽器驗證與截圖

使用 `python scripts/verify-period-selector.py`，本機 Vite 的 Supabase 設定留空。每個案例建立隔離訪客 context、合成帳務及固定時鐘，禁止所有非本機請求；結尾比對帳務資料未變。

Chromium 151.0.7922.173，以下 16 組均通過：

| 尺寸 | Asia/Taipei | America/Los_Angeles | UTC | America/Santiago |
| --- | --- | --- | --- | --- |
| 390 × 844 | 通過 | 通過 | 通過 | 通過 |
| 375 × 667 | 通過 | 通過 | 通過 | 通過 |
| 320 × 568 | 通過 | 通過 | 通過 | 通過 |
| 1280 × 900 | 通過 | 通過 | 通過 | 通過 |

另以同一 Chromium CDP session 在頁面開啟期間切換台北→洛杉磯並恢復焦點，確認二月仍為二月、週一仍屬正確週，以及對應金額不變。獨立 reviewer 也以原錯誤的精確重現步驟確認修復。

UI 檢查涵蓋選擇／前後／回本期、總額與日均、上期比較、圖表、手續費明細、空資料、錯誤復原與既有期間；選擇器按鈕／輸入框至少 44px，頁面無水平溢出。以程式填入原生日期欄位並操作頁面控制，不宣稱已驗證 iOS 原生日期面板手勢。

已視覺檢查的截圖僅含合成資料：

- [指定月份：2024 年 2 月](screenshots/select-month-iphone.png)
- [跨年週：2024/12/30–2025/1/5](screenshots/select-week-iphone.png)

## 審查及限制

- 獨立 correctness／資料完整性／安全隱私覆核完成；修復缺少合成目的帳戶、午夜 DST 日期解析、低年份建構，以及裝置時區變更造成的錯週／錯月問題。修復後無應用程式阻塞發現。
- Safari、iPhone 實機及原生 iOS 日期面板未驗證。WebKit 安裝後回報缺少 `libgtk-4.so.1`、`libgraphene-1.0.so.0`、`libharfbuzz-icu.so.0`、`libmanette-0.2.so.0`、`libhyphen.so.0`、`libGLESv2.so.2`；未更改系統權限或安全設定。
- Library 截圖保存依技能流程嘗試兩次，均於前置讀取回覆 `hosted apps tools/list request failed with HTTP status 401`，未取得 confirmed `library_file_id`。實際截圖 artifact 如上，不提供臆造 Library 連結。
- 初次 `npm ci` 因預設快取 `/home/agent/.npm/_cacache` 的 `ENOENT` 失敗；改用可寫入的 `/tmp` 快取後成功，未改權限。
- 未讀取真實帳務或密鑰；未增加依賴、資料庫變更、正式部署或合併。PR #21 持續暫停且未納入分支。

## 還原點

- 功能前遠端 checkpoint：`checkpoint/20261013-before-select-week-month` → `4a0c335233a544eb30cf59767c464a45efc7a2d0`（建立分支時的最新 main）。
- 接續驗證前遠端 checkpoint：`checkpoint/20261013-before-period-ui-completion` → `9ef42e5bbeed406263d9b5a0a3bbf4e3d6bfd48a`。
- 本 PR 尚未合併，關閉 PR 即可停止採用。需要獨立檢視原版時，可從第一個 checkpoint 建立新的還原分支；不要 force-push、重寫已 checkpoint 的歷史或部署正式站。

```sh
git switch -c restore/select-week-month-baseline checkpoint/20261013-before-select-week-month
```
