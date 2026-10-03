# 維護操作範圍

每次維護先以 `AGENTS.md` 與 `PRODUCTION_RELEASE.md` 為準，重新確認 Git、正式網域、Vercel 專案及 Supabase project ref，不沿用歷史健康狀態。

## 一次維護的檢查順序

1. 確認分支、HEAD、未提交變更、遠端 checkpoint，以及尚未合併的 PR。先保全現況，再建立維護分支；不混入別的功能。
2. 以 lockfile 安裝依賴，執行 `npm audit`、`npm outdated`。優先修補已確認漏洞；不把「有新版」視為必須升級主版本。
3. 執行 `npm run lint`、`npm test`、`npm run verify:migration`、`npm run build`。金額、儲存、同步或權限修正必須有相應回歸測試；依差異決定額外 smoke。
4. Supabase 唯讀檢查：健康與版本、migration 清單、security/performance advisors、RLS／grants／RPC／trigger、Edge Function 狀態、最近日誌摘要、容量、備份與復原條件。不要把本機 `supabase/config.toml` 當成遠端 Auth 設定。
5. Vercel 唯讀檢查：正式 alias → project → repository → branch → commit、Node/runtime、建置設定、環境變數名稱與環境範圍、部署保護、CI／部署結果及執行期錯誤。不要輸出環境變數值。
6. 正式網域檢查 HTTP、安全標頭、JS/CSS、PWA manifest／SW，並以訪客模式觀察實際畫面。需要儲存的合成資料在本機隔離來源測試；不使用真實雲端財務資料做 smoke。
7. 審查修正的 correctness、資料完整性、安全／隱私與邊界情況；保留確切測試、工具限制與未驗證項目。完成 commit／push／PR。

## Advisor 與正式環境變更

- Advisor 是調查線索。owner-scoped SECURITY DEFINER RPC 或內部表的 default-deny RLS，可能是必要設計；先核對完整 grants、caller identity、search_path 與測試，再判斷。
- 不因 `unused_index` 或 `duplicate_index` 警告直接刪除索引；先核對 FK、constraint 與 `pg_depend`。RLS 最佳化也必須保留歷史 client、tombstone 與同步行為。
- 資料庫版本升級、migration、Edge Function 發布與正式上線遵守 release runbook；先備妥新鮮且獨立的資料庫復原點與驗證，再取得該正式操作的授權。
- 不自動購買方案、改變帳號登入政策、輪替金鑰、清除儲存或排程工作。
- 檢查不到的 backup/PITR、Auth 設定、登入後多裝置同步或日誌，標示「未驗證」，不可用健康狀態或 HTTP 200 代替。

## 維護記錄

每次在 `docs/maintenance/YYYY-MM-DD.md` 記錄：來源 checkpoint、修正與理由、實際平台狀態、驗證、保留事項、正式操作及 rollback。只保存去識別的摘要，不保存私密帳務、原始日誌、token 或備份內容。

這份文件不建立排程；2026-10-03 的授權為單次維護。
