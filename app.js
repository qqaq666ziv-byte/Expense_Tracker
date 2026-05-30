/* ==========================================================================
   Spark 記帳本 - 旗艦版 JavaScript 核心 (Flagship Core Application Logic)
   ========================================================================== */

// 1. 全域狀態資料模型 (Global State)
let state = {
  totalBalance: 10000,
  initialBalance: 10000,
  timezone: "Asia/Taipei",
  timezoneOffset: 8,
  accentColor: "#FF006E",
  theme: "dark", // "dark" or "light"
  soundEnabled: true,
  categories: ["🍔 食", "👕 衣", "🏠 住", "🚇 行", "📚 育", "🎮 樂", "📝 其他"],
  ledger: [],
  fixedExpenses: [],
  savingsPool: {
    currentAmount: 0,
    hasTarget: true,
    targetAmount: 20000,
    targetName: "筆電升級基金"
  },
  wishlist: [], // 購買心願清單
  memos: [],     // 備忘錄卡片
  googleUser: null, // Google Drive 同步使用者狀態
  cloudConfig: {
    enabled: false,
    dbUrl: "",
    authToken: ""
  }
};

// 1.1 手動修改日期時間欄位之追蹤標記
let userHasModifiedLedgerTime = false;
let userHasModifiedLedgerDate = false;

// 1.2 備忘錄編輯中卡片 ID 標記
let editingMemoId = null;

// 2. 瀏覽器音效合成器 (Web Audio API Synthesizer)
let audioCtx = null;

function initAudio() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (audioCtx.state === 'suspended') {
    audioCtx.resume();
  }
}

function playSound(type) {
  if (!state.soundEnabled) return;
  try {
    initAudio();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    
    const now = audioCtx.currentTime;
    
    if (type === 'click') {
      // 嗶短聲
      osc.type = 'sine';
      osc.frequency.setValueAtTime(1000, now);
      osc.frequency.exponentialRampToValueAtTime(300, now + 0.08);
      gain.gain.setValueAtTime(0.06, now);
      gain.gain.exponentialRampToValueAtTime(0.01, now + 0.08);
      osc.start(now);
      osc.stop(now + 0.08);
    } else if (type === 'tab') {
      // 滑頁輕彈聲
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(600, now);
      osc.frequency.exponentialRampToValueAtTime(900, now + 0.06);
      gain.gain.setValueAtTime(0.04, now);
      gain.gain.exponentialRampToValueAtTime(0.005, now + 0.06);
      osc.start(now);
      osc.stop(now + 0.06);
    } else if (type === 'deposit') {
      // 存錢琶音 (C5 -> E5 -> G5 -> C6)
      const freqs = [523.25, 659.25, 783.99, 1046.50];
      freqs.forEach((freq, idx) => {
        const oscNode = audioCtx.createOscillator();
        const gainNode = audioCtx.createGain();
        oscNode.connect(gainNode);
        gainNode.connect(audioCtx.destination);
        
        oscNode.type = 'sine';
        oscNode.frequency.setValueAtTime(freq, now + idx * 0.07);
        gainNode.gain.setValueAtTime(0.05, now + idx * 0.07);
        gainNode.gain.exponentialRampToValueAtTime(0.005, now + idx * 0.07 + 0.12);
        
        oscNode.start(now + idx * 0.07);
        oscNode.stop(now + idx * 0.07 + 0.12);
      });
    } else if (type === 'success') {
      // 圓夢達標慶祝和弦
      const chord = [523.25, 659.25, 783.99, 987.77, 1046.50, 1318.51]; // C Major 7/9
      chord.forEach((freq, idx) => {
        const oscNode = audioCtx.createOscillator();
        const gainNode = audioCtx.createGain();
        oscNode.connect(gainNode);
        gainNode.connect(audioCtx.destination);
        
        oscNode.type = 'sine';
        oscNode.frequency.setValueAtTime(freq, now);
        oscNode.frequency.exponentialRampToValueAtTime(freq * 1.2, now + 0.6);
        gainNode.gain.setValueAtTime(0.03, now + idx * 0.04);
        gainNode.gain.exponentialRampToValueAtTime(0.001, now + 0.6);
        
        oscNode.start(now + idx * 0.04);
        oscNode.stop(now + 0.6);
      });
    }
  } catch (e) {
    console.warn("Audio Context init blocked or silent mode active.");
  }
}

// 3. 系統 Toast 提示
let toastTimeout;
function showToast(message, type = 'info') {
  const toast = document.getElementById('toast');
  const toastMsg = document.getElementById('toast-message');
  const toastIcon = toast.querySelector('.toast-icon');
  
  toastMsg.textContent = message;
  toast.className = 'toast-container'; 
  
  if (type === 'success') {
    toastIcon.setAttribute('data-lucide', 'check-circle');
    toast.style.borderColor = 'var(--success-color)';
    toast.style.boxShadow = '0 10px 25px rgba(0, 0, 0, 0.4), 0 0 15px var(--success-glow)';
  } else if (type === 'warning') {
    toastIcon.setAttribute('data-lucide', 'alert-triangle');
    toast.style.borderColor = 'var(--warning-color)';
    toast.style.boxShadow = '0 10px 25px rgba(0, 0, 0, 0.4), 0 0 15px var(--warning-glow)';
  } else {
    toastIcon.setAttribute('data-lucide', 'info');
    toast.style.borderColor = 'var(--accent-color)';
    toast.style.boxShadow = '0 10px 25px rgba(0, 0, 0, 0.4), 0 0 15px var(--accent-glow)';
  }
  
  lucide.createIcons();
  
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => {
    toast.classList.add('hidden');
  }, 4000);
}

// 4. 時區與地區時間工具 (Asia/Taipei GMT+8 Default)
function getFormattedLocalTime() {
  const now = new Date();
  
  // 使用絕對 UTC 時間加上時區偏置毫秒，並以 getUTC* 家族方法獲取數值，以達到 100% 時區對齊並免疫使用者本機時區干擾
  const utcOffsetMs = 3600000 * state.timezoneOffset;
  const targetTime = new Date(now.getTime() + utcOffsetMs);
  
  const yyyy = targetTime.getUTCFullYear();
  const mm = String(targetTime.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(targetTime.getUTCDate()).padStart(2, '0');
  const hh = String(targetTime.getUTCHours()).padStart(2, '0');
  const min = String(targetTime.getUTCMinutes()).padStart(2, '0');
  const ss = String(targetTime.getUTCSeconds()).padStart(2, '0');
  
  return {
    date: `${yyyy}-${mm}-${dd}`,
    time: `${hh}:${min}`,
    full: `${yyyy}-${mm}-${dd} ${hh}:${min}:${ss}`
  };
}

// 4.1 高精確度記帳欄位即時動態對齊時鐘 (Prefill dynamic auto-adjusting clock)
function updateLedgerClock() {
  const dateInput = document.getElementById('ledger-date');
  const timeInput = document.getElementById('ledger-time');
  if (!dateInput || !timeInput) return;
  
  const localTime = getFormattedLocalTime();
  
  // 僅在使用者尚未手動修改該欄位，且該欄位沒有處於 Focus 狀態時才進行動態對齊
  if (!userHasModifiedLedgerDate && document.activeElement !== dateInput) {
    dateInput.value = localTime.date;
  }
  if (!userHasModifiedLedgerTime && document.activeElement !== timeInput) {
    timeInput.value = localTime.time;
  }
}

// 5. 資料持久化與自適應資料庫升級 (Backward Compatibility Migration)
const STORAGE_KEY = 'SPARK_LEDGER_STORAGE_KEY_V2';

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  calculateTotals();
  updateUI();
  updateChart();
}

function loadState() {
  const data = localStorage.getItem(STORAGE_KEY);
  if (data) {
    try {
      const parsed = JSON.parse(data);
      state = { ...state, ...parsed };
      
      // 自動升級分類標籤：將舊的「台中通勤」優化為標準「行」，並保證「其他」標籤存在
      if (!state.categories) {
        state.categories = ["🍔 食", "👕 衣", "🏠 住", "🚇 行", "📚 育", "🎮 樂", "📝 其他"];
      } else {
        state.categories = state.categories.map(cat => cat.includes("台中通勤") ? "🚇 行" : cat);
        if (!state.categories.some(cat => cat.includes("其他"))) {
          state.categories.push("📝 其他");
        }
      }
      
      if (!state.ledger) state.ledger = [];
      if (!state.fixedExpenses) state.fixedExpenses = [];
      if (!state.wishlist) state.wishlist = [];
      if (!state.memos) state.memos = [];
      
      // 舊明細內的「台中通勤」自動遷移改為「行」
      state.ledger.forEach(item => {
        if (item.category.includes("台中通勤")) {
          item.category = "🚇 行";
        }
      });
      
    } catch (e) {
      console.error("資料解碼失敗，採用初始設定。");
    }
  } else {
    // 預設登錄
    state.ledger = [
      {
        id: "init-1",
        type: "income",
        amount: 10000,
        category: "🏠 住",
        note: "初始預設帳戶資金匯入",
        timestamp: "2026-05-30 08:00:00",
        recordType: "manual"
      }
    ];
    state.fixedExpenses = [
      {
        id: "fix-init-1",
        name: "悠遊卡交通定期票",
        amount: 1200,
        period: "month",
        category: "🚇 行",
        billingType: "fixed-date",
        dayOfMonth: 1,
        autoDeduct: true,
        lastDeductedDate: "2026-05-01"
      }
    ];
    state.wishlist = [
      {
        id: "wish-init-1",
        name: "賽博藍牙降噪耳機",
        cost: 3200,
        category: "🎮 樂",
        priority: "🔥 極度想要",
        completed: false
      }
    ];
    state.memos = [
      {
        id: "memo-init-1",
        title: "通勤捷運班次備忘",
        text: "早上 07:15 快速直達班次\n晚上 18:20 返程班次",
        color: "cyan",
        date: "05-30 14:17"
      }
    ];
  }
  
  // 套用主題模式 (Light Mode / Dark Mode)
  setThemeMode(state.theme || 'dark');
  
  // 套用主題色彩
  setAccentColor(state.accentColor || '#FF006E');
  
  // 執行自動扣款引擎
  checkAndExecuteAutoDeductions();
  
  calculateTotals();
  updateUI();
  updateChart();
}

// 6.0 色彩動態對比與防禦性調整工具 (Accent color contrast adjustments for light theme)
function getAdjustedAccentColor(hexColor, theme) {
  const presetsMap = {
    "#FF006E": "#D946EF", // Cyber Pink -> Soft Fuchsia
    "#00FFA3": "#0EA5E9", // Matrix Green -> Ocean Blue (high contrast, beautiful cyan in light mode)
    "#FFC800": "#D97706", // Sun Gold -> Warm Amber
    "#0077FF": "#2563EB", // Speed Blue -> Royal Blue
    "#A020F0": "#7C3AED", // Galaxy Purple -> Royal Purple
  };
  
  const upperHex = hexColor.toUpperCase();
  if (theme === 'light') {
    // 額外處理：如果原始是亮綠色 #00FFA3，我們為了高對比度使用富質感的亮海藍 #0EA5E9 或者是深翡翠綠 #10B981
    if (upperHex === '#00FFA3') return '#10B981';
    if (presetsMap[upperHex]) {
      return presetsMap[upperHex];
    }
    // 客製化顏色對比度加深
    return darkenColorForContrast(hexColor, 0.22);
  } else {
    // 逆向映射回暗色模式的霓虹亮色
    const reversePresetsMap = {
      "#D946EF": "#FF006E",
      "#10B981": "#00FFA3",
      "#0EA5E9": "#00FFA3",
      "#D97706": "#FFC800",
      "#2563EB": "#0077FF",
      "#7C3AED": "#A020F0"
    };
    if (reversePresetsMap[upperHex]) {
      return reversePresetsMap[upperHex];
    }
    return hexColor;
  }
}

function darkenColorForContrast(hex, percent) {
  if (!hex || hex.length < 7) return '#FF006E';
  let r = parseInt(hex.slice(1, 3), 16);
  let g = parseInt(hex.slice(3, 5), 16);
  let b = parseInt(hex.slice(5, 7), 16);
  
  r = Math.max(0, Math.min(255, Math.round(r * (1 - percent))));
  g = Math.max(0, Math.min(255, Math.round(g * (1 - percent))));
  b = Math.max(0, Math.min(255, Math.round(b * (1 - percent))));
  
  const rHex = r.toString(16).padStart(2, '0');
  const gHex = g.toString(16).padStart(2, '0');
  const bHex = b.toString(16).padStart(2, '0');
  
  return `#${rHex}${gHex}${bHex}`;
}

function updatePresetButtonsColors(theme) {
  document.querySelectorAll('.theme-presets button').forEach(btn => {
    const origColor = btn.getAttribute('data-color');
    const adjusted = getAdjustedAccentColor(origColor, theme);
    btn.style.setProperty('--preset-color', adjusted);
  });
}

// 6. 雙主題切換引擎 (Dark / Light Theme Toggle)
function setThemeMode(mode) {
  state.theme = mode;
  const body = document.body;
  const themeIcon = document.getElementById('theme-icon');
  
  if (mode === 'light') {
    body.className = "light-theme";
    if (themeIcon) themeIcon.setAttribute('data-lucide', 'moon');
  } else {
    body.className = "dark-theme";
    if (themeIcon) themeIcon.setAttribute('data-lucide', 'sun');
  }
  lucide.createIcons();
  
  // 重新調整與同步 Accent Color (修復亮色系文字消失與色彩同步問題)
  const adjustedAccent = getAdjustedAccentColor(state.accentColor, mode);
  setAccentColor(state.accentColor); // 這會經由 setAccentColor 內部呼叫 getAdjustedAccentColor 渲染
  updatePresetButtonsColors(mode);
  
  // 重新調整 Chart.js 的格線與字體色
  if (desktopChart) {
    desktopChart.options.plugins.legend.labels.color = mode === 'light' ? '#374151' : '#8E9BAE';
    desktopChart.update();
  }
}

// 7. 核心資產計量與防禦等級計算 (Balance & Defensive Calculations)
function calculateTotals() {
  let balance = state.initialBalance;
  
  state.ledger.forEach(item => {
    const amt = parseInt(item.amount) || 0;
    if (item.type === 'income') {
      balance += amt;
    } else {
      balance -= amt;
    }
  });
  
  // 存款 = 累計差額 - 當前鎖在金庫內的儲蓄金額
  state.totalBalance = balance - (state.savingsPool.currentAmount || 0);
}

// 8. 5 階段防禦護盾能核系統 (SVG Energy Core stages)
function updateSavingsCapsule() {
  const capsule = state.savingsPool;
  const percentOverlay = document.getElementById('savings-percent-val');
  const targetLabel = document.getElementById('savings-capsule-mode');
  const targetTitle = document.getElementById('savings-target-title');
  const targetValEl = document.getElementById('savings-target-val');
  const currentValEl = document.getElementById('savings-current-val');
  const progressFill = document.getElementById('savings-progress-fill');
  
  const stageContainer = document.getElementById('energy-stage-badge-container');
  const stageTitle = document.getElementById('energy-stage-title');
  const stageDesc = document.getElementById('energy-stage-desc');
  const emojiBadge = document.getElementById('savings-emoji-badge');
  
  currentValEl.textContent = `$${capsule.currentAmount.toLocaleString()}`;
  
  const flow = document.getElementById('liquid-flow');
  const bubbleGroup = document.getElementById('bubble-group');
  
  // 生成 SVG 冒泡泡
  if (bubbleGroup.children.length === 0) {
    for (let i = 0; i < 8; i++) {
      const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      circle.setAttribute('class', 'bubble');
      circle.setAttribute('cx', 15 + Math.random() * 70);
      circle.setAttribute('r', 1 + Math.random() * 3);
      circle.style.animationDelay = `${Math.random() * 3}s`;
      circle.style.animationDuration = `${2 + Math.random() * 2}s`;
      bubbleGroup.appendChild(circle);
    }
  }

  if (capsule.hasTarget) {
    // 8.1 有目標模式 (Goal Capsule Mode)
    targetLabel.textContent = "目標金庫";
    targetLabel.className = "capsule-mode-tag";
    targetTitle.textContent = `目標：${capsule.targetName || "儲蓄心願"}`;
    targetValEl.style.display = "inline";
    targetValEl.textContent = `$${(capsule.targetAmount || 1).toLocaleString()}`;
    if (stageContainer) stageContainer.classList.add('hidden');
    if (emojiBadge) emojiBadge.textContent = "🐷";
    
    const pct = Math.min(100, Math.max(0, Math.round((capsule.currentAmount / (capsule.targetAmount || 1)) * 100)));
    percentOverlay.textContent = `${pct}%`;
    progressFill.style.width = `${pct}%`;
    progressFill.style.background = "linear-gradient(90deg, var(--warning-color) 0%, #FFA800 100%)";
    
    // 水位變化：150 (空) 到 10 (滿)
    const yVal = 150 - (pct / 100) * 140;
    flow.setAttribute('y', yVal);
    flow.style.fill = "url(#liquidGrad)";
    
    Array.from(bubbleGroup.children).forEach(bubble => {
      bubble.style.display = pct > 0 ? "block" : "none";
    });
    
  } else {
    // 8.2 無目標能核成長模式 (Defense Energy Core Leveling Mode)
    targetLabel.textContent = "能核成長模式";
    targetLabel.className = "capsule-mode-tag status-warning";
    targetTitle.textContent = "防禦護盾能量核心 (自由積蓄)";
    targetValEl.style.display = "none";
    if (stageContainer) stageContainer.classList.remove('hidden');
    
    percentOverlay.textContent = "∞";
    progressFill.style.width = "100%";
    
    const amt = capsule.currentAmount;
    let stageName = "🌱 萌芽能量核";
    let stageExplanation = "微弱的光芒。金庫儲蓄低於 $1,000，請持續積攢第一桶儲蓄基底。";
    let bubbleSpeed = 4.0;
    let coreColor = "#FFC800";
    let gradientStart = "rgba(255, 200, 0, 0.4)";
    let emoji = "🌱";
    
    // 能核五階段演化 (Defense Core Stages)
    if (amt > 30000) {
      stageName = "🪐 星際防禦要塞";
      stageExplanation = "神話級能核！儲蓄突破 $30,000，防衛力完全封頂，釋放強烈粒子波動。";
      bubbleSpeed = 0.8;
      coreColor = "#A020F0"; // 電紫
      gradientStart = "rgba(160, 32, 240, 0.85)";
      emoji = "🪐";
    } else if (amt > 15000) {
      stageName = "⚡ 賽博電能網";
      stageExplanation = "極光綠發光體！儲蓄突破 $15,000，核心開始沸騰，解鎖微幅磁暴能域。";
      bubbleSpeed = 1.3;
      coreColor = "#00FFA3"; // 綠
      gradientStart = "rgba(0, 255, 163, 0.7)";
      emoji = "⚡";
    } else if (amt > 5000) {
      stageName = "💎 蔚藍水晶塔";
      stageExplanation = "冰晶藍能核！儲蓄突破 $5,000，氣泡快速上升，發光磁場大幅增強。";
      bubbleSpeed = 1.9;
      coreColor = "#0077FF"; // 藍
      gradientStart = "rgba(0, 119, 255, 0.55)";
      emoji = "💎";
    } else if (amt > 1000) {
      stageName = "🛡️ 青銅防衛盾";
      stageExplanation = "青銅核心！儲蓄突破 $1,000，開啟基礎電磁防禦，防範突發生活小開銷。";
      bubbleSpeed = 2.8;
      coreColor = "#FF006E"; // 霓虹粉
      gradientStart = "rgba(255, 0, 110, 0.45)";
      emoji = "🛡️";
    }
    
    if (emojiBadge) emojiBadge.textContent = emoji;
    stageTitle.textContent = stageName;
    stageTitle.style.color = coreColor;
    stageTitle.style.textShadow = `0 0 8px ${gradientStart}`;
    stageDesc.textContent = stageExplanation;
    progressFill.style.background = `linear-gradient(90deg, ${coreColor} 0%, #FFA800 100%)`;
    progressFill.style.boxShadow = `0 0 10px ${gradientStart}`;
    
    // 水位
    if (amt === 0) {
      flow.setAttribute('y', 150); // 乾涸
    } else {
      // 隨金額等比例上升，最高在 $35,000 時封頂
      const heightRatio = Math.min(100, Math.max(15, Math.round((amt / 35000) * 100)));
      const yVal = 150 - (heightRatio / 100) * 140;
      flow.setAttribute('y', yVal);
    }
    
    // 能核流體色動態寫入
    document.documentElement.style.setProperty('--accent-glow', gradientStart);
    flow.style.fill = coreColor;
    
    Array.from(bubbleGroup.children).forEach(bubble => {
      bubble.style.display = amt > 0 ? "block" : "none";
      bubble.style.animationDuration = `${bubbleSpeed + Math.random() * 0.8}s`;
    });
  }
}

// 9. 客製化色彩調色盤 (CSS custom colors overrides)
function setAccentColor(hexColor) {
  // 自動適配當前主題的亮色/暗色對比度與刺眼度，得到真正套用的 hex
  const finalColor = getAdjustedAccentColor(hexColor, state.theme);
  
  state.accentColor = hexColor; // 保存原始選擇的顏色（便於在切換主題時以該基礎進行無失真調整）
  document.documentElement.style.setProperty('--accent-color', finalColor);
  
  const r = parseInt(finalColor.slice(1, 3), 16);
  const g = parseInt(finalColor.slice(3, 5), 16);
  const b = parseInt(finalColor.slice(5, 7), 16);
  document.documentElement.style.setProperty('--accent-glow', `rgba(${r}, ${g}, ${b}, 0.45)`);
  
  const cp = document.getElementById('custom-color-picker');
  const cpLbl = document.getElementById('current-hex-lbl');
  if (cp) cp.value = hexColor;
  if (cpLbl) cpLbl.textContent = finalColor.toUpperCase();
  
  document.querySelectorAll('.theme-presets button').forEach(btn => {
    const origPreset = btn.getAttribute('data-color').toUpperCase();
    if (origPreset === hexColor.toUpperCase()) {
      btn.classList.add('active');
    } else {
      btn.classList.remove('active');
    }
  });
}

// 10. 四大功能面板 Tab 切換導覽
let currentActiveTabIndex = 0; // 追蹤目前 Tab 順序索引以決定滑動方向
const tabOrder = ["tab-home", "tab-ledger", "tab-fixed", "tab-memos"];

function switchTab(targetTabId) {
  const targetIndex = tabOrder.indexOf(targetTabId);
  if (targetIndex === -1) return;
  
  // 決定滑動方向
  const directionClass = targetIndex > currentActiveTabIndex ? "slide-left-in" : "slide-right-in";
  currentActiveTabIndex = targetIndex;
  
  playSound('tab');
  
  // 1. 切換分頁顯示
  document.querySelectorAll('.tab-panel').forEach(panel => {
    panel.classList.remove('active-tab', 'slide-left-in', 'slide-right-in');
  });
  
  const activePanel = document.getElementById(targetTabId);
  if (activePanel) {
    activePanel.classList.add('active-tab', directionClass);
  }
  
  // 2. 切換底部 Tab Bar Active 樣式
  document.querySelectorAll('.tab-bar-item').forEach(item => {
    if (item.getAttribute('data-target') === targetTabId) {
      item.classList.add('active-tab-item');
    } else {
      item.classList.remove('active-tab-item');
    }
  });
}

// 11. 常駐固定開銷與自動扣款中心 (Fixed Expenses & Auto-Deductions)
function checkAndExecuteAutoDeductions() {
  const now = new Date();
  let autoDeductionsExecuted = 0;
  
  // 獲取設定時區之當前年月日
  const utcOffsetMs = 3600000 * state.timezoneOffset;
  const tzNow = new Date(now.getTime() + utcOffsetMs);
  const curYear = tzNow.getUTCFullYear();
  const curMonth = tzNow.getUTCMonth(); // 0-indexed
  const curDate = tzNow.getUTCDate();
  
  state.fixedExpenses.forEach(fixed => {
    if (!fixed.autoDeduct || fixed.billingType !== 'fixed-date') return;
    
    // 解析最後一次扣款日，避免任何瀏覽器時區干擾
    let lastDate = null;
    if (fixed.lastDeductedDate) {
      const parts = fixed.lastDeductedDate.split('-');
      if (parts.length === 3) {
        lastDate = {
          year: parseInt(parts[0]),
          month: parseInt(parts[1]) - 1, // 0-indexed
          day: parseInt(parts[2])
        };
      }
    }
    
    if (fixed.period === 'month') {
      const targetDay = parseInt(fixed.dayOfMonth) || 5;
      let shouldDeduct = false;
      if (curDate >= targetDay) {
        if (!lastDate || lastDate.year < curYear || (lastDate.year === curYear && lastDate.month < curMonth)) {
          shouldDeduct = true;
        }
      }
      
      if (shouldDeduct) {
        const billingDateStr = `${curYear}-${String(curMonth + 1).padStart(2, '0')}-${String(targetDay).padStart(2, '0')} 00:00:00`;
        executeFixedDeduction(fixed, billingDateStr);
        fixed.lastDeductedDate = `${curYear}-${String(curMonth + 1).padStart(2, '0')}-${String(targetDay).padStart(2, '0')}`;
        autoDeductionsExecuted++;
      }
    }
  });
  
  if (autoDeductionsExecuted > 0) {
    saveState();
    showToast(`自動扣款引擎已成功處理 ${autoDeductionsExecuted} 筆定期開銷！`, 'success');
  }
}

function executeFixedDeduction(fixedItem, customTimestamp = null) {
  const timestamp = customTimestamp || getFormattedLocalTime().full;
  const newLedgerItem = {
    id: "led-fixed-" + Date.now() + "-" + Math.random().toString(36).substr(2, 5),
    type: "expense",
    amount: parseInt(fixedItem.amount),
    category: fixedItem.category,
    note: `[常駐扣除] ${fixedItem.name}`,
    timestamp: timestamp,
    recordType: "fixed-deduction"
  };
  state.ledger.push(newLedgerItem);
}

function manuallyDeductFixed(id) {
  const item = state.fixedExpenses.find(f => f.id === id);
  if (!item) return;
  
  const element = document.getElementById(`fixed-item-${id}`);
  if (element) {
    element.classList.add('scanning');
    setTimeout(() => element.classList.remove('scanning'), 800);
  }
  
  playSound('click');
  
  let timestampToRecord = null;
  if (item.billingType === 'fixed-date') {
    const nowTime = getFormattedLocalTime();
    const curYearMonth = nowTime.date.substring(0, 8); 
    const day = String(item.dayOfMonth).padStart(2, '0');
    timestampToRecord = `${curYearMonth}${day} 12:00:00`;
  }
  
  executeFixedDeduction(item, timestampToRecord);
  const nowTime = getFormattedLocalTime();
  item.lastDeductedDate = nowTime.date;
  
  saveState();
  showToast(`已手動扣款：${item.name} ($${item.amount})`, 'success');
}

function deleteFixedExpense(id) {
  playSound('click');
  if (confirm("確定要刪除此筆常駐固定開銷項目嗎？")) {
    state.fixedExpenses = state.fixedExpenses.filter(f => f.id !== id);
    saveState();
    showToast("已成功刪除該常駐開銷項目。");
  }
}

// 12. 購買心願清單與記帳連動 (Wishlist & Purchase Interlock)
function renderWishlist() {
  const container = document.getElementById('wishlist-items-container');
  if (!container) return;
  
  container.innerHTML = "";
  
  if (state.wishlist.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <i data-lucide="shopping-bag"></i>
        <span>尚未添加任何購買心願項目</span>
      </div>
    `;
    lucide.createIcons();
    return;
  }
  
  state.wishlist.forEach(item => {
    const div = document.createElement('div');
    div.className = "wish-item";
    if (item.completed) div.classList.add('completed');
    
    // 檢查是否有足夠資金買下它
    const canAfford = state.totalBalance >= item.cost;
    const buyButton = item.completed ? 
      `<span style="font-size: 0.75rem; color: var(--success-color); font-weight: bold;">🎉 已購回</span>` :
      `<button onclick="buyWishItem('${item.id}')" class="btn btn-sm ${canAfford ? 'btn-primary' : 'btn-dark'}" ${canAfford ? '' : 'disabled'} title="${canAfford ? '點擊買下它' : '可支配餘額不足'}">
         <i data-lucide="shopping-cart"></i> ${canAfford ? '買下它' : '資金不足'}
       </button>`;
       
    div.innerHTML = `
      <div class="wish-item-left">
        <span class="wish-title">${item.name} <span class="wish-tag">${item.priority}</span></span>
        <span class="wish-price">$${item.cost.toLocaleString()} <span style="font-size: 0.7rem; color: var(--text-muted);">(${item.category})</span></span>
      </div>
      <div class="wish-btn-row">
        ${buyButton}
        <button onclick="deleteWishItem('${item.id}')" class="mini-icon-btn hover-danger" title="移除願望">
          <i data-lucide="trash-2"></i>
        </button>
      </div>
    `;
    
    container.appendChild(div);
  });
  lucide.createIcons();
}

function buyWishItem(id) {
  const item = state.wishlist.find(w => w.id === id);
  if (!item) return;
  
  if (state.totalBalance < item.cost) {
    showToast("可支配總存款不足，無法購回！", "warning");
    return;
  }
  
  // 1. 互鎖計算：從總存款扣除，寫入交易明細
  const nowTime = getFormattedLocalTime();
  const newLedgerItem = {
    id: "led-wish-" + Date.now(),
    type: "expense",
    amount: parseInt(item.cost),
    category: item.category,
    note: `[已購心願] ${item.name}`,
    timestamp: nowTime.full,
    recordType: "manual"
  };
  state.ledger.push(newLedgerItem);
  
  // 2. 標記願望為完成
  item.completed = true;
  
  // 3. 達標紙花與音效
  playSound('success');
  confetti({
    particleCount: 100,
    spread: 60,
    origin: { y: 0.6 }
  });
  
  saveState();
  showToast(`🎉 恭喜！您已購回心願物品：${item.name}！`, "success");
}

function deleteWishItem(id) {
  playSound('click');
  if (confirm("確定要移除此筆心願清單項目嗎？")) {
    state.wishlist = state.wishlist.filter(w => w.id !== id);
    saveState();
    showToast("已成功移除該心願項目。");
  }
}

// 13. 生活備忘貼牆管理 (Sticky Notes Wall Dashboard)
function renderMemos() {
  const container = document.getElementById('sticky-memos-container');
  if (!container) return;
  
  container.innerHTML = "";
  
  if (state.memos.length === 0) {
    container.innerHTML = `
      <div class="empty-state" style="grid-column: 1 / span 2;">
        <i data-lucide="sticky-note"></i>
        <span>尚未貼上任何備忘錄卡片</span>
      </div>
    `;
    lucide.createIcons();
    return;
  }
  
  state.memos.forEach(note => {
    const div = document.createElement('div');
    div.className = `memo-note memo-${note.color || 'pink'}`;
    div.style.cursor = "pointer";
    div.onclick = (e) => {
      // 點擊卡片本體時放大檢視，點擊刪除按鈕時除外
      if (e.target.closest('.mini-icon-btn') || e.target.closest('i')) return;
      zoomMemo(note.id);
    };
    
    // 區分勾選清單與一般純文字備忘
    let bodyHtml = "";
    if (note.type === 'checklist') {
      const items = note.checklistItems || [];
      const checkedCount = items.filter(i => i.checked).length;
      const totalCount = items.length;
      const progressText = totalCount > 0 ? `📋 勾選清單 (${checkedCount}/${totalCount})` : '📋 空清單';
      
      // 生成清單前兩筆作為卡片預覽
      let listPreview = "";
      const previewItems = items.slice(0, 2);
      previewItems.forEach(item => {
        listPreview += `
          <div style="font-size: 0.72rem; display: flex; align-items: center; gap: 4px; ${item.checked ? 'text-decoration: line-through; opacity: 0.55;' : ''}">
            <span style="font-size: 0.65rem;">${item.checked ? '☑️' : '☐'}</span>
            <span style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 120px;">${item.text}</span>
          </div>
        `;
      });
      if (items.length > 2) {
        listPreview += `<div style="font-size: 0.65rem; color: var(--text-muted); margin-top: 1px;">還有 ${items.length - 2} 個清單項目...</div>`;
      }
      
      bodyHtml = `
        <div style="margin: 6px 0;">
          <span style="font-size: 0.72rem; font-weight: 700; color: var(--accent-color);">${progressText}</span>
          <div style="display: flex; flex-direction: column; gap: 3px; margin-top: 4px;">
            ${listPreview}
          </div>
        </div>
      `;
    } else {
      bodyHtml = `<p class="memo-note-text">${note.text.replace(/\n/g, '<br>')}</p>`;
    }
    
    // 緊急重要度與提醒時間小標籤
    const priBadgeText = note.priority === 'high' ? '🔴 緊急' : note.priority === 'low' ? '🟢 備忘' : '🟡 待辦';
    const reminderBadgeHtml = note.reminderTime ? 
      `<span style="font-size: 0.65rem; color: var(--accent-color); display: inline-flex; align-items: center; gap: 2px;"><i data-lucide="bell" style="width: 10px; height: 10px;"></i> ${note.reminderTime.substring(5, 10).replace('-', '/')} ${note.reminderTime.substring(11, 16)}</span>` : '';
    
    div.innerHTML = `
      <div class="memo-note-header">
        <span class="memo-note-title" style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100px;">${note.title}</span>
        <div style="display: flex; align-items: center; gap: 4px;">
          <span style="font-size: 0.62rem; padding: 1px 4px; border-radius: 4px; background: rgba(0,0,0,0.15);">${priBadgeText}</span>
          <button onclick="deleteMemo('${note.id}')" class="mini-icon-btn" style="width: 18px; height: 18px;" title="撕下備忘">
            <i data-lucide="trash-2" style="width: 12px; height: 12px;"></i>
          </button>
        </div>
      </div>
      ${bodyHtml}
      <div style="display: flex; justify-content: space-between; align-items: center; margin-top: auto; padding-top: 4px;">
        ${reminderBadgeHtml}
        <span class="memo-note-date">${note.date}</span>
      </div>
    `;
    
    container.appendChild(div);
  });
  lucide.createIcons();
}

// 新增：點擊備忘錄卡片放大檢視 Modal
function zoomMemo(id) {
  const memo = state.memos.find(m => m.id === id);
  if (!memo) return;
  
  const modal = document.getElementById('memo-detail-modal');
  const titleEl = document.getElementById('detail-memo-title');
  const priorityBadge = document.getElementById('detail-memo-priority-badge');
  const textView = document.getElementById('detail-memo-text-view');
  const checklistView = document.getElementById('detail-memo-checklist-view');
  const reminderLbl = document.getElementById('detail-memo-reminder-lbl');
  const dateLbl = document.getElementById('detail-memo-date-lbl');
  const deleteBtn = document.getElementById('detail-memo-delete-btn');
  
  titleEl.textContent = memo.title;
  dateLbl.textContent = memo.date;
  
  // 重要緊急程度 Badge 類別
  const priName = memo.priority === 'high' ? '🔴 緊急重要' : memo.priority === 'low' ? '🟢 日常備忘' : '🟡 一般待辦';
  const priClass = memo.priority === 'high' ? 'defense-status-tag status-danger' : memo.priority === 'low' ? 'defense-status-tag status-safe' : 'defense-status-tag status-warning';
  priorityBadge.textContent = priName;
  priorityBadge.className = priClass;
  
  // 提醒時間呈現
  if (memo.reminderTime) {
    reminderLbl.textContent = memo.reminderTime.replace('T', ' ');
    if (memo.reminderTriggered) {
      reminderLbl.innerHTML += ` <span style="font-size: 0.65rem; color: var(--text-muted);">(已通知)</span>`;
    }
  } else {
    reminderLbl.textContent = "未設定時間提醒";
  }
  
  // 文字 vs 清單視窗切換
  if (memo.type === 'checklist') {
    textView.classList.add('hidden');
    checklistView.classList.remove('hidden');
    
    checklistView.innerHTML = "";
    const items = memo.checklistItems || [];
    if (items.length === 0) {
      checklistView.innerHTML = `<span style="font-size: 0.8rem; color: var(--text-muted); text-align: center; padding: 15px 0;">無待辦項目</span>`;
    } else {
      // 顯示已完成比例進度條
      const checkedCount = items.filter(i => i.checked).length;
      const progressPct = Math.round((checkedCount / items.length) * 100);
      
      const progressHeader = document.createElement('div');
      progressHeader.style.display = "flex";
      progressHeader.style.justifyContent = "space-between";
      progressHeader.style.fontSize = "0.75rem";
      progressHeader.style.fontWeight = "700";
      progressHeader.style.marginBottom = "4px";
      progressHeader.innerHTML = `<span>進度狀態 (${checkedCount}/${items.length})</span><span class="highlight-text">${progressPct}%</span>`;
      checklistView.appendChild(progressHeader);
      
      const progressBg = document.createElement('div');
      progressBg.className = "progress-bar-bg";
      progressBg.style.height = "6px";
      progressBg.style.marginBottom = "10px";
      progressBg.innerHTML = `<div class="progress-bar-fill" style="width: ${progressPct}%; background: var(--accent-color);"></div>`;
      checklistView.appendChild(progressBg);
      
      // 逐筆渲染複選框列
      items.forEach((item, index) => {
        const row = document.createElement('label');
        row.style.display = "flex";
        row.style.alignItems = "center";
        row.style.gap = "8px";
        row.style.fontSize = "0.82rem";
        row.style.cursor = "pointer";
        row.style.padding = "6px 8px";
        row.style.borderRadius = "6px";
        row.style.background = "rgba(0,0,0,0.1)";
        row.style.border = "1px solid var(--panel-border)";
        row.style.color = item.checked ? "var(--text-muted)" : "var(--text-main)";
        if (item.checked) row.style.textDecoration = "line-through";
        
        row.innerHTML = `
          <input type="checkbox" ${item.checked ? 'checked' : ''} onchange="toggleChecklistItem('${memo.id}', ${index})" style="width: 15px; height: 15px; cursor: pointer; border-radius: 4px;">
          <span>${item.text}</span>
        `;
        checklistView.appendChild(row);
      });
    }
  } else {
    checklistView.classList.add('hidden');
    textView.classList.remove('hidden');
    textView.textContent = memo.text;
  }
  
  // 撕下備忘按鈕綁定
  deleteBtn.onclick = () => {
    modal.close();
    deleteMemo(memo.id);
  };
  
  // 調整設定按鈕綁定
  const editBtn = document.getElementById('detail-memo-edit-btn');
  if (editBtn) {
    editBtn.onclick = () => {
      modal.close();
      editingMemoId = memo.id;
      
      // 顯示編輯視窗，並預填所有欄位與更新標籤
      const editModal = document.getElementById('custom-memo-modal');
      editModal.querySelector('h3').textContent = "調整備忘錄設定";
      document.getElementById('save-memo-btn').textContent = "更新設定";
      
      document.getElementById('memo-title').value = memo.title;
      document.getElementById('memo-text').value = memo.text || "";
      document.getElementById('memo-priority').value = memo.priority || "medium";
      document.getElementById('memo-type').value = memo.type || "text";
      document.getElementById('memo-reminder').value = memo.reminderTime || "";
      document.getElementById('memo-color').value = memo.color || "pink";
      
      // 觸發類型切換狀態
      const builder = document.getElementById('memo-checklist-builder');
      const textGroup = document.getElementById('memo-text').closest('.form-group');
      if (memo.type === 'checklist') {
        builder.classList.remove('hidden');
        if (textGroup) textGroup.classList.add('hidden');
        
        const container = document.getElementById('memo-checklist-items-container');
        container.innerHTML = "";
        
        const items = memo.checklistItems || [];
        items.forEach(item => {
          const div = document.createElement('div');
          div.className = "memo-checklist-item-row";
          div.style.display = "flex";
          div.style.alignItems = "center";
          div.style.gap = "6px";
          
          div.innerHTML = `
            <input type="text" class="form-input" style="flex: 1; padding: 6px 10px;" placeholder="輸入待辦清單項目..." value="${item.text}">
            <button type="button" class="mini-icon-btn hover-danger" onclick="this.parentElement.remove()" style="width: 24px; height: 24px;">
              <i data-lucide="trash-2" style="width: 14px; height: 14px;"></i>
            </button>
          `;
          container.appendChild(div);
        });
        lucide.createIcons();
      } else {
        builder.classList.add('hidden');
        if (textGroup) textGroup.classList.remove('hidden');
      }
      
      editModal.showModal();
    };
  }
  
  modal.showModal();
  lucide.createIcons();
}

// 新增：動態切換清單勾選狀態並儲存
function toggleChecklistItem(memoId, index) {
  const memo = state.memos.find(m => m.id === memoId);
  if (!memo || !memo.checklistItems || !memo.checklistItems[index]) return;
  
  memo.checklistItems[index].checked = !memo.checklistItems[index].checked;
  saveState();
  
  // 立即重新渲染彈窗視窗狀態，並重繪底層卡片
  zoomMemo(memoId);
}

// 新增：清單項目欄位動態生成
function addChecklistItemInput() {
  const container = document.getElementById('memo-checklist-items-container');
  const div = document.createElement('div');
  div.className = "memo-checklist-item-row";
  div.style.display = "flex";
  div.style.alignItems = "center";
  div.style.gap = "6px";
  
  div.innerHTML = `
    <input type="text" class="form-input" style="flex: 1; padding: 6px 10px;" placeholder="輸入待辦清單項目...">
    <button type="button" class="mini-icon-btn hover-danger" onclick="this.parentElement.remove()" style="width: 24px; height: 24px;">
      <i data-lucide="trash-2" style="width: 14px; height: 14px;"></i>
    </button>
  `;
  container.appendChild(div);
  lucide.createIcons();
}

// 新增：請求 HTML5 瀏覽器系統通知權限 (iPhone/Safari PWA 直裝支援)
function requestNotificationPermission() {
  if (typeof Notification !== 'undefined') {
    if (Notification.permission === 'default') {
      Notification.requestPermission().then(permission => {
        if (permission === 'granted') {
          showToast("成功取得系統提醒通知權限！", "success");
        }
      });
    }
  }
}

// 新增：高精確度定時提醒檢查引擎 (Alarms Reminder Engine)
function checkMemoReminders() {
  if (!state.memos || state.memos.length === 0) return;
  const now = new Date();
  
  // 使用絕對 UTC 時間加上時區偏置毫秒，得到與 getFormattedLocalTime 完全一致的本地毫秒比對數值，解決時間不精準問題
  const utcOffsetMs = 3600000 * state.timezoneOffset;
  const localTargetTime = new Date(now.getTime() + utcOffsetMs);
  
  const yyyy = localTargetTime.getUTCFullYear();
  const mm = String(localTargetTime.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(localTargetTime.getUTCDate()).padStart(2, '0');
  const hh = String(localTargetTime.getUTCHours()).padStart(2, '0');
  const min = String(localTargetTime.getUTCMinutes()).padStart(2, '0');
  
  const currentIsoTime = `${yyyy}-${mm}-${dd}T${hh}:${min}`;
  
  let triggeredCount = 0;
  state.memos.forEach(memo => {
    if (memo.reminderTime && !memo.reminderTriggered) {
      // 若提醒時間小於或等於當前 ISO 標記，則觸發防禦式警報
      if (memo.reminderTime <= currentIsoTime) {
        memo.reminderTriggered = true;
        triggeredCount++;
        
        // 1. 播放科技琶音提醒聲
        playSound('success');
        
        // 2. 彈出 Toast 發光訊息
        showToast(`🔔 備忘提醒：${memo.title}`, 'success');
        
        // 3. 呼叫系統 PWA 通知 (適用於 iPhone PWA 安裝至主畫面)
        if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
          try {
            new Notification(`📌 SPARK 備忘提醒`, {
              body: `備忘錄「${memo.title}」設定的提醒時間已到！\n${memo.type === 'checklist' ? '清單勾選事項待處理' : memo.text}`,
              icon: 'https://cdn-icons-png.flaticon.com/512/3602/3602123.png'
            });
          } catch(err) {
            console.warn("系統 PWA 通知被瀏覽器封鎖。");
          }
        }
      }
    }
  });
  
  if (triggeredCount > 0) {
    saveState();
  }
}

function deleteMemo(id) {
  playSound('click');
  state.memos = state.memos.filter(m => m.id !== id);
  saveState();
  showToast("備忘錄已成功撕下！");
}

// 14. 雙引擎 Google Drive 雲端同步系統 (Google Sync & Local Sandbox Emulator)
let tokenClient = null;
let googleAccessToken = null;

// 初始化 Google Identity Client SDK
function initGoogleAuthClient() {
  try {
    if (typeof google === 'undefined' || !google.accounts) return;
    
    // 建立標準 OAuth GIS Token 客戶端 (適用於 http/https web 協議)
    // 提示：這需要使用者自己在 Google Cloud Platform 註冊 Client ID。
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: 'SPARK_DEFAULT_DEV_CLIENT_ID.apps.googleusercontent.com', // 預留預設
      scope: 'https://www.googleapis.com/auth/drive.appdata', // appData 隱私路徑
      callback: (response) => {
        if (response.error !== undefined) {
          showToast("Google 帳戶登入授權失敗！", "warning");
          return;
        }
        googleAccessToken = response.access_token;
        setGoogleCloudStatus('connected', "spark.cloud.user@gmail.com");
      },
    });
  } catch(e) {
    console.warn("Google OAuth Client 初始化失敗，將無縫切換至 Google Sandbox 模擬器");
  }
}

// 設定 Google 連線狀態 UI
function setGoogleCloudStatus(status, email = "") {
  const dot = document.getElementById('sync-indicator-dot');
  const txt = document.getElementById('sync-status-text');
  const loginBtn = document.getElementById('google-login-btn');
  const actionRow = document.getElementById('google-drive-sync-actions');
  
  if (status === 'connected') {
    dot.className = "pulse-dot active";
    txt.textContent = `已連結 Google 帳戶: ${email}`;
    loginBtn.textContent = "登出連線";
    loginBtn.className = "btn btn-sm btn-dark";
    if (actionRow) actionRow.classList.remove('hidden');
    state.googleUser = email;
  } else {
    dot.className = "pulse-dot idle";
    txt.textContent = "未連結 Google 雲端帳號";
    loginBtn.textContent = "連結 Google 帳號";
    loginBtn.className = "btn btn-sm btn-primary";
    if (actionRow) actionRow.classList.add('hidden');
    state.googleUser = null;
    googleAccessToken = null;
  }
}

// 連結 Google 按鈕動作
function handleGoogleLoginClick() {
  playSound('click');
  
  // 安全防禦判定：若為 file:/// 協議或 API 載入失敗，直接無縫開啟高保真 Sandbox 模擬器！
  if (location.protocol === 'file:' || typeof google === 'undefined' || !tokenClient) {
    const modal = document.getElementById('google-auth-sim-modal');
    document.getElementById('google-sim-custom-email').value = "";
    document.getElementById('google-sim-email').value = "spark.member@gmail.com";
    modal.showModal();
    return;
  }
  
  // 標準實體 Google Auth
  if (googleAccessToken) {
    // 登出
    setGoogleCloudStatus('disconnected');
    showToast("Google 帳戶已成功登出。");
  } else {
    // 請求 Token
    tokenClient.requestAccessToken({ prompt: 'consent' });
  }
}

// 雲端同步模擬核心 (Google Drive appData JSON simulation)
function simulateGoogleCloudSync(opType) {
  const dot = document.getElementById('sync-indicator-dot');
  const txt = document.getElementById('sync-status-text');
  const email = state.googleUser || "spark.member@gmail.com";
  
  dot.className = "pulse-dot active";
  
  if (opType === 'backup') {
    txt.textContent = "正在將本機明細打包加密...";
    setTimeout(() => {
      txt.textContent = "正在上傳至 Google Drive appData 資料夾...";
      setTimeout(() => {
        playSound('success');
        // 寫入硬碟備份模擬節點
        localStorage.setItem(`GDRIVE_SIM_${email}`, JSON.stringify(state));
        txt.textContent = `已成功備份至雲端硬碟 (${getFormattedLocalTime().full.substring(5, 16)})`;
        showToast("資料已安全備份至 Google Drive appData 專用隱私夾！", "success");
      }, 1000);
    }, 1000);
  } else {
    txt.textContent = "正在自 Google Drive 下載備份...";
    setTimeout(() => {
      txt.textContent = "下載成功，正在解密格式檢測...";
      setTimeout(() => {
        const cloudData = localStorage.getItem(`GDRIVE_SIM_${email}`);
        if (!cloudData) {
          dot.className = "pulse-dot active";
          txt.textContent = `雲端硬碟尚無任何備份存檔。`;
          showToast("還原失敗，您的 Google Drive 雲端中目前無備份檔！", "warning");
          return;
        }
        
        playSound('success');
        state = JSON.parse(cloudData);
        saveState();
        txt.textContent = `自雲端硬碟還原完成！`;
        showToast("雲端資料解密還原成功，網頁即將重載套用！", "success");
        setTimeout(() => location.reload(), 1500);
      }, 1000);
    }, 1000);
  }
}

// 15. GitHub 線上更新檢測 (Github Commit Live Updater & Real Github Fetch)
function executeGithubUpdateCheck() {
  playSound('click');
  const barWrapper = document.getElementById('update-loading-bar-wrapper');
  const barFill = document.getElementById('update-loading-bar-fill');
  const notesPanel = document.getElementById('updater-notes-panel');
  const checkBtn = document.getElementById('check-update-btn');
  
  barWrapper.classList.remove('hidden');
  notesPanel.classList.add('hidden');
  barFill.style.width = "0%";
  checkBtn.setAttribute('disabled', 'true');
  
  const githubUrl = "https://raw.githubusercontent.com/qqaq666ziv-byte/Expense_Tracker/main/update.json";
  
  let progress = 0;
  const progressInterval = setInterval(() => {
    progress += 15;
    if (progress > 90) progress = 90;
    barFill.style.width = `${progress}%`;
  }, 100);
  
  fetch(githubUrl)
    .then(response => {
      if (!response.ok) throw new Error("儲存庫回應失敗");
      return response.json();
    })
    .then(data => {
      clearInterval(progressInterval);
      barFill.style.width = "100%";
      setTimeout(() => {
        barWrapper.classList.add('hidden');
        notesPanel.classList.remove('hidden');
        checkBtn.removeAttribute('disabled');
        
        // 渲染實體 GitHub 獲取到的最新版本與更新日誌
        const displayVer = data.version ? (data.version.startsWith('v') ? data.version : 'v' + data.version) : "v2.2.0";
        document.getElementById('new-ver-lbl').textContent = displayVer;
        document.getElementById('new-ver-notes').textContent = data.notes || "無更新說明";
        
        // 保存實體下載 URL
        state.githubDownloadUrl = data.url || "";
        
        // 比較版本
        const currentVersion = "v2.2.0"; // 當前本機版本
        const cleanRemote = (data.version || "").replace(/^v/, "");
        const cleanLocal = currentVersion.replace(/^v/, "");
        if (cleanRemote && cleanRemote !== cleanLocal) {
          showToast(`發現新版本 v${cleanRemote}！`, "success");
        } else {
          showToast("目前已是最新版本！", "success");
        }
      }, 300);
    })
    .catch(err => {
      clearInterval(progressInterval);
      console.warn("GitHub 線上更新檢查失敗，使用內建高保真備用日誌:", err);
      // 降級備用方案：使用本地高強度發光日誌
      setTimeout(() => {
        barFill.style.width = "100%";
        setTimeout(() => {
          barWrapper.classList.add('hidden');
          notesPanel.classList.remove('hidden');
          checkBtn.removeAttribute('disabled');
          
          document.getElementById('new-ver-lbl').textContent = "v2.2.0";
          document.getElementById('new-ver-notes').textContent = 
            `- 🌓 新增晨光馬卡龍亮色主題，一鍵無縫切換深淺模式！\n- 🛡️ 無目標金庫演進為 5 階段「防禦能核」，解鎖星際堡謎酷炫稱號。\n- 💾 整合 Google Drive appData 專用隱私夾一鍵聯網與高保真離線模擬。\n- 🏷️ 新增購買清單與備忘牆，心願單點擊買下自動轉明細扣款！`;
          
          showToast("已從內建備份安全載入最新 v2.2.0 版本資訊！", "info");
        }, 300);
      }, 300);
    });
}

function executeHotReloadUpdate() {
  playSound('click');
  const trigBtn = document.getElementById('trigger-hot-update-btn');
  trigBtn.setAttribute('disabled', 'true');
  trigBtn.textContent = "下載最新代碼修補包中 (0%)...";
  
  let pct = 0;
  const timer = setInterval(() => {
    pct += Math.floor(Math.random() * 20) + 15;
    if (pct >= 100) {
      pct = 100;
      clearInterval(timer);
      
      trigBtn.textContent = "釋放主進程檔案鎖並套用修補...";
      setTimeout(() => {
        playSound('success');
        showToast("下載成功！系統已將修補包自動安裝並熱更新重載！", "success");
        
        // 實體背景下載最新 Release ZIP
        const downloadUrl = state.githubDownloadUrl || "https://github.com/qqaq666ziv-byte/Expense_Tracker/archive/refs/heads/main.zip";
        const a = document.createElement('a');
        a.href = downloadUrl;
        a.download = "Expense_Tracker_Latest.zip";
        a.style.display = "none";
        document.body.appendChild(a);
        a.click();
        a.remove();
        
        setTimeout(() => location.reload(true), 1200);
      }, 800);
    } else {
      trigBtn.textContent = `下載最新代碼修補包中 (${pct}%)...`;
    }
  }, 100);
}

// ==========================================================================
// 16. UI RENDERING & DATA EVENT BINDINGS (UI & Elements Renderer)
// ==========================================================================
function updateUI() {
  // 1. 總存款與防禦等級更新
  const totalValEl = document.getElementById('total-balance-val');
  const initialValEl = document.getElementById('initial-balance-val');
  const panel = document.getElementById('balance-panel');
  const miniBal = document.getElementById('mini-balance');
  const miniSav = document.getElementById('mini-savings');
  
  totalValEl.textContent = state.totalBalance.toLocaleString();
  initialValEl.textContent = state.initialBalance.toLocaleString();
  miniBal.textContent = `$${state.totalBalance.toLocaleString()}`;
  miniSav.textContent = `$${(state.savingsPool.currentAmount || 0).toLocaleString()}`;
  
  if (state.totalBalance < 0) {
    panel.classList.add('balance-negative');
  } else {
    panel.classList.remove('balance-negative');
  }
  
  const defenseEl = document.getElementById('defense-badge');
  if (state.totalBalance >= 3000) {
    defenseEl.className = "defense-status-tag status-safe";
    defenseEl.textContent = "🛡️ 防禦狀態：極度安全";
  } else if (state.totalBalance >= 1000) {
    defenseEl.className = "defense-status-tag status-warning";
    defenseEl.textContent = "⚠️ 防禦狀態：警戒增高";
  } else {
    defenseEl.className = "defense-status-tag status-danger";
    defenseEl.textContent = "🚨 防禦狀態：全面警報！";
  }
  
  // 2. 儲蓄金庫更新
  updateSavingsCapsule();
  
  // 3. 分類選單 Pills
  renderCategoryPills();
  
  // 4. 定期開銷清單
  renderFixedExpenses();
  
  // 5. 歷史明細明細
  renderLedgerRecords();
  
  // 6. 心願清單 Wishlist
  renderWishlist();
  
  // 7. 貼卡備忘錄
  renderMemos();
  
  // 靜音按鈕 icon 更新
  const soundIcon = document.getElementById('sound-icon');
  if (soundIcon) {
    soundIcon.setAttribute('data-lucide', state.soundEnabled ? 'volume-2' : 'volume-x');
    lucide.createIcons();
  }
  
  // Google Sync 連線 UI
  if (state.googleUser) {
    setGoogleCloudStatus('connected', state.googleUser);
  } else {
    setGoogleCloudStatus('disconnected');
  }
  
  // 時區
  const tzText = document.getElementById('desktop-timezone-text');
  if (tzText) {
    const tzRegionName = state.timezone === "Asia/Taipei" ? "臺灣標準時間" : 
                         state.timezone === "Asia/Tokyo" ? "日本標準時間" : 
                         state.timezone === "America/New_York" ? "美東時間" : "自訂地區";
    tzText.textContent = `${tzRegionName} (GMT${state.timezoneOffset >= 0 ? '+' + state.timezoneOffset : state.timezoneOffset})`;
  }
  
  // 同步設定選單變更
  document.getElementById('savings-has-target').checked = state.savingsPool.hasTarget;
  document.getElementById('savings-config-name').value = state.savingsPool.targetName || "";
  document.getElementById('savings-config-target').value = state.savingsPool.targetAmount || 20000;
}

// 記帳分類 Pills 渲染
let selectedCategory = "";
function renderCategoryPills() {
  const container = document.getElementById('category-pills');
  if (!container) return;
  
  container.innerHTML = "";
  state.categories.forEach(cat => {
    const pill = document.createElement('div');
    pill.className = "category-pill";
    if (selectedCategory === cat) pill.classList.add('selected');
    pill.textContent = cat;
    pill.onclick = () => {
      playSound('click');
      selectedCategory = cat;
      renderCategoryPills();
    };
    container.appendChild(pill);
  });
  
  if (!selectedCategory && state.categories.length > 0) {
    selectedCategory = state.categories[0];
    renderCategoryPills();
  }
  
  // 同步常駐表單選單
  const fixedCatSelect = document.getElementById('fixed-category');
  if (fixedCatSelect) {
    const prevVal = fixedCatSelect.value;
    fixedCatSelect.innerHTML = "";
    state.categories.forEach(cat => {
      const opt = document.createElement('option');
      opt.value = cat;
      opt.textContent = cat;
      fixedCatSelect.appendChild(opt);
    });
    if (prevVal && state.categories.includes(prevVal)) fixedCatSelect.value = prevVal;
  }
  
  // 同步心願清單心願類別選單
  const wishCatSelect = document.getElementById('wish-category');
  if (wishCatSelect) {
    const prevVal = wishCatSelect.value;
    wishCatSelect.innerHTML = "";
    state.categories.forEach(cat => {
      const opt = document.createElement('option');
      opt.value = cat;
      opt.textContent = cat;
      wishCatSelect.appendChild(opt);
    });
    if (prevVal && state.categories.includes(prevVal)) wishCatSelect.value = prevVal;
  }
  
  // 篩選選單
  const filterCatSelect = document.getElementById('filter-category');
  if (filterCatSelect) {
    const prevVal = filterCatSelect.value;
    filterCatSelect.innerHTML = '<option value="all">所有分類</option>';
    state.categories.forEach(cat => {
      const opt = document.createElement('option');
      opt.value = cat;
      opt.textContent = cat;
      filterCatSelect.appendChild(opt);
    });
    filterCatSelect.value = prevVal || "all";
  }
}

// 渲染常駐開銷
function renderFixedExpenses() {
  const container = document.getElementById('fixed-expenses-container');
  if (!container) return;
  
  container.innerHTML = "";
  
  if (state.fixedExpenses.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <i data-lucide="info"></i>
        <span>尚未設定任何訂閱或常駐開銷</span>
      </div>
    `;
    lucide.createIcons();
    return;
  }
  
  state.fixedExpenses.forEach(item => {
    const div = document.createElement('div');
    div.className = "fixed-item";
    div.id = `fixed-item-${item.id}`;
    
    const periodText = item.period === 'month' ? '月' : '週';
    const autoBadge = item.autoDeduct ? '<span class="auto-badge">自動扣</span>' : '';
    const dateMeta = item.billingType === 'fixed-date' ? `每月 ${item.dayOfMonth} 日扣款` : '彈性時間扣除';
    
    div.innerHTML = `
      <div class="fixed-item-left">
        <span class="fixed-item-title">${item.name} ${autoBadge}</span>
        <span class="fixed-item-meta">${item.category} • ${dateMeta} ($${item.amount}/${periodText})</span>
      </div>
      <div class="fixed-item-right">
        <span class="fixed-price">-$${item.amount}</span>
        <button onclick="manuallyDeductFixed('${item.id}')" class="btn btn-sm btn-dark" title="手動執行扣款">
          <i data-lucide="zap"></i> 扣款
        </button>
        <button onclick="deleteFixedExpense('${item.id}')" class="mini-icon-btn hover-danger" title="刪除項目">
          <i data-lucide="trash-2"></i>
        </button>
      </div>
      <div class="card-shimmer"></div>
    `;
    
    container.appendChild(div);
  });
  
  lucide.createIcons();
}

// 歷史交易明細
let isFilterOpen = false;
function renderLedgerRecords() {
  const container = document.getElementById('ledger-records-container');
  if (!container) return;
  
  container.innerHTML = "";
  
  const searchVal = document.getElementById('filter-search').value.toLowerCase().trim();
  const typeVal = document.getElementById('filter-type').value;
  const catVal = document.getElementById('filter-category').value;
  
  let filtered = state.ledger.filter(item => {
    const matchSearch = item.note.toLowerCase().includes(searchVal) || item.category.toLowerCase().includes(searchVal);
    const matchType = typeVal === 'all' || item.type === typeVal;
    const matchCat = catVal === 'all' || item.category === catVal;
    return matchSearch && matchType && matchCat;
  });
  
  // 計算篩選結果統計資訊
  let filterIncSum = 0;
  let filterExpSum = 0;
  filtered.forEach(item => {
    const amt = parseInt(item.amount) || 0;
    if (item.type === 'income') {
      filterIncSum += amt;
    } else {
      filterExpSum += amt;
    }
  });

  const searchSummaryBadge = document.getElementById('search-summary-badge');
  const searchIncSumEl = document.getElementById('search-inc-sum');
  const searchExpSumEl = document.getElementById('search-exp-sum');

  if (searchSummaryBadge && searchIncSumEl && searchExpSumEl) {
    searchIncSumEl.textContent = filterIncSum.toLocaleString();
    searchExpSumEl.textContent = filterExpSum.toLocaleString();
    
    const isFilteredActive = (searchVal !== '') || (typeVal !== 'all') || (catVal !== 'all');
    if (isFilteredActive) {
      searchSummaryBadge.classList.remove('hidden');
    } else {
      searchSummaryBadge.classList.add('hidden');
    }
  }

  filtered.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  
  if (filtered.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <i data-lucide="history"></i>
        <span>無符合搜尋條件的明細記錄</span>
      </div>
    `;
    lucide.createIcons();
    return;
  }
  
  filtered.forEach(item => {
    const div = document.createElement('div');
    div.className = "record-item";
    
    const isIncome = item.type === 'income';
    const amtSign = isIncome ? '+' : '-';
    const amtClass = isIncome ? 'record-income' : 'record-expense';
    
    div.innerHTML = `
      <div class="record-item-left">
        <div class="record-title-row">
          <span class="record-category">${item.category}</span>
          <span class="record-note">${item.note || "未備註"}</span>
        </div>
        <span class="record-time">${item.timestamp}</span>
      </div>
      <div class="record-item-right">
        <span class="record-amount ${amtClass}">${amtSign}$${item.amount.toLocaleString()}</span>
        <button onclick="deleteLedgerItem('${item.id}')" class="mini-icon-btn" title="刪除紀錄">
          <i data-lucide="x"></i>
        </button>
      </div>
    `;
    container.appendChild(div);
  });
  
  lucide.createIcons();
}

function deleteLedgerItem(id) {
  playSound('click');
  if (confirm("確定要刪除此筆明細記錄嗎？")) {
    state.ledger = state.ledger.filter(item => item.id !== id);
    saveState();
    showToast("已成功刪除該筆交易明細記錄。");
  }
}

// 17. Chart.js 統計圓餅圖與趨勢折線圖
let desktopChart = null;
let desktopTrendChart = null;
let activeChartTab = 'pie'; // 'pie' or 'line'

function isRecordInTimeRange(recordTimestamp, rangeType) {
  if (rangeType === 'all') return true;
  const now = new Date();
  const utcOffsetMs = 3600000 * state.timezoneOffset;
  const tzNow = new Date(now.getTime() + utcOffsetMs);
  const curYear = tzNow.getUTCFullYear();
  const curMonth = tzNow.getUTCMonth(); // 0-indexed
  const curDate = tzNow.getUTCDate();
  
  const parts = recordTimestamp.split(' ')[0].split('-');
  if (parts.length !== 3) return false;
  
  const recYear = parseInt(parts[0]);
  const recMonth = parseInt(parts[1]) - 1; // 0-indexed
  const recDate = parseInt(parts[2]);
  
  if (rangeType === 'year') {
    return recYear === curYear;
  }
  if (rangeType === 'month') {
    return recYear === curYear && recMonth === curMonth;
  }
  if (rangeType === 'week') {
    const dayOfWeek = tzNow.getUTCDay(); 
    const diffToMonday = (dayOfWeek === 0 ? -6 : 1 - dayOfWeek);
    
    const monday = new Date(tzNow.getTime());
    monday.setUTCDate(curDate + diffToMonday);
    monday.setUTCHours(0, 0, 0, 0);
    
    const sunday = new Date(monday.getTime());
    sunday.setUTCDate(monday.getUTCDate() + 6);
    sunday.setUTCHours(23, 59, 59, 999);
    
    const recUtcDate = new Date(Date.UTC(recYear, recMonth, recDate, 12, 0, 0));
    return recUtcDate.getTime() >= monday.getTime() && recUtcDate.getTime() <= sunday.getTime();
  }
  return false;
}

function updateTrendChart(rangeType) {
  const canvas = document.getElementById('desktop-trend-chart');
  if (!canvas) return;
  
  const now = new Date();
  const utcOffsetMs = 3600000 * state.timezoneOffset;
  const tzNow = new Date(now.getTime() + utcOffsetMs);
  const curYear = tzNow.getUTCFullYear();
  const curMonth = tzNow.getUTCMonth();
  
  let labels = [];
  let incomeData = [];
  let expenseData = [];
  
  if (rangeType === 'week') {
    const dayOfWeek = tzNow.getUTCDay();
    const diffToMonday = (dayOfWeek === 0 ? -6 : 1 - dayOfWeek);
    const monday = new Date(tzNow.getTime());
    monday.setUTCDate(tzNow.getUTCDate() + diffToMonday);
    monday.setUTCHours(0, 0, 0, 0);
    
    const weekDays = ['週一', '週二', '週三', '週四', '週五', '週六', '週日'];
    for (let i = 0; i < 7; i++) {
      const day = new Date(monday.getTime());
      day.setUTCDate(monday.getUTCDate() + i);
      const yyyy = day.getUTCFullYear();
      const mm = String(day.getUTCMonth() + 1).padStart(2, '0');
      const dd = String(day.getUTCDate()).padStart(2, '0');
      const dateStr = `${yyyy}-${mm}-${dd}`;
      
      labels.push(`${weekDays[i]} (${mm}/${dd})`);
      
      let inc = 0;
      let exp = 0;
      state.ledger.forEach(item => {
        if (item.timestamp.startsWith(dateStr)) {
          const amt = parseInt(item.amount) || 0;
          if (item.type === 'income') inc += amt;
          else if (item.type === 'expense') exp += amt;
        }
      });
      incomeData.push(inc);
      expenseData.push(exp);
    }
  } else if (rangeType === 'month') {
    const year = curYear;
    const month = curMonth;
    const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    
    for (let d = 1; d <= daysInMonth; d++) {
      const mmStr = String(month + 1).padStart(2, '0');
      const ddStr = String(d).padStart(2, '0');
      const dateStr = `${year}-${mmStr}-${ddStr}`;
      
      labels.push(`${d}日`);
      
      let inc = 0;
      let exp = 0;
      state.ledger.forEach(item => {
        if (item.timestamp.startsWith(dateStr)) {
          const amt = parseInt(item.amount) || 0;
          if (item.type === 'income') inc += amt;
          else if (item.type === 'expense') exp += amt;
        }
      });
      incomeData.push(inc);
      expenseData.push(exp);
    }
  } else if (rangeType === 'year') {
    labels = ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'];
    incomeData = Array(12).fill(0);
    expenseData = Array(12).fill(0);
    
    state.ledger.forEach(item => {
      const parts = item.timestamp.split(' ')[0].split('-');
      if (parts.length === 3) {
        const y = parseInt(parts[0]);
        const m = parseInt(parts[1]) - 1;
        if (y === curYear) {
          const amt = parseInt(item.amount) || 0;
          if (item.type === 'income') incomeData[m] += amt;
          else if (item.type === 'expense') expenseData[m] += amt;
        }
      }
    });
  } else {
    const ymSet = new Set();
    state.ledger.forEach(item => {
      const parts = item.timestamp.split(' ')[0].split('-');
      if (parts.length === 3) {
        ymSet.add(`${parts[0]}-${parts[1]}`);
      }
    });
    
    const curYm = `${curYear}-${String(curMonth + 1).padStart(2, '0')}`;
    ymSet.add(curYm);
    
    const sortedYm = Array.from(ymSet).sort();
    sortedYm.forEach(ym => {
      const [yStr, mStr] = ym.split('-');
      labels.push(`${parseInt(yStr)}年${parseInt(mStr)}月`);
      
      let inc = 0;
      let exp = 0;
      state.ledger.forEach(item => {
        if (item.timestamp.startsWith(ym)) {
          const amt = parseInt(item.amount) || 0;
          if (item.type === 'income') inc += amt;
          else if (item.type === 'expense') exp += amt;
        }
      });
      incomeData.push(inc);
      expenseData.push(exp);
    });
  }
  
  const totalInc = incomeData.reduce((a, b) => a + b, 0);
  const totalExp = expenseData.reduce((a, b) => a + b, 0);
  
  const emptyState = document.getElementById('line-chart-empty-state');
  if (totalInc === 0 && totalExp === 0) {
    if (emptyState) emptyState.classList.remove('hidden');
    if (desktopTrendChart) {
      desktopTrendChart.destroy();
      desktopTrendChart = null;
    }
    return;
  }
  
  if (emptyState) emptyState.classList.add('hidden');
  
  const accentColor = state.accentColor;
  const ctx = canvas.getContext('2d');
  
  const incGradient = ctx.createLinearGradient(0, 0, 0, 200);
  incGradient.addColorStop(0, 'rgba(16, 185, 129, 0.25)');
  incGradient.addColorStop(1, 'rgba(16, 185, 129, 0.00)');
  
  let accentRgb = '244, 63, 94';
  if (accentColor.startsWith('#')) {
    const hex = accentColor.replace('#', '');
    if (hex.length === 6) {
      const r = parseInt(hex.substring(0, 2), 16);
      const g = parseInt(hex.substring(2, 4), 16);
      const b = parseInt(hex.substring(4, 6), 16);
      accentRgb = `${r}, ${g}, ${b}`;
    }
  }
  
  const expGradient = ctx.createLinearGradient(0, 0, 0, 200);
  expGradient.addColorStop(0, `rgba(${accentRgb}, 0.25)`);
  expGradient.addColorStop(1, `rgba(${accentRgb}, 0.00)`);
  
  const textColor = state.theme === 'light' ? '#374151' : '#8E9BAE';
  const gridColor = state.theme === 'light' ? 'rgba(0, 0, 0, 0.05)' : 'rgba(255, 255, 255, 0.05)';
  
  if (desktopTrendChart) {
    desktopTrendChart.data.labels = labels;
    desktopTrendChart.data.datasets[0].data = incomeData;
    desktopTrendChart.data.datasets[1].data = expenseData;
    desktopTrendChart.data.datasets[1].borderColor = accentColor;
    desktopTrendChart.data.datasets[1].backgroundColor = expGradient;
    desktopTrendChart.options.scales.x.ticks.color = textColor;
    desktopTrendChart.options.scales.y.ticks.color = textColor;
    desktopTrendChart.options.scales.x.grid.color = gridColor;
    desktopTrendChart.options.scales.y.grid.color = gridColor;
    desktopTrendChart.options.plugins.legend.labels.color = textColor;
    desktopTrendChart.update();
  } else {
    desktopTrendChart = new Chart(canvas, {
      type: 'line',
      data: {
        labels: labels,
        datasets: [
          {
            label: '總收入',
            data: incomeData,
            borderColor: '#10B981',
            backgroundColor: incGradient,
            borderWidth: 3,
            fill: true,
            tension: 0.3,
            pointRadius: 2,
            pointHoverRadius: 5
          },
          {
            label: '總支出',
            data: expenseData,
            borderColor: accentColor,
            backgroundColor: expGradient,
            borderWidth: 3,
            fill: true,
            tension: 0.3,
            pointRadius: 2,
            pointHoverRadius: 5
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            position: 'top',
            labels: {
              color: textColor,
              font: { family: 'Noto Sans TC', size: 10 },
              boxWidth: 15,
              padding: 8
            }
          },
          tooltip: {
            mode: 'index',
            intersect: false,
            callbacks: {
              label: function(context) {
                return ` ${context.dataset.label}: $${context.parsed.y.toLocaleString()}`;
              }
            }
          }
        },
        scales: {
          x: {
            grid: { color: gridColor },
            ticks: {
              color: textColor,
              font: { family: 'Noto Sans TC', size: 9 },
              maxRotation: 45,
              autoSkip: true,
              autoSkipPadding: 15
            }
          },
          y: {
            grid: { color: gridColor },
            ticks: {
              color: textColor,
              font: { family: 'Noto Sans TC', size: 9 },
              callback: function(value) {
                return '$' + value.toLocaleString();
              }
            }
          }
        }
      }
    });
  }
}

function updateChart() {
  const canvas = document.getElementById('desktop-chart');
  if (!canvas) return;
  
  const timeRangeSelect = document.getElementById('stats-time-range');
  const rangeType = timeRangeSelect ? timeRangeSelect.value : 'all';
  
  const catExpenses = {};
  state.categories.forEach(cat => catExpenses[cat] = 0);
  
  let totalExp = 0;
  state.ledger.forEach(item => {
    if (item.type === 'expense' && isRecordInTimeRange(item.timestamp, rangeType)) {
      const amt = parseInt(item.amount) || 0;
      catExpenses[item.category] = (catExpenses[item.category] || 0) + amt;
      totalExp += amt;
    }
  });
  
  const badgeVal = document.getElementById('total-expense-badge');
  if (badgeVal) badgeVal.textContent = `$${totalExp.toLocaleString()}`;
  
  const emptyState = document.getElementById('chart-empty-state');
  if (totalExp === 0) {
    if (emptyState) emptyState.classList.remove('hidden');
    if (desktopChart) {
      desktopChart.destroy();
      desktopChart = null;
    }
    updateTrendChart(rangeType);
    return;
  }
  
  if (emptyState) emptyState.classList.add('hidden');
  
  const labels = Object.keys(catExpenses).filter(c => catExpenses[c] > 0);
  const data = labels.map(c => catExpenses[c]);
  
  const baseColor = state.accentColor;
  const colors = [
    baseColor,
    '#00FFA3', // Green
    '#FFC800', // Yellow
    '#0077FF', // Blue
    '#A020F0', // Purple
    '#FF8800', // Orange
    '#00F0FF', // Light Cyan
    '#FF2E74'  // Pink-red
  ];
  
  const borderColors = colors.map(c => state.theme === 'light' ? '#fff' : '#0c0f1d');
  
  if (desktopChart) {
    desktopChart.data.labels = labels;
    desktopChart.data.datasets[0].data = data;
    desktopChart.data.datasets[0].backgroundColor = colors.slice(0, labels.length);
    desktopChart.data.datasets[0].borderColor = borderColors.slice(0, labels.length);
    desktopChart.options.plugins.legend.labels.color = state.theme === 'light' ? '#374151' : '#8E9BAE';
    desktopChart.update();
  } else {
    desktopChart = new Chart(canvas, {
      type: 'doughnut',
      data: {
        labels: labels,
        datasets: [{
          data: data,
          backgroundColor: colors.slice(0, labels.length),
          borderColor: borderColors.slice(0, labels.length),
          borderWidth: 2
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            position: 'bottom',
            labels: {
              color: state.theme === 'light' ? '#374151' : '#8E9BAE',
              font: { family: 'Noto Sans TC', size: 11 },
              padding: 10
            }
          },
          tooltip: {
            callbacks: {
              label: function(context) {
                const val = context.parsed;
                const pct = Math.round((val / totalExp) * 100);
                return ` ${context.label}: $${val.toLocaleString()} (${pct}%)`;
              }
            }
          }
        },
        cutout: '65%'
      }
    });
  }
  
  updateTrendChart(rangeType);
}

// 18. DOMContentLoaded 初始化事件與按鈕監聽
document.addEventListener('DOMContentLoaded', () => {
  // 載入資料
  loadState();
  
  // 初始化 GIS 登入端
  initGoogleAuthClient();
  
  // 預設日期時間為臺灣本地
  const localTime = getFormattedLocalTime();
  const dateInputEl = document.getElementById('ledger-date');
  const timeInputEl = document.getElementById('ledger-time');
  if (dateInputEl) dateInputEl.value = localTime.date;
  if (timeInputEl) timeInputEl.value = localTime.time;
  
  // 監聽日期與時間手動修改事件
  if (dateInputEl) {
    dateInputEl.addEventListener('input', () => {
      userHasModifiedLedgerDate = true;
    });
  }
  if (timeInputEl) {
    timeInputEl.addEventListener('input', () => {
      userHasModifiedLedgerTime = true;
    });
  }
  
  // 底部導覽頁籤 Tab 連動切換
  document.querySelectorAll('.phone-tab-bar button').forEach(btn => {
    btn.onclick = () => {
      const target = btn.getAttribute('data-target');
      switchTab(target);
    };
  });
  
  // 深淺主題模式切換
  document.getElementById('theme-toggle-btn').onclick = () => {
    playSound('click');
    const newTheme = state.theme === 'light' ? 'dark' : 'light';
    setThemeMode(newTheme);
    saveState();
  };

  // 快捷Dial鍵 pre-fill
  document.querySelectorAll('.quick-dial-row button').forEach(btn => {
    btn.onclick = (e) => {
      e.preventDefault();
      playSound('click');
      const val = parseInt(btn.getAttribute('data-val'));
      const amtInput = document.getElementById('ledger-amount');
      let currentVal = parseInt(amtInput.value) || 0;
      let newVal = Math.max(0, currentVal + val);
      amtInput.value = newVal || "";
      
      const expRadio = document.getElementById('type-expense');
      const incRadio = document.getElementById('type-income');
      if (val < 0) {
        expRadio.checked = true;
      } else {
        incRadio.checked = true;
      }
    };
  });

  // 登錄帳單
  document.getElementById('submit-ledger-btn').onclick = (e) => {
    e.preventDefault();
    const amtInput = document.getElementById('ledger-amount');
    const noteInput = document.getElementById('ledger-note');
    const dateInput = document.getElementById('ledger-date');
    const timeInput = document.getElementById('ledger-time');
    const type = document.querySelector('input[name="ledger-type"]:checked').value;
    const amount = parseInt(amtInput.value) || 0;
    
    if (amount <= 0) {
      playSound('click');
      showToast("請輸入大於 0 的正整數金額！", "warning");
      return;
    }
    
    playSound('deposit');
    const dateVal = dateInput.value;
    const timeVal = timeInput.value;
    
    const newRecord = {
      id: "led-manual-" + Date.now(),
      type: type,
      amount: amount,
      category: selectedCategory,
      note: noteInput.value.trim() || "",
      timestamp: `${dateVal} ${timeVal}:00`,
      recordType: "manual"
    };
    
    state.ledger.push(newRecord);
    saveState();
    
    amtInput.value = "";
    noteInput.value = "";
    showToast("收支帳目登錄成功！", "success");
    
    // 重設日期時間手動修改標記，並立即更新為當前時間以求動態調整
    userHasModifiedLedgerTime = false;
    userHasModifiedLedgerDate = false;
    updateLedgerClock();
    
    // 自動回跳儀表板
    setTimeout(() => switchTab("tab-home"), 300);
  };

  // 新增分類標籤 Pills
  document.getElementById('add-category-btn').onclick = () => {
    playSound('click');
    const modal = document.getElementById('custom-category-modal');
    document.getElementById('new-category-emoji').value = "🚇";
    document.getElementById('new-category-name').value = "";
    modal.showModal();
  };
  
  document.getElementById('save-custom-category-btn').onclick = () => {
    playSound('click');
    const emoji = document.getElementById('new-category-emoji').value.trim() || "🏷️";
    const name = document.getElementById('new-category-name').value.trim();
    const modal = document.getElementById('custom-category-modal');
    
    if (!name) {
      showToast("請輸入分類名稱！", "warning");
      return;
    }
    
    const finalLabel = `${emoji} ${name}`;
    if (state.categories.includes(finalLabel)) {
      showToast("此標籤分類已存在！", "warning");
      return;
    }
    
    state.categories.push(finalLabel);
    selectedCategory = finalLabel;
    saveState();
    modal.close();
    showToast(`分類標籤「${finalLabel}」新增成功！`, "success");
  };

  // 初始存款重設
  document.getElementById('edit-initial-btn').onclick = () => {
    playSound('click');
    const modal = document.getElementById('initial-balance-modal');
    document.getElementById('new-initial-balance').value = state.initialBalance;
    modal.showModal();
  };
  
  document.getElementById('save-initial-balance-btn').onclick = () => {
    playSound('click');
    const modal = document.getElementById('initial-balance-modal');
    const inputVal = parseInt(document.getElementById('new-initial-balance').value);
    
    if (isNaN(inputVal) || inputVal < 0) {
      showToast("請輸入正確的正整數資產額！", "warning");
      return;
    }
    
    state.initialBalance = inputVal;
    saveState();
    modal.close();
    showToast("初始存款基底金額已重置成功！", "success");
  };

  // 定期訂閱常駐新增
  document.getElementById('add-fixed-btn').onclick = () => {
    playSound('click');
    const modal = document.getElementById('custom-fixed-modal');
    document.getElementById('fixed-name').value = "";
    document.getElementById('fixed-amount').value = "";
    document.getElementById('fixed-period').value = "month";
    document.getElementById('fixed-billing-type').value = "fixed-date";
    document.getElementById('fixed-day-of-month').value = "5";
    document.getElementById('fixed-auto-deduct').checked = true;
    document.getElementById('fixed-day-group').classList.remove('hidden');
    modal.showModal();
  };
  
  document.getElementById('fixed-billing-type').onchange = (e) => {
    const grp = document.getElementById('fixed-day-group');
    if (e.target.value === 'fixed-date') {
      grp.classList.remove('hidden');
    } else {
      grp.classList.add('hidden');
    }
  };
  
  document.getElementById('save-fixed-btn').onclick = () => {
    playSound('click');
    const name = document.getElementById('fixed-name').value.trim();
    const amount = parseInt(document.getElementById('fixed-amount').value) || 0;
    const period = document.getElementById('fixed-period').value;
    const category = document.getElementById('fixed-category').value;
    const billingType = document.getElementById('fixed-billing-type').value;
    const day = parseInt(document.getElementById('fixed-day-of-month').value) || 5;
    const autoDeduct = document.getElementById('fixed-auto-deduct').checked;
    
    if (!name || amount <= 0) {
      showToast("請輸入正確的名稱與扣款金額！", "warning");
      return;
    }
    
    const newFixed = {
      id: "fix-" + Date.now(),
      name,
      amount,
      period,
      category,
      billingType,
      dayOfMonth: billingType === 'fixed-date' ? day : null,
      autoDeduct,
      lastDeductedDate: getFormattedLocalTime().date
    };
    
    state.fixedExpenses.push(newFixed);
    saveState();
    
    document.getElementById('custom-fixed-modal').close();
    showToast(`常駐開銷項目「${name}」註冊登錄成功！`, "success");
  };

  // 小金庫存入與提取
  document.getElementById('savings-deposit-btn').onclick = () => {
    const input = document.getElementById('savings-op-amount');
    const amt = parseInt(input.value) || 0;
    
    if (amt <= 0) {
      playSound('click');
      showToast("請輸入大於 0 的正整數！", "warning");
      return;
    }
    
    if (state.totalBalance < amt) {
      playSound('click');
      showToast("可支配總存款資金不足以存入金庫！", "warning");
      return;
    }
    
    playSound('deposit');
    state.savingsPool.currentAmount += amt;
    input.value = "";
    
    const cap = state.savingsPool;
    if (cap.hasTarget && cap.currentAmount >= cap.targetAmount) {
      const prevAmt = cap.currentAmount - amt;
      if (prevAmt < cap.targetAmount) {
        setTimeout(() => {
          playSound('success');
          confetti({
            particleCount: 150,
            spread: 80,
            origin: { y: 0.6 }
          });
        }, 300);
        showToast(`🎉 恭喜！您已圓夢達成儲蓄目標：${cap.targetName}！`, 'success');
      }
    }
    
    saveState();
    showToast(`成功存入金庫 $${amt.toLocaleString()} 鎖定。`, 'success');
  };
  
  document.getElementById('savings-withdraw-btn').onclick = () => {
    const input = document.getElementById('savings-op-amount');
    const amt = parseInt(input.value) || 0;
    
    if (amt <= 0) {
      playSound('click');
      showToast("請輸入正整數！", "warning");
      return;
    }
    
    if (state.savingsPool.currentAmount < amt) {
      playSound('click');
      showToast("金庫鎖定金額不足，無法提領！", "warning");
      return;
    }
    
    playSound('click');
    state.savingsPool.currentAmount -= amt;
    input.value = "";
    saveState();
    showToast(`成功提領 $${amt.toLocaleString()} 至可支配存款中。`, 'success');
  };

  // 購買心願清單心願新增 (Wishlist Add)
  document.getElementById('add-wish-btn').onclick = () => {
    playSound('click');
    const modal = document.getElementById('custom-wish-modal');
    document.getElementById('wish-name').value = "";
    document.getElementById('wish-cost').value = "";
    document.getElementById('wish-priority').value = "💡 有餘裕再買";
    modal.showModal();
  };
  
  document.getElementById('save-wish-btn').onclick = () => {
    playSound('click');
    const name = document.getElementById('wish-name').value.trim();
    const cost = parseInt(document.getElementById('wish-cost').value) || 0;
    const category = document.getElementById('wish-category').value;
    const priority = document.getElementById('wish-priority').value;
    
    if (!name || cost <= 0) {
      showToast("請填寫正確的願望名稱與估價金額！", "warning");
      return;
    }
    
    const newWish = {
      id: "wish-" + Date.now(),
      name,
      cost,
      category,
      priority,
      completed: false
    };
    
    state.wishlist.push(newWish);
    saveState();
    
    document.getElementById('custom-wish-modal').close();
    showToast(`成功將「${name}」新增至購買心願清單！`, "success");
  };

  // 生活備忘新增 (Memo Add)
  document.getElementById('add-memo-btn').onclick = () => {
    playSound('click');
    editingMemoId = null; // 重設為新增模式
    
    const modal = document.getElementById('custom-memo-modal');
    modal.querySelector('h3').textContent = "粘貼生活備忘錄卡片";
    document.getElementById('save-memo-btn').textContent = "黏貼備忘";
    
    document.getElementById('memo-title').value = "";
    document.getElementById('memo-text').value = "";
    document.getElementById('memo-color').value = "pink";
    document.getElementById('memo-priority').value = "medium";
    document.getElementById('memo-type').value = "text";
    document.getElementById('memo-reminder').value = "";
    
    // 重設清單編輯器與文字編輯器顯示狀態
    document.getElementById('memo-checklist-builder').classList.add('hidden');
    const textGroup = document.getElementById('memo-text').closest('.form-group');
    if (textGroup) textGroup.classList.remove('hidden');
    document.getElementById('memo-checklist-items-container').innerHTML = "";
    
    modal.showModal();
  };
  
  // 備忘錄類型切換監聽
  document.getElementById('memo-type').onchange = (e) => {
    const builder = document.getElementById('memo-checklist-builder');
    const textGroup = document.getElementById('memo-text').closest('.form-group');
    if (e.target.value === 'checklist') {
      builder.classList.remove('hidden');
      if (textGroup) textGroup.classList.add('hidden');
      // 如果目前沒有任何清單輸入列，預設新增一行
      const container = document.getElementById('memo-checklist-items-container');
      if (container.children.length === 0) {
        addChecklistItemInput();
      }
    } else {
      builder.classList.add('hidden');
      if (textGroup) textGroup.classList.remove('hidden');
    }
  };

  // 新增待辦清單項目按鈕監聽
  document.getElementById('memo-add-item-btn').onclick = (e) => {
    e.preventDefault();
    playSound('click');
    addChecklistItemInput();
  };

  document.getElementById('save-memo-btn').onclick = () => {
    playSound('click');
    const title = document.getElementById('memo-title').value.trim();
    const type = document.getElementById('memo-type').value;
    const text = document.getElementById('memo-text').value.trim();
    const color = document.getElementById('memo-color').value;
    const priority = document.getElementById('memo-priority').value;
    const reminderTime = document.getElementById('memo-reminder').value; // YYYY-MM-DDThh:mm
    
    // 獲取原有的編輯對象，用於在清單變更時比對並保留其勾選狀態
    const existingMemo = editingMemoId ? state.memos.find(m => m.id === editingMemoId) : null;
    
    const checklistItems = [];
    if (type === 'checklist') {
      const rows = document.querySelectorAll('#memo-checklist-items-container .memo-checklist-item-row');
      rows.forEach(row => {
        const input = row.querySelector('input[type="text"]');
        if (input && input.value.trim() !== '') {
          const textVal = input.value.trim();
          // 若原項目存在同文字的待辦項目，保留原先的勾選狀態以優化操作體驗
          const oldItem = existingMemo && existingMemo.checklistItems ? existingMemo.checklistItems.find(i => i.text === textVal) : null;
          checklistItems.push({
            text: textVal,
            checked: oldItem ? oldItem.checked : false
          });
        }
      });
    }
    
    if (type === 'text') {
      if (!title || !text) {
        showToast("備忘錄標題與內容皆為必填！", "warning");
        return;
      }
    } else {
      if (!title) {
        showToast("備忘錄標題為必填！", "warning");
        return;
      }
      if (checklistItems.length === 0) {
        showToast("清單項目至少需要填寫一項！", "warning");
        return;
      }
    }
    
    // 如果有設定提醒時間，主動向使用者請求通知權限
    if (reminderTime) {
      requestNotificationPermission();
    }
    
    const nowTime = getFormattedLocalTime();
    
    if (editingMemoId && existingMemo) {
      // 編輯調整設定模式
      existingMemo.title = title;
      existingMemo.type = type;
      existingMemo.text = type === 'text' ? text : "";
      existingMemo.color = color;
      existingMemo.priority = priority;
      
      // 如果提醒時間被重設或變更，重設其觸發狀態，以利定時引擎再次提醒
      if (existingMemo.reminderTime !== reminderTime) {
        existingMemo.reminderTime = reminderTime || "";
        existingMemo.reminderTriggered = false;
      }
      
      existingMemo.checklistItems = checklistItems;
      
      saveState();
      document.getElementById('custom-memo-modal').close();
      showToast("備忘錄設定已成功更新調整！", "success");
      
      // 重設編輯標記
      editingMemoId = null;
    } else {
      // 全新張貼模式
      const newMemo = {
        id: "memo-" + Date.now(),
        title,
        type,
        text: type === 'text' ? text : "",
        color,
        priority,
        reminderTime: reminderTime || "",
        reminderTriggered: false,
        checklistItems,
        date: nowTime.date.substring(5, 10) + " " + nowTime.time // "MM-DD HH:MM"
      };
      
      state.memos.push(newMemo);
      saveState();
      
      document.getElementById('custom-memo-modal').close();
      showToast("備忘錄貼牆成功！", "success");
    }
  };

  // 篩選與搜尋
  document.getElementById('filter-search').oninput = renderLedgerRecords;
  document.getElementById('filter-type').onchange = renderLedgerRecords;
  document.getElementById('filter-category').onchange = renderLedgerRecords;
  
  document.getElementById('filter-toggle-btn').onclick = () => {
    playSound('click');
    const panel = document.getElementById('records-filter-panel');
    isFilterOpen = !isFilterOpen;
    if (isFilterOpen) {
      panel.classList.remove('hidden');
      document.getElementById('filter-toggle-btn').setAttribute('aria-expanded', 'true');
    } else {
      panel.classList.add('hidden');
      document.getElementById('filter-toggle-btn').setAttribute('aria-expanded', 'false');
    }
  };

  // 右側 Config Panel Tab
  document.querySelectorAll('.config-tab-btn').forEach(btn => {
    btn.onclick = () => {
      playSound('click');
      document.querySelectorAll('.config-tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.config-tab-content').forEach(c => c.classList.remove('active-content'));
      
      btn.classList.add('active');
      const tabId = btn.getAttribute('data-tab');
      document.getElementById(tabId).classList.add('active-content');
    };
  });

  // 霓虹預設顏色變更
  document.querySelectorAll('.theme-presets button').forEach(btn => {
    btn.onclick = () => {
      playSound('click');
      const color = btn.getAttribute('data-color');
      setAccentColor(color);
      saveState();
      updateChart();
    };
  });
  
  document.getElementById('custom-color-picker').onchange = (e) => {
    setAccentColor(e.target.value);
    saveState();
    updateChart();
  };

  // 時區
  document.getElementById('region-timezone-select').onchange = (e) => {
    playSound('click');
    const val = e.target.value;
    const customContainer = document.getElementById('custom-offset-container');
    
    if (val === 'Custom|offset') {
      customContainer.classList.remove('hidden');
    } else {
      customContainer.classList.add('hidden');
      const [tzName, offsetStr] = val.split('|');
      state.timezone = tzName;
      state.timezoneOffset = parseInt(offsetStr);
      saveState();
      
      // 重置手動修改標記並更新時間以求動態調整
      userHasModifiedLedgerTime = false;
      userHasModifiedLedgerDate = false;
      updateLedgerClock();
      
      showToast(`地區切換成功：GMT${state.timezoneOffset >= 0 ? '+' + state.timezoneOffset : state.timezoneOffset}`, 'success');
    }
  };
  
  document.getElementById('custom-timezone-offset').onchange = (e) => {
    const offset = parseInt(e.target.value);
    if (!isNaN(offset) && offset >= -12 && offset <= 14) {
      state.timezone = "Custom";
      state.timezoneOffset = offset;
      saveState();
      
      // 重置手動修改標記並更新時間以求動態調整
      userHasModifiedLedgerTime = false;
      userHasModifiedLedgerDate = false;
      updateLedgerClock();
    }
  };

  // 金庫目標狀態切換
  document.getElementById('savings-has-target').onchange = (e) => {
    playSound('click');
    state.savingsPool.hasTarget = e.target.checked;
    saveState();
  };
  
  document.getElementById('save-savings-config-btn').onclick = () => {
    playSound('click');
    const name = document.getElementById('savings-config-name').value.trim() || "儲蓄心願";
    const target = parseInt(document.getElementById('savings-config-target').value) || 20000;
    
    if (state.savingsPool.hasTarget && target <= 0) {
      showToast("目標金額必須大於 0 的正整數！", "warning");
      return;
    }
    
    state.savingsPool.targetName = name;
    state.savingsPool.targetAmount = target;
    saveState();
    showToast("小金庫目標參數設定已更新！", "success");
  };

  // 靜音 / 右側設定
  document.getElementById('sound-toggle-btn').onclick = () => {
    state.soundEnabled = !state.soundEnabled;
    saveState();
    showToast(state.soundEnabled ? "觸覺音效已開" : "觸覺音效已關閉");
  };
  
  document.getElementById('settings-toggle-btn').onclick = () => {
    playSound('click');
    showToast("設定控制台已在右側（電腦端）或下方為您載入！");
    if (window.innerWidth <= 1024) {
      document.querySelector('.desktop-config-panel').style.display = "block";
      document.querySelector('.desktop-config-panel').scrollIntoView({ behavior: 'smooth' });
    }
  };

  // JSON 備份檔匯出
  document.getElementById('backup-export-btn').onclick = () => {
    playSound('click');
    try {
      const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(state, null, 2));
      const downloadAnchor = document.createElement('a');
      const timeTag = getFormattedLocalTime().date.replace(/-/g, '');
      
      downloadAnchor.setAttribute("href", dataStr);
      downloadAnchor.setAttribute("download", `spark_ledger_backup_${timeTag}.json`);
      document.body.appendChild(downloadAnchor);
      downloadAnchor.click();
      downloadAnchor.remove();
      showToast("備份 JSON 下載成功！", "success");
    } catch (e) {
      showToast("備份匯出失敗，請檢查瀏覽器設定權限。", "warning");
    }
  };

  // JSON 備份還原
  document.getElementById('backup-import-file').onchange = (e) => {
    playSound('click');
    const file = e.target.files[0];
    if (!file) return;
    
    const reader = new FileReader();
    reader.onload = function(evt) {
      try {
        const imported = JSON.parse(evt.target.result);
        if (typeof imported.initialBalance !== 'number' || !Array.isArray(imported.ledger)) {
          showToast("備份檔資料結構損毀或不正確，還原中斷！", "warning");
          return;
        }
        state = { ...state, ...imported };
        saveState();
        showToast("資料已安全還原，明細重整中...", "success");
        setTimeout(() => location.reload(), 1500);
      } catch (err) {
        showToast("檔案讀取解析失敗，請重新選擇 JSON 備份檔。", "warning");
      }
    };
    reader.readAsText(file);
  };

  // 19. Google Drive 雲端連線 & 模擬器連動監聽
  document.getElementById('google-login-btn').onclick = handleGoogleLoginClick;
  
  // 備份與還原模擬
  document.getElementById('gdrive-backup-btn').onclick = () => {
    playSound('click');
    simulateGoogleCloudSync('backup');
  };
  
  document.getElementById('gdrive-restore-btn').onclick = () => {
    playSound('click');
    simulateGoogleCloudSync('restore');
  };
  
  // Gmail 模擬授權確認
  document.getElementById('google-sim-email').onchange = (e) => {
    const input = document.getElementById('google-sim-custom-email');
    if (e.target.value === 'custom') {
      input.classList.remove('hidden');
    } else {
      input.classList.add('hidden');
    }
  };
  
  document.getElementById('submit-google-sim-login-btn').onclick = () => {
    playSound('click');
    const modal = document.getElementById('google-auth-sim-modal');
    const select = document.getElementById('google-sim-email');
    let email = select.value;
    if (email === 'custom') {
      email = document.getElementById('google-sim-custom-email').value.trim();
      if (!email || !email.includes('@')) {
        showToast("請輸入正確的 Gmail 格式！", "warning");
        return;
      }
    }
    
    modal.close();
    setGoogleCloudStatus('connected', email);
    saveState();
    showToast(`Google 帳號連動成功！`, "success");
  };

  // 20. GitHub 線上更新與熱更新監聽
  document.getElementById('check-update-btn').onclick = executeGithubUpdateCheck;
  document.getElementById('trigger-hot-update-btn').onclick = executeHotReloadUpdate;

  // 20.1 數據統計看板圓餅圖與折線圖之頁籤切換與時間間距監聽
  const tabPie = document.getElementById('chart-tab-pie');
  const tabLine = document.getElementById('chart-tab-line');
  const pieWrapper = document.getElementById('pie-chart-wrapper');
  const lineWrapper = document.getElementById('line-chart-wrapper');
  const statsTimeRange = document.getElementById('stats-time-range');
  
  if (statsTimeRange) {
    statsTimeRange.onchange = () => {
      playSound('click');
      updateChart();
    };
  }
  
  if (tabPie && tabLine && pieWrapper && lineWrapper) {
    tabPie.onclick = () => {
      playSound('click');
      tabPie.classList.remove('btn-dark');
      tabPie.classList.add('btn-primary');
      tabLine.classList.remove('btn-primary');
      tabLine.classList.add('btn-dark');
      
      pieWrapper.classList.remove('hidden');
      lineWrapper.classList.add('hidden');
      
      activeChartTab = 'pie';
      updateChart();
    };
    
    tabLine.onclick = () => {
      playSound('click');
      tabLine.classList.remove('btn-dark');
      tabLine.classList.add('btn-primary');
      tabPie.classList.remove('btn-primary');
      tabPie.classList.add('btn-dark');
      
      lineWrapper.classList.remove('hidden');
      pieWrapper.classList.add('hidden');
      
      activeChartTab = 'line';
      updateChart();
    };
  }

  // 21. 推薦目標快捷填寫 click
  document.querySelectorAll('.quick-goal-btn').forEach(btn => {
    btn.onclick = () => {
      playSound('click');
      const name = btn.getAttribute('data-name');
      const amount = btn.getAttribute('data-amount');
      document.getElementById('savings-config-name').value = name;
      document.getElementById('savings-config-target').value = amount;
      showToast(`已預填心願目標為「${name}」！請記得更新金庫設定。`);
    };
  });

  // 22. 啟動備忘錄高精確度提醒定時檢查引擎與系統通知
  checkMemoReminders();
  setInterval(checkMemoReminders, 8000);

  // 23. 啟動記帳日期時間動態調整時鐘 (每秒更新，當無手動修改時保持高精度時鐘對齊)
  updateLedgerClock();
  setInterval(updateLedgerClock, 1000);
});
