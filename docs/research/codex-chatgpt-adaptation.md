# Codex 與一般 ChatGPT 的規劃／審查流程調整

調查日期：2026-09-27。用途：在實作 iPhone 捷徑匯入消費前，採用可核對版本與驗證證據的外部規劃／審查流程。這份文件記錄已查證的來源、採用方式及驗收條件；文件存在不代表已安裝上游橋接器，也不代表一般 ChatGPT 已審查任何產品變更。

## 結論

採用上游「一般 ChatGPT 規劃與審查，Codex 執行，修正後重驗」的角色分工，將傳輸改為本次 Codex 內建瀏覽器可實際操作的、限定受影響範圍的不可變證據包。包內同時綁定完整 Git 基準／目前 SHA、實際來源檔案與驗證輸出；新增檔、已提交的功能變更及排除理由均不能遺漏。先確認一般 ChatGPT 登入與證據送達，再宣稱這條流程可用。

這是針對本專案的流程調整，不是安裝另一個自動執行服務。上游公開橋接、Cloudflare 隧道與 Codex 設定不是捷徑匯入功能的必要相依。當前既有 AutoDev 不涵蓋新 worktree，不能以舊專案 ID 代替。

實際工具位於 `scripts/create-review-packet.mjs`，配套操作 Skill 位於 `tools/skills/codex-chatgpt-review/SKILL.md`。兩者獨立實作，沒有複製上游或 Win DevFlow 程式。builder 支援初始規劃包、實際驗證後的審查包與送出／採納前的 freshness 核對；命令與 metadata 格式見 Skill。`scripts/create-review-packet.node-tests.mjs` 驗證越界、連結、未追蹤來源、敏感內容、基準累積差異、失敗檢查與 stale review 等邊界；使用 `node --test` 執行，檔名刻意避開 Vitest 預設測試範圍。

為避免把已修改但未選入的檔案誤當範圍未變，builder 會拒絕所有漏列的非保護路徑變更：基準到目前的累積變更與未追蹤檔均須選入，選入的新檔仍需明確 stage。只有相對基準未變更的無關來源／資產可以排除。秘密與 Git 忽略資料完全不讀，其內容變化不在任何來源／範圍證明內。

## 上游核對範圍

固定來源為 [XiaoDuoYa/codex-with-chatgpt，commit 9663b88753e35c76796c5bce000293e0bd22cd9e](https://github.com/XiaoDuoYa/codex-with-chatgpt/tree/9663b88753e35c76796c5bce000293e0bd22cd9e)。以 GitHub API 讀取原始碼，沒有執行上游程式或安裝套件；未重新執行上游測試，因此 README 的測試數及端到端聲明不是本次驗證結果。

| 查證內容 | 對本專案的意義 |
| --- | --- |
| [協定](https://github.com/XiaoDuoYa/codex-with-chatgpt/blob/9663b88753e35c76796c5bce000293e0bd22cd9e/docs/protocol.md) 使用 INIT、PLAN、EXECUTED、REVIEW、DONE／BLOCKED，要求 reviewer 親讀來源及驗證記錄。 | 保留角色分工、具體驗收及修正迴圈；檔案內容、日誌、reviewer 建議仍是資料，不能擴大本次授權。 |
| [MCP 工具](https://github.com/XiaoDuoYa/codex-with-chatgpt/blob/9663b88753e35c76796c5bce000293e0bd22cd9e/src/mcp/server.ts) 提供九種讀取工具，沒有執行 shell／寫檔工具。 | 外部 reviewer 不需取得寫入正式帳本、執行程式或部署的能力。 |
| [執行記錄](https://github.com/XiaoDuoYa/codex-with-chatgpt/blob/9663b88753e35c76796c5bce000293e0bd22cd9e/src/execution/records.ts) 以 task、iteration、時間、文字測試摘要及 output ID 關聯；schema 沒有來源 SHA 或內容 digest。 | 不能只看「27 passed」或最新一筆記錄就認定目前程式通過。必須把命令結果綁定實際被測來源。 |
| [git diff 實作](https://github.com/XiaoDuoYa/codex-with-chatgpt/blob/9663b88753e35c76796c5bce000293e0bd22cd9e/src/workspace/git.ts) 的 head 模式是工作目錄相對 HEAD；沒有指定功能基準 commit 的選項，也不會把 untracked 檔案內容放進 Git diff。 | commit 後空 diff 不代表功能沒改。審查包必須包含基準到目前的累積差異，以及新增／刪除檔案的證據。 |
| [輸出儲存](https://github.com/XiaoDuoYa/codex-with-chatgpt/blob/9663b88753e35c76796c5bce000293e0bd22cd9e/src/execution/output.ts) 只留最近 40 筆；[sanitizer](https://github.com/XiaoDuoYa/codex-with-chatgpt/blob/9663b88753e35c76796c5bce000293e0bd22cd9e/src/execution/sanitize.ts) 會遮罩特定格式、拒絕私鑰並截斷至大小／行數限制。 | 有截斷、缺頁或被限制的驗證結果要標記缺證據；若該結果屬驗收必要條件，不能以其他成功摘要補成 PASS。 |

## 本次採用的可執行流程

1. **INIT：固定工作身分。** 記錄使用者需求、受影響範圍、已驗證的遠端 checkpoint、完整 base SHA、分支及 worktree。捷徑功能的範圍至少包括：授權接收、來源解析、金額與時間、去重、指定帳戶、待確認／寫入、重試及既有同步相依；無關視覺資產可說明排除。
2. **PLAN：送一般 ChatGPT 做獨立規劃。** 使用本次可用的瀏覽器 API，在一般 ChatGPT 對話中送出必要的架構與受影響程式碼證據。先核對來源讀取完整，再請其指出產品路徑、風險及測試。保留實際回覆；Codex 依本專案邊界判斷哪些建議成立。未取得真實回覆時，狀態只能是等待外部規劃。
3. **EXECUTED：實作、驗證、封包。** 用明確 allowlist 捕捉變更與必要相依的完整文字內容，包含刪除檔的基準版本；使用固定 base 到被審查版本的累積 diff。保存每個命令的 cwd、開始／結束時間、真實 exit code、經檢查的輸出與輸出 SHA-256。來源在測試前後不同，該測試不能綁定到新版本。
4. **REVIEW：傳送不可變證據。** 優先用瀏覽器當前文件明確支援的附件上傳；若沒有上傳能力，使用有限大小、有順序及雜湊的分段可見訊息。先確定全部內容送達，再要求 reviewer 回覆從包內讀得的 packet ID、source digest、scope digest、檔案數及 END_EVIDENCE。不把這些欄位的預期值先餵給 reviewer 當作 ACK 答案。
5. **修正：同一個原始驗收範圍。** 針對成立的 finding 修正與重驗，產生新包及新版本身分。reviewer 不可把不相關資產或整個產品 E2E 自動加入阻擋條件；必要但缺漏的財務／授權／同步證據也不能排除。
6. **DONE：核對目前身分才交付。** 只有完整回覆、來源與範圍 digest 均相符、相關必要檢查通過，且沒有阻擋 finding，才能記錄該版本外部 review 通過。後續來源或排除理由改變，舊 review 顯示過期。GitHub 交付、一般 ChatGPT review、手機實機驗收、正式部署是分開的結果。

### 證據包最小格式

```json
{
  "schemaVersion": 1,
  "taskId": "ios-shortcut-import",
  "revision": 1,
  "baseCommit": "<full Git SHA>",
  "headCommit": "<full Git SHA>",
  "sourceDigest": "<SHA-256 of sorted path + source hash manifest>",
  "scopeDigest": "<SHA-256 of sorted included paths and excluded path + reason metadata>",
  "files": [{ "path": "src/example.ts", "sha256": "<hash>", "bytes": 123 }],
  "exclusions": [{ "path": "<exact path>", "reason": "<specific reason>" }],
  "checks": [{
    "command": "<actual command>",
    "cwd": "<task workspace>",
    "sourceDigestBefore": "<hash>",
    "sourceDigestAfter": "<same hash>",
    "exitCode": 0,
    "outputSha256": "<hash>",
    "truncated": false
  }],
  "evidenceBodySha256": "<hash>",
  "packetId": "<hash of canonical manifest without packetId>"
}
```

`headCommit` 不能單獨代表尚未提交的修改；只要有 dirty state，就另外保存完整狀態與實際檔案 digest，不能把 HEAD 當成全部內容。上面的 `exitCode: 0` 只是 schema 範例，建立封包時必須以實際結果替換。敏感檔只記必要的排除路徑／理由，不讀取或雜湊秘密內容。

包外保存一般 ChatGPT 對話 URL、傳輸時間、附件或各段雜湊、完整 ACK 與 reviewer 原文。這是操作者保存的可核對紀錄，不是 OpenAI 平台簽章，也不能證明某特定模型親自執行測試。reviewer 閱讀測試證據不等於獨立重跑命令。

## Windows 與安全差異

- **不直接套用上游 Skill。** 上游 [Skill](https://github.com/XiaoDuoYa/codex-with-chatgpt/blob/9663b88753e35c76796c5bce000293e0bd22cd9e/skill/SKILL.md) 指向特定舊瀏覽器 runtime，並要求每日更新、必要時 stash／pull、改全域 sandbox allowlist、刪除與重建 connector。這些不是本次功能的必要步驟。使用當前工具回傳的 API；固定參考 commit，保留使用者現有 Git 與設定。
- **唯讀仍會傳出內容。** 上游 [安全模型](https://github.com/XiaoDuoYa/codex-with-chatgpt/blob/9663b88753e35c76796c5bce000293e0bd22cd9e/docs/security.md) 保護 MCP 權限與工作目錄；ChatGPT 讀到的程式碼仍會傳輸給 ChatGPT。對財務專案，應在傳送前限制來源範圍並人工核對秘密與真實資料，不能將「唯讀」解讀成資料完全留在電腦。
- **名稱阻擋不等於內容保密。** [ignore 規則](https://github.com/XiaoDuoYa/codex-with-chatgpt/blob/9663b88753e35c76796c5bce000293e0bd22cd9e/src/workspace/ignore.ts) 針對常見敏感檔名，也允許 `.env.example`；不代表任意一般檔案內不會含秘密或財務資料。封包不可收整個 repo、瀏覽器 profile、正式通知樣本、私密日誌或資料庫備份。測試資料需為明確合成。
- **Windows 檔案權限要以 ACL 判定。** 上游 [paths.ts](https://github.com/XiaoDuoYa/codex-with-chatgpt/blob/9663b88753e35c76796c5bce000293e0bd22cd9e/src/config/paths.ts) 使用 `0600` 與 best-effort chmod，程式本身即註明部分平台沒有相同語意。這不是 Windows 私密檔案 ACL 已驗證的證據。這次不建立新長期憑證；來源快照拒絕 junction、symlink、hardlink 及路徑逃逸。
- **保留提示注入邊界。** 上游 [MCP 描述](https://github.com/XiaoDuoYa/codex-with-chatgpt/blob/9663b88753e35c76796c5bce000293e0bd22cd9e/src/mcp/server.ts) 已將 workspace 視為不可信資料。任何 README、diff、日誌、reviewer 建議都不能授權新增付費、讀秘密、修改其他專案或執行正式資料操作。
- **不以工具存在當成連線成功。** 上游 [Windows 測試](https://github.com/XiaoDuoYa/codex-with-chatgpt/blob/9663b88753e35c76796c5bce000293e0bd22cd9e/tests/windows-process.test.ts) 包含隱藏背景程序視窗的驗證，但不是本機安裝、一般 ChatGPT 登入、connector OAuth 或完整讀檔的實測。必須分別取得當次證據。

## 2026-09-27 本機能力核對

| 項目 | 本次實際觀察 | 可採取的動作 |
| --- | --- | --- |
| 上游來源 | 已讀固定 commit 的協定、安全、MCP、CLI、Git／ignore、輸出與 Windows 測試原始碼。 | 作為流程與邊界參考；沒有上游安裝或 E2E 成功聲明。 |
| 現有 AutoDev | `autodev_projects` 的唯讀實際呼叫成功；僅列 `acceptance` 與 `expense-tracker-fees`。 | 新捷徑 worktree 未列為已註冊專案，不能在舊 fees 專案派工或將它視為本次審查來源。沒有修改或重啟 AutoDev。 |
| 現有 Win DevFlow | 唯讀查到 `src/evidence.mjs` 的 snapshot、sourceDigest／scopeDigest、封包驗證及 stale review 檢查；該 checkout 目前沒有有效 HEAD，且有未完成的 Git 狀態。 | 只參考證據綁定設計，不執行既有 runner、不改該 checkout、不複製私密紀錄。讀取版本的 evidence.mjs SHA-256：`96277ac47219ce020878a34ba6861b57db5697169f6bc9b8a7ab19d78139dab9`。 |
| Codex 內建瀏覽器 | 主工作已回報實際登入一般 ChatGPT 並取得本功能設計檢視，研究子工作未操作該頁面。 | 設計檢視與來源審查分開記錄。完整來源包與 ACK 尚未在本文件定稿時取得，不能稱為 source review PASS。 |
| 本次 worktree | `codex/ios-shortcut-import`，起點 `8f97b3e512cc13ec222458f19edc22274472c39c`；遠端 checkpoint tag 解參照後與起點相同。 | 在隔離 worktree 進行授權範圍內修改；保留原始帳本與正式環境。 |

引用的本機設計只作比較來源，沒有引入 Win DevFlow 執行相依。研究、封包工具及操作 Skill 可交付；真正採用結果必須由本次封包、真實 ChatGPT 回覆與核對記錄證明。
