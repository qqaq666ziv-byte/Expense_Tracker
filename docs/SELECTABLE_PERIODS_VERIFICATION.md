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

## 手機原生日期欄位重疊修正（2026-10-13）

- 實際取得並開啟使用者 Library 圖片 `libfile_eee043ea1d3481919568dc288d5a2669`（97,595 bytes）；圖中日期輸入框右緣與下一週箭頭重疊。使用者圖片保留在倉庫外，未加入 Git。
- 原三欄配置把日期原生控制與兩個箭頭放在同一列；iPhone 原生控制的尺寸行為使欄位侵入旁邊按鈕。舊 Chromium 檢查只量外框及 viewport，無法排除原生內部文字裁切或 Safari 的尺寸差異。
- 修正為日期欄位獨立整列，明確設定 border-box、inline min/max sizing 及 appearance；完整區間另列可換行，下方上期／回本期／下期為有文字的 44px 以上按鈕，可隨文字放大換行。另以 `1rem`、可換行的「已選月份／已選日期」顯示精確完整值，並透過 `aria-describedby` 連結至輸入控制；無效輸入時不顯示舊值。未更動統計計算、資料持久化或原生 date/month 類型。
- `python scripts/verify-period-layout.py`：320、375、390、414、430、440px，100%／150%／200% 字級，各自合成資料／空資料，並在同一 context 旋轉至橫向；共 72 組 viewport／字級／資料案例，每組均測週及月。檢查控制間不重疊、按鈕文字與完整日期範圍不溢出、touch target、前後／回本期、跨年週、閏月及長英文月份 September，並比對帳務未修改。此為 root font-size 模擬，不等於 iOS Dynamic Type 實測。
- 測試 fixture 改在同源空白頁建立完成後才載入 React，排除初始空狀態持久化與合成資料注入競爭；仍維持隔離 context、外部請求封鎖與資料未變斷言。
- 已重跑原 16 組日期／統計／圖表／明細 UI 與動態時區測試、typecheck、lint、54 檔／637 項 tests、build、PGlite migration、npm audit（0 vulnerabilities），及三時區各 67 項 focused tests。
- 獨立 reviewer 未發現阻塞問題；320px／200% 下 Chromium 原生長英文月份的年份仍可能部分裁切，精確已選值及完整日期範圍另列可讀；未透過縮小字級或換成自訂日期控制掩蓋此瀏覽器限制。原生 shadow 內文裁切無法靠 input.scrollWidth 判斷，因此測試通過不代表原生欄位內所有文字均完整。Safari／iPhone 實機及原生面板仍未驗。
- 合成畫面：[修正前 320px／200%](screenshots/period-layout-before-320-200pct.png)、[修正後 320px／200%](screenshots/period-layout-after-320-200pct.png)、[修正後 440px](screenshots/period-layout-after-440.png)。修正後的局部圖僅在截圖瞬間隱藏無關 sticky header／bottom nav，避免局部擷取疊入導覽列；實際幾何與點擊測試保持導覽列正常。修正前的 Chromium 圖展示日期內文裁切，不宣稱重現 iPhone 的相同外框重疊。
- 本次修正前遠端 checkpoint：`checkpoint/20261013-before-mobile-period-layout` → `41b81254a236d7bbf195138ece3768e3ed277a52`。需要還原時從此 tag 建立新分支，保留遠端歷史：`git switch -c restore/before-mobile-period-layout checkpoint/20261013-before-mobile-period-layout`。
