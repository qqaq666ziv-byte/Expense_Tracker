<p align="center">
  <img src="./public/icons/icon-192.png" width="128" height="128" alt="柴柴極速記帳 icon" />
</p>

<h1 align="center">柴柴極速記帳</h1>
<p align="center"><strong>Shiba Expense Tracker</strong></p>

<p align="center">
  柴犬主題的個人記帳 PWA，整合日常收支、財務分析、預算控制、儲蓄目標與每月固定開銷。
</p>

<p align="center">
  <a href="https://shiba-expense-tracker.vercel.app"><strong>🚀 開啟柴柴記帳</strong></a>
</p>

## 正式網站

https://shiba-expense-tracker.vercel.app

網站可直接以瀏覽器使用，也能安裝成獨立視窗的 PWA。訪客不需登入即可開始記帳；使用 Google 登入後，應用程式會改用帳號專屬快取並將財務資料同步至 Supabase。

## 完整功能

### 極速記帳

- 新增支出與收入，記錄金額、分類、付款方式／存入帳戶、日期時間及選填備註。
- 自動帶入目前時間；手動修改後可一鍵恢復當下時間。
- 即時計算總資產餘額：總收入減去總支出及目前儲蓄總額。
- 交易紀錄依日期由新到舊排列，並顯示收支類型、分類、帳戶、時間、備註與金額。
- 搜尋分類、備註、付款方式、收支類型或日期；沒有結果時顯示對應空狀態。
- 長按交易約 0.5 秒開啟編輯視窗，可修改收支類型、金額、分類、付款方式、時間與備註。
- 可直接刪除交易紀錄。

### 自訂記帳選項

- 內建餐飲、交通、購物、娛樂、薪水、獎金與投資分類。
- 可為收入或支出建立自訂分類、選擇 Emoji，亦可刪除分類。
- 內建現金、信用卡與行動支付，可再新增自訂付款方式。
- 自訂分類與付款方式會保存在目前瀏覽器。

### 財務分析

- 依近 7 天、近 30 天、近 365 天或自訂起訖日期篩選資料。
- 顯示所選期間的總收入與總支出。
- 以圓餅圖呈現支出分類占比，可透過圖例切換個別分類。
- 以折線圖呈現每日支出趨勢。
- 無支出資料時顯示零資料圖表；圖表無法建立時提供錯誤提示。

### 預算控制

- 依支出分類設定每週或每月預算。
- 即時計算當期已花費、剩餘可用或超支金額，並以進度條與顏色顯示使用程度。
- 新增支出若會超過對應預算，會先顯示限額、目前支出及預計超支金額，讓使用者取消或確認繼續。
- 相同分類與週期已有預算時，會先詢問是否覆蓋。
- 可刪除不再需要的預算。

### 儲蓄目標

- 建立多個儲蓄目標，設定名稱與目標金額。
- 在多個目標間切換、存入指定金額或刪除目標。
- 顯示儲蓄總額、目標金額與完成百分比。
- 沒有目標時提供建立入口及空資料說明。

### 自由儲蓄

- 提供手動輸入金額，以及 NT$50、NT$100、NT$500、NT$1,000 快捷存入。
- 依累積儲蓄金額顯示不同儲蓄階級。
- 此功能需先建立至少一個儲蓄目標；存入金額會加到目前選取的目標，並非獨立存錢筒。

### 每月固定開銷

- 建立每月固定項目，設定名稱、金額、每月扣款日、分類及付款方式。
- 到達扣款日後自動建立當月支出，並以固定格式備註，避免同一項目在同月重複扣款。
- 扣款日超過當月天數時，以當月最後一天處理。
- 自動記帳完成後顯示提示；固定開銷項目亦可刪除。

### 帳號、同步與離線使用

- 訪客模式會將交易、儲蓄目標、固定開銷與預算保存在瀏覽器的 `localStorage`。
- 支援 Google OAuth 登入；登入後使用帳號專屬本機快取，並透過 Supabase 讀寫交易、目標、固定開銷與預算。
- 交易新增或修改若暫時無法同步，仍會保留在本機；重新載入後會再與雲端交易合併，但不會自動重試上傳失敗的項目。
- PWA Service Worker 會快取應用程式外殼，已載入過的網站可在離線時重新開啟；雲端同步仍需網路。

### 外觀與響應式介面

- 柴犬與米克斯兩套寵物主題，包含不同配色、文案與吉祥物。
- 支援亮色與深色模式；主題偏好會保存在瀏覽器。
- 單頁底部導覽可切換極速記帳、財務分析、存錢筒與預算控制。
- 桌面與手機版共用響應式介面，主要操作、表單與彈出視窗均可在窄螢幕使用。

## 技術架構

- React 19、TypeScript
- Vite 6
- Tailwind CSS 4（Vite plugin）
- Motion 動畫
- Lucide React 圖示
- Chart.js 圖表
- Supabase JavaScript Client（Google OAuth 與雲端資料）
- `vite-plugin-pwa`／Workbox（Manifest、Service Worker 與離線快取）

## 資料儲存與隱私

| 使用方式 | 資料位置 | 跨裝置同步 |
| --- | --- | --- |
| 訪客模式 | 目前瀏覽器的 `localStorage` | 不支援 |
| Google 登入 | 帳號專屬 `localStorage` 快取與 Supabase | 登入相同帳號後由 Supabase 同步 |

財務資料不會因安裝 PWA 而自動備份。訪客模式下若清除網站資料、瀏覽器儲存空間或解除安裝並移除網站資料，交易、目標、固定開銷、預算、自訂分類與付款方式可能永久遺失。本專案目前沒有匯入、匯出、備份或還原介面。

## PWA 安裝與使用

1. 開啟[正式網站](https://shiba-expense-tracker.vercel.app)。
2. Chrome 或 Edge 桌面版可使用網址列的安裝圖示；Android 可從瀏覽器選單選擇「安裝應用程式」或「加到主畫面」。
3. iPhone／iPad Safari 可開啟分享選單，再選擇「加入主畫面」。
4. 安裝後會以 `standalone` 獨立視窗啟動；已快取的應用程式可離線開啟，重新連線後才可使用 Supabase 同步。

Service Worker 採自動更新模式；新版本發布後會在背景檢查並更新快取。

## 本機開發

需求：Node.js 與 npm。

```bash
npm install
npm run dev
```

開發伺服器預設位於 `http://localhost:8888`。

```bash
npm run build
npm run lint
```

- `npm run build`：建立 `dist/` 正式版檔案與 PWA Service Worker。
- `npm run lint`：執行 TypeScript `tsc --noEmit` 型別檢查。

本機若需測試 Google 登入及雲端同步，還需提供 `VITE_SUPABASE_URL` 與 `VITE_SUPABASE_ANON_KEY`。

## 重要專案結構

```text
.
├─ public/
│  ├─ icons/                 # 192、512 與 maskable PWA icons
│  └─ mix_*.png              # 米克斯主題圖片
├─ src/
│  ├─ components/
│  │  ├─ Dashboard.tsx       # 收支輸入、搜尋、編輯、分類與超支確認
│  │  ├─ Insights.tsx        # 期間統計與 Chart.js 圖表
│  │  ├─ Savings.tsx         # 儲蓄目標、自由儲蓄與固定開銷入口
│  │  ├─ SubscriptionManager.tsx
│  │  └─ BudgetPlanner.tsx
│  ├─ context/ThemeContext.tsx
│  ├─ lib/supabaseClient.ts
│  ├─ App.tsx                # 全域狀態、儲存、同步、通知與分頁
│  └─ main.tsx
├─ index.html
├─ vite.config.ts            # Vite 與 PWA Manifest 設定
└─ package.json
```

## Vercel 部署

- Production 網址：<https://shiba-expense-tracker.vercel.app>
- Vercel 會執行 `npm run build`，並發布 Vite 產生的 `dist/`。
- Production 正式網址公開存取；Preview 與分支部署維持 Vercel Deployment Protection。
- Supabase 連線資訊需在 Vercel 專案環境變數中設定，勿將服務端密鑰提交到 Repository。

## 已知限制

- 訪客資料只存在目前瀏覽器，清除網站資料後無法復原；目前沒有匯入、匯出、備份、還原或一鍵清除功能。
- 「自由儲蓄」共用目前選取目標的金額，必須先建立目標，沒有獨立的自由儲蓄帳戶。
- 有多個儲蓄目標時，畫面上的進度會以所有目標的儲蓄總額計算，可能無法準確代表單一目標進度。
- 財務分析頁的「新窩購置準備基金」使用固定示意數值，未連結實際儲蓄資料。
- 財務分析的自訂結束日期以日期字串比對，可能排除結束日當天包含時間的交易。
- 離線模式可開啟已快取介面及使用本機資料，但 Google 登入與 Supabase 同步需要網路。
- 前端正式版主要 JavaScript bundle 超過 500 kB，首次載入時間可能受網路與裝置效能影響。
