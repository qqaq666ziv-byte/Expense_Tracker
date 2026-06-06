import React, { useState } from 'react';
import { Target, Plus, AlertCircle, Trash2 } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { Goal, Subscription } from '../types';
import SubscriptionManager from './SubscriptionManager';
import { useTheme } from '../context/ThemeContext';

interface SavingsProps {
  vaultTotal: number;
  onAddSaving: (amount: number) => void;
  goals: Goal[];
  activeGoalId: string;
  onSelectGoal: (id: string) => void;
  onAddGoal: (goal: Omit<Goal, 'id' | 'currentAmount'>) => void;
  onDeleteGoal: (id: string) => void;
  
  subscriptions: Subscription[];
  onAddSubscription: (sub: Omit<Subscription, 'id'>) => void;
  onDeleteSubscription: (id: string) => void;
}

export default function Savings({ 
  vaultTotal, 
  onAddSaving, 
  goals, 
  activeGoalId, 
  onSelectGoal, 
  onAddGoal,
  onDeleteGoal,
  subscriptions,
  onAddSubscription,
  onDeleteSubscription
}: SavingsProps) {
  const { theme } = useTheme();
  const [savingMode, setSavingMode] = useState<'goal' | 'free' | 'subscription'>('goal');
  const [depositAmount, setDepositAmount] = useState<string>('');
  const [showDepositModal, setShowDepositModal] = useState<boolean>(false);

  // 建立新目標的表單狀態
  const [showGoalModal, setShowGoalModal] = useState<boolean>(false);
  const [newGoalName, setNewGoalName] = useState<string>('');
  const [newGoalAmount, setNewGoalAmount] = useState<string>('');
  const [newGoalDate, setNewGoalDate] = useState<string>('');

  const activeGoal = goals.find(g => g.id === activeGoalId) || goals[0];
  const snackFundGoal = activeGoal ? activeGoal.targetAmount : 5000;
  const snackFundPercent = activeGoal ? Math.min(100, Math.round((vaultTotal / snackFundGoal) * 100)) : 0;

  const handleDepositSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const amount = parseFloat(depositAmount);
    if (!isNaN(amount) && amount > 0) {
      onAddSaving(amount);
      setDepositAmount('');
      setShowDepositModal(false);
    }
  };

  const handleGoalSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const amount = parseFloat(newGoalAmount);
    if (!newGoalName.trim() || isNaN(amount) || amount <= 0) return;

    onAddGoal({
      name: newGoalName.trim(),
      targetAmount: amount,
      unit: '元',
      targetDate: newGoalDate || undefined
    });

    setNewGoalName('');
    setNewGoalAmount('');
    setNewGoalDate('');
    setShowGoalModal(false);
  };

  const getGoalStatusWarning = () => {
    if (!activeGoal || !activeGoal.targetDate) return null;
    const todayStr = new Date().toISOString().split('T')[0];
    const today = new Date(todayStr);
    const target = new Date(activeGoal.targetDate);
    const diffTime = target.getTime() - today.getTime();
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

    if (vaultTotal < snackFundGoal) {
      if (diffDays >= 0 && diffDays <= 3) {
        return `⚠️ 剩餘 ${diffDays} 天到期，加油汪！`;
      } else if (diffDays < 0) {
        return `😢 已過期，繼續努力喔！`;
      }
    }
    return null;
  };

  const warningLabel = getGoalStatusWarning();

  return (
    <div className="flex flex-col gap-6 animate-fade-in relative">
      {/* 頁面標題 */}
      <div className="flex flex-col gap-1">
        <h1 className={`text-3xl font-extrabold tracking-tight ${theme.styles.primaryText}`}>
          {theme.avatarEmoji} {theme.dogName}存錢筒
        </h1>
        <p className={`text-body-md ${theme.id === 'shiba' ? 'text-amber-900/60 dark:text-zinc-400' : 'text-emerald-900/60 dark:text-zinc-400'}`}>
          每天省一點，積沙成塔幫{theme.dogName}準備源源不絕的零食，並管理定期固定開銷！
        </p>

        {/* 存錢形式切換項 */}
        <div className={`rounded-2xl p-1.5 mt-3 w-full gap-2 border flex shadow-xs ${
          theme.id === 'shiba' 
            ? 'bg-amber-100/50 dark:bg-zinc-800 border-amber-900/5' 
            : 'bg-emerald-105/50 dark:bg-zinc-800 border-emerald-900/5'
        }`}>
          <motion.button 
            whileTap={{ scale: 0.96 }}
            type="button"
            onClick={() => setSavingMode('goal')}
            className={`flex-1 font-bold text-xs sm:text-sm py-3 rounded-xl text-center transition-all flex items-center justify-center gap-1 cursor-pointer ${
              savingMode === 'goal' 
                ? theme.styles.tabActive 
                : theme.styles.tabInactive
            }`}
          >
            🎯 存錢目標
          </motion.button>
          <motion.button 
            whileTap={{ scale: 0.96 }}
            type="button"
            onClick={() => setSavingMode('free')}
            className={`flex-1 font-bold text-xs sm:text-sm py-3 rounded-xl text-center transition-all flex items-center justify-center gap-1 cursor-pointer ${
              savingMode === 'free' 
                ? 'bg-emerald-600 text-white shadow-md scale-[1.01]' 
                : 'text-zinc-500 dark:text-zinc-450 hover:bg-zinc-200/30'
            }`}
          >
            ✨ 自由儲蓄
          </motion.button>
          <motion.button 
            whileTap={{ scale: 0.96 }}
            type="button"
            onClick={() => setSavingMode('subscription')}
            className={`flex-1 font-bold text-xs sm:text-sm py-3 rounded-xl text-center transition-all flex items-center justify-center gap-1 cursor-pointer ${
              savingMode === 'subscription' 
                ? 'bg-indigo-650 bg-indigo-600 text-white shadow-md scale-[1.01]' 
                : 'text-zinc-500 dark:text-zinc-450 hover:bg-zinc-200/30'
            }`}
          >
            📅 固定開銷
          </motion.button>
        </div>
      </div>

      {/* 目標模式與自由儲蓄模式 */}
      {savingMode === 'goal' && (
        <>
          {/* 存錢筒數位存摺總額卡牌 */}
          <div className={`bg-white dark:bg-zinc-900 rounded-3xl p-6 shadow-md border flex flex-col gap-2 relative overflow-hidden ${
            theme.id === 'shiba' ? 'border-amber-955/10' : 'border-emerald-955/10'
          }`}>
            <div className={`absolute top-0 left-0 w-full h-1.5 bg-gradient-to-r ${theme.styles.vaultHeaderBg}`}></div>

            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className={`p-2 rounded-full flex items-center justify-center ${theme.id === 'shiba' ? 'bg-amber-100 dark:bg-amber-950/50 text-amber-800' : 'bg-emerald-100 dark:bg-emerald-950/50 text-emerald-805'}`}>
                  <span className="text-xl">{theme.id === 'shiba' ? '🦴' : '🍖'}</span>
                </div>
                <h2 className={`text-headline-md font-headline-md font-bold ${theme.styles.primaryText}`}>{theme.vaultTitle}</h2>
              </div>
              <span className={`text-3xl absolute -bottom-2 -right-2 transform -rotate-12 opacity-50 pointer-events-none select-none ${theme.id === 'shiba' ? 'text-amber-200' : 'text-emerald-200'}`}>🐾</span>
            </div>

            <div className="text-4xl font-extrabold text-stone-900 dark:text-zinc-100 mt-2 tracking-tight">
              NT$ {vaultTotal.toLocaleString()}
            </div>

            <div className="flex items-center justify-between mt-4 pt-3 border-t border-stone-100/40">
              <div className={`flex items-center gap-1.5 text-sm ${theme.styles.inputLabel}`}>
                <span>📈</span>
                <p className="font-semibold">{theme.vaultSub}</p>
              </div>
              
              <motion.button 
                whileTap={{ scale: 0.94 }}
                type="button"
                onClick={() => setShowDepositModal(true)}
                className={`text-xs font-bold py-2.5 px-4 rounded-full flex items-center gap-1 transition-all shadow-md cursor-pointer ${theme.styles.vaultBtn}`}
              >
                <Plus className="w-4 h-4" /> 存入骨頭
              </motion.button>
            </div>
          </div>

          {/* 存錢目標進度條 */}
          {goals.length === 0 ? (
            <div className={`border-2 border-dashed bg-white dark:bg-zinc-900 rounded-3xl p-8 text-center shadow-sm flex flex-col items-center justify-center gap-3 ${
              theme.id === 'shiba' ? 'border-amber-200 dark:border-zinc-800 text-amber-900/40 dark:text-zinc-500' : 'border-emerald-200 dark:border-zinc-800 text-emerald-900/40 dark:text-zinc-500'
            }`}>
              <span className="text-5xl block">🎯</span>
              <p className="text-sm font-bold text-stone-850 dark:text-zinc-200">目前沒有設定任何儲蓄目標汪！</p>
              <p className="text-xs text-stone-500 dark:text-zinc-400 max-w-xs">點擊下方「建立新儲蓄目標」來為想買的東西設定儲蓄計劃吧！</p>
              <motion.button
                whileTap={{ scale: 0.96 }}
                onClick={() => setShowGoalModal(true)}
                className={`mt-2 w-48 py-2.5 border-2 border-dashed bg-transparent rounded-xl text-xs font-bold flex items-center justify-center gap-1 cursor-pointer transition-colors ${
                  theme.id === 'shiba' 
                    ? 'border-amber-300 text-amber-650 hover:border-amber-500 hover:bg-amber-50/30' 
                    : 'border-emerald-300 text-emerald-600 hover:border-emerald-505 hover:bg-emerald-50/30'
                }`}
              >
                🐾 建立新儲蓄目標
              </motion.button>
            </div>
          ) : (
            <div className={`bg-white dark:bg-zinc-900 rounded-3xl p-6 border shadow-md flex flex-col gap-4 ${
              theme.id === 'shiba' ? 'border-amber-955/10' : 'border-emerald-955/10'
            }`}>
              <div className="flex justify-between items-end">
                <div className="max-w-[70%]">
                  <h3 className="text-headline-md font-headline-md text-stone-900 dark:text-zinc-100 flex items-center gap-1.5">
                    <span>🍖</span> {activeGoal ? activeGoal.name : '緊急肉乾備用基金'}
                    {activeGoal && (
                      <button
                        onClick={() => onDeleteGoal(activeGoal.id)}
                        className="text-stone-400 hover:text-red-500 transition-colors p-1 rounded-full hover:bg-red-50 dark:hover:bg-zinc-800 cursor-pointer ml-1"
                        title="刪除此儲蓄目標"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    )}
                  </h3>
                  <p className={`text-xs mt-1 ${theme.styles.quotesBottom}`}>
                    目標金額: NT$ {snackFundGoal.toLocaleString()}
                    {activeGoal?.targetDate && ` • 期限: ${activeGoal.targetDate}`}
                  </p>
                  
                  {warningLabel && (
                    <span className="inline-flex items-center gap-1 mt-1.5 text-[10px] font-bold bg-red-50 dark:bg-red-950/30 text-red-600 dark:text-red-300 px-2 py-0.5 rounded-md border border-red-200/20">
                      <AlertCircle className="w-3 h-3" /> {warningLabel}
                    </span>
                  )}
                </div>
                <div className={`font-extrabold text-2xl px-4 py-1.5 rounded-2xl border shadow-xs ${theme.styles.activeGoalBg}`}>
                  {snackFundPercent}%
                </div>
              </div>

              <div className={`relative w-full h-8 rounded-full mt-4 overflow-visible shadow-inner border ${
                theme.id === 'shiba' ? 'bg-amber-100/40 dark:bg-zinc-800 border-amber-900/5' : 'bg-emerald-100/40 dark:bg-zinc-800 border-emerald-900/5'
              }`}>
                <div 
                  className={`absolute top-0 left-0 h-full bg-gradient-to-r rounded-full transition-all duration-1000 ease-out shadow-sm ${theme.styles.progressBar}`}
                  style={{ width: `${snackFundPercent}%` }}
                >
                  <div className="w-full h-1/2 bg-white/10 rounded-full"></div>
                </div>
              </div>

              <div className={`flex justify-between mt-1 text-xs font-semibold ${theme.styles.quotesBottom}`}>
                <span>已存: NT$ {vaultTotal.toLocaleString()}</span>
                <span>目標: NT$ {snackFundGoal.toLocaleString()}</span>
              </div>

              {/* 切換其他目標選單 */}
              {goals.length > 1 && (
                <div className="flex flex-col gap-2 mt-2 pt-2 border-t border-stone-100/40">
                  <span className={`text-[10px] font-bold uppercase tracking-wider ${theme.styles.quotesBottom}`}>切換其他存錢目標：</span>
                  <div className="flex gap-2 overflow-x-auto pb-1 select-none">
                    {goals.map(g => (
                      <motion.button
                        whileTap={{ scale: 0.96 }}
                        key={g.id}
                        onClick={() => onSelectGoal(g.id)}
                        className={`px-3 py-1.5 rounded-full text-xs font-bold whitespace-nowrap transition-all border ${
                          g.id === activeGoalId
                            ? theme.id === 'shiba' 
                              ? 'bg-amber-600 border-amber-600 text-white shadow-xs'
                              : 'bg-emerald-600 border-emerald-600 text-white shadow-xs'
                            : `bg-stone-50 dark:bg-zinc-800 border-stone-200 text-stone-600 dark:text-zinc-400 hover:bg-stone-100`
                        }`}
                      >
                        🐾 {g.name}
                      </motion.button>
                    ))}
                  </div>
                </div>
              )}

              {/* ➕ 建立新目標按鈕 */}
              <motion.button
                whileTap={{ scale: 0.96 }}
                onClick={() => setShowGoalModal(true)}
                className={`mt-2 w-full py-2.5 border-2 border-dashed bg-transparent rounded-xl text-xs font-bold flex items-center justify-center gap-1 cursor-pointer transition-colors ${
                  theme.id === 'shiba' 
                    ? 'border-amber-300 text-amber-650 hover:border-amber-500 hover:bg-amber-50/30' 
                    : 'border-emerald-300 text-emerald-605 hover:border-emerald-500 hover:bg-emerald-50/30'
                }`}
              >
                🐾 建立新儲蓄目標
              </motion.button>
            </div>
          )}

          {/* 寵物鼓勵語錄區塊 */}
          <div className={`rounded-3xl p-6 flex flex-col items-center text-center gap-4 relative overflow-hidden shadow-sm border ${theme.styles.quotesBg}`}>
            <div className={`absolute -top-10 -left-10 w-32 h-32 rounded-full filter blur-xl ${theme.id === 'shiba' ? 'bg-amber-300/10' : 'bg-emerald-305/10'}`}></div>
            <div className={`absolute -bottom-10 -right-10 w-32 h-32 rounded-full filter blur-xl ${theme.id === 'shiba' ? 'bg-orange-300/10' : 'bg-teal-300/10'}`}></div>

            <div className="w-24 h-24 rounded-full border-4 border-white dark:border-zinc-800 shadow-md overflow-hidden bg-white dark:bg-zinc-850 flex items-center justify-center relative z-10 transition-transform hover:rotate-6 select-none">
              {theme.mascotAvatarType === 'image' ? (
                <img src={theme.mascotAvatar} alt="Mascot" className="w-full h-full object-cover animate-bounce-slow" />
              ) : (
                <span className="text-5xl animate-bounce-slow filter drop-shadow-md">{theme.mascotAvatar}</span>
              )}
            </div>

            <div className="relative z-10 flex flex-col gap-2 max-w-sm">
              <h4 className={`text-sm font-extrabold uppercase tracking-widest ${theme.styles.quotesTitle}`}>
                {theme.mascotCardTitle}
              </h4>
              <p className={`text-base leading-relaxed font-bold italic ${theme.styles.quotesBody}`}>
                「 {theme.quotes[vaultTotal % theme.quotes.length]} 」
              </p>
              <p className={`text-xs mt-1 ${theme.styles.quotesBottom}`}>
                {theme.mascotEncourage}
              </p>
            </div>
          </div>
        </>
      )}

      {savingMode === 'free' && (
        <div className="flex flex-col gap-5 animate-fade-in">
          {/* 無上限數位存摺 */}
          <div className={`bg-white dark:bg-zinc-900 rounded-3xl p-6 shadow-md border flex flex-col gap-2 relative overflow-hidden ${
            theme.id === 'shiba' ? 'border-amber-955/10' : 'border-emerald-955/10'
          }`}>
            <div className={`absolute top-0 left-0 h-1.5 w-full bg-gradient-to-r ${theme.styles.vaultHeaderBg}`}></div>
            
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className={`p-2 rounded-full flex items-center justify-center ${theme.id === 'shiba' ? 'bg-amber-100 dark:bg-amber-950/50 text-amber-800' : 'bg-emerald-100 dark:bg-emerald-950/50 text-emerald-805'}`}>
                  <span className="text-xl">✨</span>
                </div>
                <h2 className={`text-headline-md font-headline-md font-bold ${theme.styles.primaryText}`}>無上限自由存錢筒</h2>
              </div>
              <span className={`text-4xl absolute -bottom-2 -right-2 transform -rotate-12 pointer-events-none select-none font-bold ${theme.id === 'shiba' ? 'text-amber-600/10' : 'text-emerald-600/10'}`}>♾️</span>
            </div>

            <div className={`text-xs mt-1 ${theme.styles.quotesBottom}`}>
              🐾 當前累積儲蓄金：
            </div>

            <div className={`text-4xl font-extrabold tracking-tight mt-1 ${theme.id === 'shiba' ? 'text-amber-605 text-amber-600' : 'text-emerald-600 dark:text-emerald-400'}`}>
              NT$ {vaultTotal.toLocaleString()}
            </div>

            <div className="flex items-center justify-between mt-4 pt-3 border-t border-stone-100/40">
              <div className={`flex items-center gap-1.5 text-xs ${theme.styles.quotesBottom}`}>
                <span>⭐ 儲蓄階級：</span>
                <span className={`font-bold ${theme.id === 'shiba' ? 'text-amber-700 dark:text-amber-450' : 'text-emerald-700 dark:text-emerald-450'}`}>
                  {vaultTotal < 1000 ? `🐾 存錢新手${theme.dogName}` :
                   vaultTotal < 5000 ? '🍖 潔牙骨富豪' :
                   vaultTotal < 20000 ? '🥩 罐罐批發商' : `👑 頂級${theme.dogName}爸媽`}
                </span>
              </div>
              
              <motion.button 
                whileTap={{ scale: 0.94 }}
                type="button"
                onClick={() => setShowDepositModal(true)}
                className={`text-white text-xs font-bold py-2.5 px-4 rounded-full flex items-center gap-1 transition-all shadow-md cursor-pointer ${theme.styles.primaryBtn}`}
              >
                <Plus className="w-4 h-4" /> 隨手存一筆
              </motion.button>
            </div>
          </div>

          {/* 自由儲蓄說明與快捷投幣卡片 */}
          <div className={`bg-white dark:bg-zinc-900 rounded-3xl p-6 border shadow-md flex flex-col gap-4 ${
            theme.id === 'shiba' ? 'border-amber-955/10' : 'border-emerald-955/10'
          }`}>
            <h3 className={`text-headline-md font-headline-md flex items-center gap-1.5 ${theme.styles.primaryText}`}>
              <span>💡</span> 什麼是「自由儲蓄」？
            </h3>
            
            <p className="text-sm text-stone-700 dark:text-zinc-300 leading-relaxed font-medium">
              自由儲蓄是一個<strong>無上限的虛擬存錢筒</strong>！不同於有特定期程與指定金額門檻的「存錢目標」，這裡<strong>沒有任何額度限制與期限壓力</strong>，旨在讓您享受無痛積累的樂趣。
            </p>
            <p className={`text-xs leading-relaxed ${theme.styles.quotesBottom}`}>
              手邊多出的零錢、發票中獎，或少喝一杯咖啡飲料省下的閒置小錢，隨時都可以點擊上方「隨手存一筆」或使用下方「快捷投幣」直接投進存錢筒，讓資產在{theme.dogName}的守護下默默長大！
            </p>

            {/* 快捷投幣按鈕組 */}
            <div className="flex flex-col gap-2.5 mt-2.5 pt-4 border-t border-stone-100/40">
              <span className={`text-[10px] font-bold uppercase tracking-wider flex items-center gap-1 ${theme.styles.quotesBottom}`}>
                🪙 快捷投幣（點擊直接存入）：
              </span>
              <div className="grid grid-cols-4 gap-2">
                {[50, 100, 500, 1000].map((amount) => (
                  <motion.button
                    whileTap={{ scale: 0.94 }}
                    key={amount}
                    type="button"
                    onClick={() => onAddSaving(amount)}
                    className={`py-2.5 px-2 rounded-xl text-xs font-bold border transition-all text-center cursor-pointer ${
                      theme.id === 'shiba' 
                        ? 'bg-amber-50 dark:bg-amber-955/40 border-amber-250 dark:border-amber-900/30 text-amber-800 dark:text-amber-300 hover:bg-amber-100/50' 
                        : 'bg-emerald-50 dark:bg-emerald-955/40 border-emerald-250 dark:border-emerald-900/30 text-emerald-808 dark:text-emerald-300 hover:bg-emerald-100/50'
                    }`}
                  >
                    + ${amount}
                  </motion.button>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 固定開銷訂閱制管理模式 */}
      {savingMode === 'subscription' && (
        <SubscriptionManager
          subscriptions={subscriptions}
          onAddSubscription={onAddSubscription}
          onDeleteSubscription={onDeleteSubscription}
        />
      )}

      {showDepositModal && (
        <div className="fixed inset-0 z-55 flex items-center justify-center bg-black/40 backdrop-blur-xs select-none p-4">
          <div className={`bg-white dark:bg-zinc-900 rounded-3xl p-5 max-w-[90%] w-96 border shadow-xl relative animate-fade-in ${
            theme.id === 'shiba' ? 'border-amber-955/20' : 'border-emerald-955/20'
          }`}>
            <h3 className={`text-headline-md font-headline-md mb-3 flex items-center gap-1.5 ${theme.styles.primaryText}`}>
              <span>🦴</span> 存入儲蓄基金
            </h3>
            
            <form onSubmit={handleDepositSubmit} className="flex flex-col gap-4">
              <div className={`p-4 rounded-xl border ${
                theme.id === 'shiba' ? 'bg-amber-50/60 dark:bg-zinc-800/60 border-amber-955/10' : 'bg-emerald-50/60 dark:bg-zinc-800/60 border-emerald-955/10'
              }`}>
                <label className={`text-xs font-bold block mb-1 ${theme.styles.inputLabel}`}>
                  存入金額 (NT$) *
                </label>
                <input
                  type="number"
                  value={depositAmount}
                  onChange={(e) => setDepositAmount(e.target.value)}
                  placeholder="輸入要存的金額"
                  className="w-full bg-transparent border-0 p-0 text-xl font-bold text-stone-900 dark:text-zinc-100 focus:ring-0 placeholder:text-stone-300"
                  required
                  min="1"
                />
              </div>

              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setShowDepositModal(false)}
                  className="flex-1 border border-stone-200 text-stone-605 dark:text-zinc-300 py-3 rounded-xl font-semibold text-sm hover:bg-stone-50 dark:hover:bg-zinc-850 transition-colors cursor-pointer"
                >
                  取消
                </button>
                <button
                  type="submit"
                  className={`flex-1 text-white font-bold py-3 rounded-xl text-sm shadow-md transition-all cursor-pointer ${theme.styles.primaryBtn}`}
                >
                  確認存下 🦴
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* 🐾 建立新儲蓄目標彈出視窗 */}
      {showGoalModal && (
        <div className="fixed inset-0 z-55 flex items-center justify-center bg-black/40 backdrop-blur-xs select-none p-4">
          <div className={`bg-white dark:bg-zinc-900 rounded-3xl p-5 max-w-[90%] w-96 border shadow-xl relative animate-fade-in ${
            theme.id === 'shiba' ? 'border-amber-955/20' : 'border-emerald-955/20'
          }`}>
            <h3 className={`text-headline-md font-headline-md mb-3 flex items-center gap-1.5 ${theme.styles.primaryText}`}>
              <span>🎯</span> 建立新儲蓄目標
            </h3>
            
            <form onSubmit={handleGoalSubmit} className="flex flex-col gap-4">
              <div className="flex flex-col gap-3.5">
                <div className={`p-3 rounded-xl border ${
                  theme.id === 'shiba' ? 'bg-amber-50/60 dark:bg-zinc-800/60 border-amber-955/10' : 'bg-emerald-50/60 dark:bg-zinc-800/60 border-emerald-955/10'
                }`}>
                  <label className={`text-xs font-bold block mb-1 ${theme.styles.inputLabel}`}>
                    目標名稱 (例如：買新飛盤、潔牙骨庫存) *
                  </label>
                  <input
                    type="text"
                    value={newGoalName}
                    onChange={(e) => setNewGoalName(e.target.value)}
                    placeholder="輸入目標名稱"
                    className="w-full bg-transparent border-none p-0 text-sm font-bold text-stone-900 dark:text-zinc-100 focus:ring-0 placeholder:text-stone-300"
                    required
                  />
                </div>

                <div className={`p-3 rounded-xl border ${
                  theme.id === 'shiba' ? 'bg-amber-50/60 dark:bg-zinc-800/60 border-amber-955/10' : 'bg-emerald-50/60 dark:bg-zinc-800/60 border-emerald-955/10'
                }`}>
                  <label className={`text-xs font-bold block mb-1 ${theme.styles.inputLabel}`}>
                    目標金額 (NT$) *
                  </label>
                  <input
                    type="number"
                    value={newGoalAmount}
                    onChange={(e) => setNewGoalAmount(e.target.value)}
                    placeholder="例如：3000"
                    className="w-full bg-transparent border-none p-0 text-sm font-bold text-stone-900 dark:text-zinc-100 focus:ring-0 placeholder:text-stone-300"
                    required
                    min="1"
                  />
                </div>

                <div className={`p-3 rounded-xl border ${
                  theme.id === 'shiba' ? 'bg-amber-50/60 dark:bg-zinc-800/60 border-amber-955/10' : 'bg-emerald-50/60 dark:bg-zinc-800/60 border-emerald-955/10'
                }`}>
                  <label className={`text-xs font-bold block mb-1 ${theme.styles.inputLabel}`}>
                    預計達成日期 (選填) 📅
                  </label>
                  <input
                    type="date"
                    value={newGoalDate}
                    onChange={(e) => setNewGoalDate(e.target.value)}
                    className="w-full bg-transparent border-none p-0 text-sm font-bold focus:ring-0 text-stone-800 dark:text-zinc-200"
                  />
                </div>
              </div>

              <div className="flex gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => {
                    setShowGoalModal(false);
                    setNewGoalName('');
                    setNewGoalAmount('');
                    setNewGoalDate('');
                  }}
                  className="flex-1 border border-stone-200 text-stone-605 dark:text-zinc-300 py-3 rounded-xl font-semibold text-sm hover:bg-stone-50 dark:hover:bg-zinc-855 transition-colors cursor-pointer"
                >
                  取消
                </button>
                <button
                  type="submit"
                  className={`flex-1 text-white font-bold py-3 rounded-xl text-sm shadow-md transition-all cursor-pointer ${theme.styles.primaryBtn}`}
                >
                  確認建立
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
