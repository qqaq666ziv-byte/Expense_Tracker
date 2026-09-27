# 本機安裝與還原

此 Skill 的版本來源是本 Git repository，不修改既有 AutoDev、Win DevFlow 或 Codex 設定。新安裝只建立下列兩個檔案；安裝前應確認目標不存在，若已有其他版本，先保存其原始位元組並核對差異，不覆寫未知檔案。

| 本 repository 來源 | Codex 個人技能目錄中的目標 |
| --- | --- |
| `tools/skills/codex-chatgpt-review/SKILL.md` | `codex-chatgpt-review/SKILL.md` |
| `scripts/create-review-packet.mjs` | `codex-chatgpt-review/scripts/create-review-packet.mjs` |

Codex 個人技能目錄通常是 `%USERPROFILE%\.codex\skills`；以當前已配置的實際位置為準。複製後逐檔比較 SHA-256，並記錄來源 commit、目標絕對路徑、SHA-256、安裝時間，以及目標先前是否存在。安裝紀錄保留在本機的任務證據目錄，不包含登入資料或通知內容。

使用專案內版本不需要安裝全域 Skill。全域版本供其他已授權專案重用流程，不會自動啟動工作、不會自行送出程式碼、不建立 MCP server 或公開網址。

還原本次新安裝時，先核對兩個目標檔案仍與安裝紀錄的雜湊相同，再只移除這兩個檔案；空資料夾可保留。若內容已變，不刪除後續更新。若原有檔案曾被替換，應回存安裝前的精確位元組，不能以刪除整個技能目錄代替。
