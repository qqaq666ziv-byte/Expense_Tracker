export type ThemeId = 'shiba' | 'mix';

export interface Theme {
  id: ThemeId;
  name: string;
  dogName: string;
  avatarEmoji: string;
  welcomeTitle: string;
  welcomeSub: string;
  clockPrefix: string;
  vaultTitle: string;
  vaultSub: string;
  emptyStateMsg: string;
  mascotAvatar: string;
  mascotAvatarType: 'emoji' | 'image';
  mascotCardTitle: string;
  mascotEncourage: string;
  quotes: string[];
  styles: {
    primaryText: string;
    primaryBg: string;
    primaryBtn: string;
    accentBtn: string;
    tabActive: string;
    tabInactive: string;
    clockBg: string;
    inputFocus: string;
    inputLabel: string;
    paymentActive: string;
    paymentInactive: string;
    modalBorder: string;
    navActive: string;
    updateBorder: string;
    notifBtn: string;
    toastBorder: string;
    vaultHeaderBg: string;
    vaultBtn: string;
    activeGoalBg: string;
    progressBar: string;
    quotesBg: string;
    quotesTitle: string;
    quotesBody: string;
    quotesBottom: string;
    badgeStyle: string;
  };
}

export const themes: Record<ThemeId, Theme> = {
  shiba: {
    id: 'shiba',
    name: '柴犬風格',
    dogName: '柴柴',
    avatarEmoji: '🐕',
    welcomeTitle: '柴柴極速記帳',
    welcomeSub: '每天省一點，積沙成塔幫柴柴準備源源不絕的零食，並管理定期固定開銷！',
    clockPrefix: '⏰ 柴柴精密時鐘：',
    vaultTitle: '柴柴數位存摺',
    vaultSub: '幫柴柴存下滿滿的罐罐保障',
    emptyStateMsg: '空空如也，快來幫柴柴記下第一筆收支吧！',
    mascotAvatar: '🐕',
    mascotAvatarType: 'emoji',
    mascotCardTitle: '🐾 柴柴理財鼓勵語錄 🐾',
    mascotEncourage: '柴柴每天都在存錢筒旁邊幫主人打氣加油喔！汪汪！🐕',
    quotes: [
      "每存下一根骨頭，以後就有無窮驚喜旺！🐾",
      "主人今天又變聰明了！省下的罐罐錢夠我吃三天肉乾囉！🍖",
      "積沙成塔，柴柴的新家懶骨頭就靠主人的毅力了！🐶",
      "看到那亮晶晶的存摺了嗎？那是我們未來的保障喔！✨",
      "今天少喝一杯飲料，明天柴柴多一根超香潔牙骨！🦴",
      "主人真棒！每一筆存入都是對美好生活的最佳投資！🏠"
    ],
    styles: {
      primaryText: 'text-amber-800 dark:text-amber-300',
      primaryBg: 'bg-amber-100 dark:bg-amber-950/60',
      primaryBtn: 'bg-amber-600 hover:bg-amber-700 shadow-amber-900/20',
      accentBtn: 'bg-orange-100/60 dark:bg-orange-950/40 text-orange-900 dark:text-orange-200',
      tabActive: 'bg-amber-600 text-white shadow-sm',
      tabInactive: 'text-amber-955/60 dark:text-zinc-400 hover:bg-amber-100/20',
      clockBg: 'bg-amber-50 dark:bg-zinc-800 text-amber-850 dark:text-amber-305 border border-amber-200/30',
      inputFocus: 'focus-within:border-amber-400',
      inputLabel: 'text-amber-900 dark:text-amber-300',
      paymentActive: 'bg-amber-600 text-white shadow-sm',
      paymentInactive: 'text-amber-900/70 dark:text-zinc-300 hover:bg-amber-200/30',
      modalBorder: 'border-amber-300',
      navActive: 'bg-amber-100 dark:bg-amber-950/60 text-amber-800 dark:text-amber-300 font-bold scale-105',
      updateBorder: 'border-amber-500',
      notifBtn: 'bg-amber-600 hover:bg-amber-700 active:scale-95 text-white',
      toastBorder: 'border-amber-500',
      vaultHeaderBg: 'from-amber-500 to-amber-700',
      vaultBtn: 'bg-amber-600 hover:bg-amber-700 active:scale-95 text-white',
      activeGoalBg: 'bg-amber-50 dark:bg-amber-950/40 text-amber-800 dark:text-amber-200',
      progressBar: 'from-amber-500 via-amber-600 to-orange-500',
      quotesBg: 'from-amber-50 to-orange-100/30 dark:from-zinc-900 dark:to-zinc-850 border border-amber-900/10',
      quotesTitle: 'text-amber-800 dark:text-amber-300',
      quotesBody: 'text-amber-950 dark:text-amber-100',
      quotesBottom: 'text-amber-900/50 dark:text-zinc-550',
      badgeStyle: 'border-amber-400 bg-amber-100 dark:bg-amber-950'
    }
  },
  mix: {
    id: 'mix',
    name: '米克斯風格',
    dogName: '阿米',
    avatarEmoji: '🐾',
    welcomeTitle: '米克斯極速記帳',
    welcomeSub: '積少成多，跟著活力十足的米克斯一起輕鬆存錢、打理您的收支開銷吧！',
    clockPrefix: '⏰ 阿米精密時鐘：',
    vaultTitle: '阿米數位存摺',
    vaultSub: '幫米克斯存下滿滿的愛心罐罐保障',
    emptyStateMsg: '空空如也，快來幫米克斯記下第一筆收支吧！',
    mascotAvatar: '/mix_sitting.png',
    mascotAvatarType: 'image',
    mascotCardTitle: '🐾 米克斯理財鼓勵語錄 🐾',
    mascotEncourage: '米克斯每天都在存錢筒旁邊開心地搖著尾巴幫主人加油喔！汪汪！🐾',
    quotes: [
      "每存下一枚小硬幣，米克斯以後就有肉肉吃囉！🐾",
      "主人今天太讚了！省下的拿鐵咖啡錢可以幫我買大罐罐！🥩",
      "點滴累積，米克斯在草地上歡樂奔跑的夢想很快就會實現喔！🐕",
      "看到存錢筒一天天變胖，米克斯的心裡也跟著暖烘烘的！✨",
      "今天少吃一包垃圾食物，明天米克斯多一隻香脆潔牙骨！🦴",
      "主人辛苦啦！您的每一次儲蓄，都是對我們未來最好的投資！🏠"
    ],
    styles: {
      primaryText: 'text-emerald-800 dark:text-emerald-300',
      primaryBg: 'bg-emerald-100 dark:bg-emerald-950/60',
      primaryBtn: 'bg-emerald-600 hover:bg-emerald-700 shadow-emerald-900/20',
      accentBtn: 'bg-teal-100/60 dark:bg-teal-950/40 text-teal-900 dark:text-teal-200',
      tabActive: 'bg-emerald-600 text-white shadow-sm',
      tabInactive: 'text-zinc-650 dark:text-zinc-400 hover:bg-emerald-50/10',
      clockBg: 'bg-emerald-50 dark:bg-zinc-800 text-emerald-800 dark:text-emerald-300 border border-emerald-200/30',
      inputFocus: 'focus-within:border-emerald-400',
      inputLabel: 'text-emerald-900 dark:text-emerald-305',
      paymentActive: 'bg-emerald-600 text-white shadow-sm',
      paymentInactive: 'text-emerald-900/70 dark:text-zinc-300 hover:bg-emerald-200/30',
      modalBorder: 'border-emerald-300',
      navActive: 'bg-emerald-100 dark:bg-emerald-950/60 text-emerald-800 dark:text-emerald-300 font-bold scale-105',
      updateBorder: 'border-emerald-500',
      notifBtn: 'bg-emerald-600 hover:bg-emerald-700 active:scale-95 text-white',
      toastBorder: 'border-emerald-500',
      vaultHeaderBg: 'from-emerald-500 to-teal-650',
      vaultBtn: 'bg-emerald-600 hover:bg-emerald-700 active:scale-95 text-white',
      activeGoalBg: 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-800 dark:text-emerald-200',
      progressBar: 'from-emerald-500 via-emerald-600 to-teal-500',
      quotesBg: 'from-emerald-50 to-teal-100/30 dark:from-zinc-900 dark:to-zinc-850 border border-emerald-900/10',
      quotesTitle: 'text-emerald-800 dark:text-emerald-300',
      quotesBody: 'text-emerald-950 dark:text-emerald-100',
      quotesBottom: 'text-emerald-900/50 dark:text-zinc-555',
      badgeStyle: 'border-emerald-400 bg-emerald-100 dark:bg-emerald-950'
    }
  }
};
