# 本機安裝與還原

安裝前先建立獨立信任：對固定版本的 Skill、builder 與 launcher 做完整來源審視，或由 checkout 外已核准的可信發行來源取得固定版本與 SHA-256。紀錄核准者／可信來源、版本與三個檔案的預期 SHA-256。當前待審 checkout 的檔案、其自報 commit 與現算雜湊不能獨立證明可信；不可先執行候選檔案、import、npm script 或測試再決定是否可信。

以下是可審視的安裝程序，不是自動安裝命令。只有安裝已在使用者授權範圍且來源已核准時才執行；否則保存候選來源與這些步驟作為待辦，回報缺少已核准安裝或外部核准的阻擋。此流程不需要新憑證、權限、MCP server、付費服務或持久環境設定。

來源版本可由本 Git repository 提供，但必須先通過上述獨立核准。不修改既有 AutoDev、Win DevFlow 或 Codex 設定。新安裝只建立下列三個檔案；安裝前應確認目標不存在，若已有其他版本，先保存其原始位元組並核對差異，不覆寫未知檔案。

| 本 repository 來源 | Codex 個人技能目錄中的目標 |
| --- | --- |
| `tools/skills/codex-chatgpt-review/SKILL.md` | `codex-chatgpt-review/SKILL.md` |
| `scripts/create-review-packet.mjs` | `codex-chatgpt-review/scripts/create-review-packet.mjs` |
| `tools/run-trusted-review-packet.mjs` | `codex-chatgpt-review/tools/run-trusted-review-packet.mjs` |

Codex 個人技能目錄通常是 `%USERPROFILE%\.codex\skills`；以當前已配置的實際位置為準，目標必須位於待審 checkout 外。用受信任作業系統工具逐檔讀取、核對預期 SHA-256，將已驗證的位元組複製到新的目標檔，再核對目標雜湊；不要核對後重新讀取可能已被替換的來源。記錄獨立可信來源／核准紀錄、來源 commit、三個目標絕對路徑、預期與實際 SHA-256、安裝時間，以及目標先前是否存在。安裝紀錄保留在 checkout 外的本機任務證據目錄，不包含登入資料或通知內容。

已獨立核准、固定雜湊的任務專屬外部副本也可使用，不必全域安裝。執行前先依外部紀錄核對 launcher，然後由它驗證 builder 並執行已驗證的暫存副本；SKILL.md 提供命令格式。不要用 contributor checkout 的 npm 命令作為啟動入口。工具不會自動啟動工作、不會自行送出程式碼、不建立公開網址。

還原本次新安裝時，先核對三個目標檔案仍與安裝紀錄的雜湊相同，再只移除這三個檔案；空資料夾可保留。若內容已變，不刪除後續更新。若原有檔案曾被替換，應回存安裝前的精確位元組，不能以刪除整個技能目錄代替。
