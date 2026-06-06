import React, { useState, useEffect } from 'react';
import { Calendar, Trash2, Plus, AlertCircle, CheckCircle2, AlertTriangle, Wallet } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { Budget, Transaction } from '../types';
import { useTheme } from '../context/ThemeContext';

interface BudgetPlannerProps {
  transactions: Transaction[];
  budgets: Budget[];
  onAddBudget: (budget: Omit<Budget, 'id'>) => void;
  onDeleteBudget: (id: string) => void;
}

export default function BudgetPlanner({
  transactions,
  budgets,
  onAddBudget,
  onDeleteBudget
}: BudgetPlannerProps) {
  const { theme } = useTheme();

  // 預算設定表單狀態
  const [selectedCategory, setSelectedCategory] = useState<string>('餐飲');
  const [selectedPeriod, setSelectedPeriod] = useState<'weekly' | 'monthly'>('monthly');
  const [budgetAmount, setBudgetAmount] = useState<string>('');

  // 取得使用者自訂的所有支出分類（與 Dashboard 保持同步）
  const [categories, setCategories] = useState<{ name: string; icon: string; color: string; type: string }[]>([]);

  useEffect(() => {
    const saved = localStorage.getItem('custom_categories');
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        setCategories(parsed);
        // 設定預設 category
        const firstExpense = parsed.find((c: any) => c.type === 'expense');
        if (firstExpense) {
          setSelectedCategory(firstExpense.name);
        }
      } catch (e) {
        console.error('Failed to parse custom categories:', e);
      }
    } else {
      // 預設分類
      const defaultCategories = [
        { name: '餐飲', icon: '🍖', color: '', type: 'expense' },
        { name: '交通', icon: '🚗', color: '', type: 'expense' },
        { name: '購物', icon: '🛍️', color: '', type: 'expense' },
        { name: '娛樂', icon: '✨', color: '', type: 'expense' },
      ];
      setCategories(defaultCategories);
    }
  }, []);

  const expenseCategories = categories.filter(c => c.type === 'expense');

  // 動態獲取分類的 Icon
  const getCategoryIcon = (catName: string) => {
    const found = categories.find(c => c.name === catName);
    return found ? found.icon : '🐾';
  };

  // 計算特定分類與週期的實際總支出
  const calculateSpentAmount = (category: string, period: 'weekly' | 'monthly') => {
    const now = new Date();

    if (period === 'monthly') {
      const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
      const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);

      return transactions
        .filter(t => t.type === 'expense' && t.category === category)
        .reduce((sum, t) => {
          const txDate = new Date(t.date.replace(' ', 'T'));
          if (txDate >= startOfMonth && txDate <= endOfMonth) {
            return sum + t.amount;
          }
          return sum;
        }, 0);
    } else {
      // weekly: 週一到週日
      const currentDay = now.getDay();
      const distanceToMonday = currentDay === 0 ? 6 : currentDay - 1;
      const startOfWeek = new Date(now.getFullYear(), now.getMonth(), now.getDate() - distanceToMonday, 0, 0, 0, 0);
      const endOfWeek = new Date(startOfWeek.getTime() + 7 * 24 * 60 * 60 * 1000 - 1);

      return transactions
        .filter(t => t.type === 'expense' && t.category === category)
        .reduce((sum, t) => {
          const txDate = new Date(t.date.replace(' ', 'T'));
          if (txDate >= startOfWeek && txDate <= endOfWeek) {
            return sum + t.amount;
          }
          return sum;
        }, 0);
    }
  };

  const handleAddSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const amount = parseFloat(budgetAmount);
    if (!selectedCategory || isNaN(amount) || amount <= 0) return;

    // 檢查是否已存在相同分類與週期的預算，若存在則先提示
    const existIdx = budgets.findIndex(b => b.category === selectedCategory && b.period === selectedPeriod);
    if (existIdx > -1) {
      if (!confirm(`🐾 提醒：您已經設定過「${selectedCategory}」的${selectedPeriod === 'weekly' ? '每週' : '每月'}預算汪！\n確認要覆蓋並重新設定嗎？`)) {
        return;
      }
      onDeleteBudget(budgets[existIdx].id);
    }

    onAddBudget({
      category: selectedCategory,
      period: selectedPeriod,
      amount
    });

    setBudgetAmount('');
  };

  // 預算進度條的動態顏色
  const getProgressColorClass = (percent: number) => {
    if (percent <= 50) return 'bg-green-500 dark:bg-emerald-500';
    if (percent <= 80) return 'bg-amber-500 dark:bg-yellow-500';
    return 'bg-red-500 dark:bg-rose-500 animate-pulse';
  };

  const getProgressTextColorClass = (percent: number) => {
    if (percent <= 50) return 'text-green-600 dark:text-emerald-400';
    if (percent <= 80) return 'text-amber-600 dark:text-yellow-400';
    return 'text-red-600 dark:text-rose-400';
  };

  return (
    <div className="flex flex-col gap-6 animate-fade-in relative pb-10">
      {/* 標題區 */}
      <div className="flex flex-col gap-1">
        <h1 className={`text-3xl font-extrabold tracking-tight ${theme.styles.primaryText}`}>
          📅 理財預算規劃
        </h1>
        <p className={`text-body-md ${theme.id === 'shiba' ? 'text-amber-900/60 dark:text-zinc-400' : 'text-emerald-900/60 dark:text-zinc-400'}`}>
          幫{theme.dogName}把關每筆消費，設定每週或每月預算，超支時{theme.dogName}會對您發出警告汪！🐶
        </p>
      </div>

      {/* 預算設定表單 */}
      <section className={`bg-white dark:bg-zinc-900 rounded-3xl p-5 border shadow-md ${
        theme.id === 'shiba' ? 'border-amber-955/10 shadow-amber-900/5' : 'border-emerald-955/10 shadow-emerald-900/5'
      }`}>
        <h3 className={`text-headline-md font-headline-md mb-4 flex items-center gap-2 ${theme.styles.primaryText}`}>
          <span>➕</span> 新增預算額度
        </h3>

        <form onSubmit={handleAddSubmit} className="flex flex-col gap-4">
          {/* 分類選擇卡片/下拉選單 */}
          <div className="flex flex-col gap-2">
            <span className={`text-xs font-bold ${theme.styles.inputLabel}`}>選擇支出分類</span>
            <div className="grid grid-cols-4 gap-2">
              {expenseCategories.map((cat) => (
                <button
                  key={cat.name}
                  type="button"
                  onClick={() => setSelectedCategory(cat.name)}
                  className={`py-2 px-1 rounded-xl text-xs font-bold border-2 transition-all flex flex-col items-center justify-center gap-1 ${
                    selectedCategory === cat.name
                      ? theme.id === 'shiba'
                        ? 'border-amber-600 bg-amber-50 dark:bg-amber-955/30 text-amber-905 font-bold scale-[1.03]'
                        : 'border-emerald-600 bg-emerald-50 dark:bg-emerald-955/30 text-emerald-905 font-bold scale-[1.03]'
                      : 'border-transparent bg-stone-50 dark:bg-zinc-800 text-stone-600 dark:text-zinc-400 hover:bg-stone-100 dark:hover:bg-zinc-750'
                  }`}
                >
                  <span className="text-lg">{cat.icon}</span>
                  <span className="truncate w-full text-center">{cat.name}</span>
                </button>
              ))}
            </div>
          </div>

          {/* 週期選擇 pill switcher */}
          <div className="flex flex-col gap-2">
            <span className={`text-xs font-bold ${theme.styles.inputLabel}`}>預算週期</span>
            <div className={`rounded-xl p-1 shadow-inner border flex bg-stone-50 dark:bg-zinc-800 ${
              theme.id === 'shiba' ? 'border-amber-900/5' : 'border-emerald-900/5'
            }`}>
              <button
                type="button"
                onClick={() => setSelectedPeriod('weekly')}
                className={`flex-1 py-2 rounded-lg text-xs font-bold transition-all ${
                  selectedPeriod === 'weekly'
                    ? theme.id === 'shiba'
                      ? 'bg-amber-600 text-white shadow-sm'
                      : 'bg-emerald-600 text-white shadow-sm'
                    : 'text-stone-500 dark:text-zinc-450 hover:bg-stone-100/50 dark:hover:bg-zinc-750/50'
                }`}
              >
                📅 每週預算
              </button>
              <button
                type="button"
                onClick={() => setSelectedPeriod('monthly')}
                className={`flex-1 py-2 rounded-lg text-xs font-bold transition-all ${
                  selectedPeriod === 'monthly'
                    ? theme.id === 'shiba'
                      ? 'bg-amber-600 text-white shadow-sm'
                      : 'bg-emerald-600 text-white shadow-sm'
                    : 'text-stone-500 dark:text-zinc-450 hover:bg-stone-100/50 dark:hover:bg-zinc-750/50'
                }`}
              >
                🗓️ 每月預算
              </button>
            </div>
          </div>

          {/* 預算金額 */}
          <div className={`p-3.5 rounded-xl border-2 transition-all ${
            theme.id === 'shiba'
              ? 'bg-amber-50/50 dark:bg-zinc-800/50 focus-within:border-amber-400 focus-within:bg-white dark:focus-within:bg-zinc-800'
              : 'bg-emerald-50/50 dark:bg-zinc-800/50 focus-within:border-emerald-400 focus-within:bg-white dark:focus-within:bg-zinc-800'
          }`}>
            <label className={`text-xs font-bold block mb-1 ${theme.styles.inputLabel}`}>
              預算金額 (NT$) *
            </label>
            <div className="flex items-center">
              <span className="text-xl font-bold mr-1.5 text-stone-400">NT$</span>
              <input
                type="number"
                value={budgetAmount}
                onChange={(e) => setBudgetAmount(e.target.value)}
                placeholder="請輸入預算上限"
                className="w-full bg-transparent border-0 p-0 text-base font-bold text-stone-900 dark:text-zinc-100 focus:ring-0 placeholder:text-stone-300"
                required
                min="1"
              />
            </div>
          </div>

          {/* 新增按鈕 */}
          <motion.button
            whileTap={{ scale: 0.98 }}
            type="submit"
            className={`w-full text-white font-bold py-3.5 rounded-xl flex items-center justify-center gap-1.5 shadow-md transition-all cursor-pointer ${theme.styles.primaryBtn}`}
          >
            <Plus className="w-4 h-4" /> 設定這個預算額度汪！
          </motion.button>
        </form>
      </section>

      {/* 預算進度卡片清單 */}
      <section className="flex flex-col gap-4">
        <h3 className={`text-headline-md font-headline-md flex items-center gap-1.5 ${theme.styles.primaryText}`}>
          <span>📊</span> 當前預算監控
        </h3>

        {budgets.length === 0 ? (
          <div className={`border-2 border-dashed bg-white dark:bg-zinc-900 rounded-3xl p-10 text-center shadow-sm flex flex-col items-center justify-center gap-3 ${
            theme.id === 'shiba'
              ? 'border-amber-200 dark:border-zinc-800 text-amber-900/40 dark:text-zinc-500'
              : 'border-emerald-200 dark:border-zinc-800 text-emerald-900/40 dark:text-zinc-500'
          }`}>
            <span className="text-5xl">🍖</span>
            <p className="text-sm font-bold text-stone-800 dark:text-zinc-200">目前沒有設定任何預算控制汪！</p>
            <p className="text-xs text-stone-500 dark:text-zinc-400 max-w-xs">在上方設定預算，{theme.dogName}會在此即時分析您的支出進度汪～</p>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            <AnimatePresence initial={false}>
              {budgets.map((budget) => {
                const spent = calculateSpentAmount(budget.category, budget.period);
                const percent = budget.amount > 0 ? Math.round((spent / budget.amount) * 100) : 0;
                const remaining = budget.amount - spent;
                const isOver = remaining < 0;

                return (
                  <motion.div
                    key={budget.id}
                    layout
                    initial={{ opacity: 0, y: 15 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -15 }}
                    className={`bg-white dark:bg-zinc-900 rounded-3xl p-5 border shadow-sm flex flex-col gap-3 relative ${
                      theme.id === 'shiba' ? 'border-amber-955/10' : 'border-emerald-955/10'
                    }`}
                  >
                    <div className="flex justify-between items-start">
                      <div className="flex items-center gap-2">
                        <span className="text-2xl">{getCategoryIcon(budget.category)}</span>
                        <div>
                          <div className="flex items-center gap-1.5">
                            <span className="font-bold text-stone-900 dark:text-zinc-100">{budget.category}</span>
                            <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold ${
                              budget.period === 'weekly'
                                ? 'bg-blue-50 dark:bg-blue-950/30 text-blue-600 dark:text-blue-400 border border-blue-200/20'
                                : 'bg-purple-50 dark:bg-purple-950/30 text-purple-600 dark:text-purple-400 border border-purple-200/20'
                            }`}>
                              {budget.period === 'weekly' ? '每週' : '每月'}預算
                            </span>
                          </div>
                          <p className={`text-xs mt-1 ${theme.styles.quotesBottom}`}>
                            限額: NT$ {budget.amount.toLocaleString()}
                          </p>
                        </div>
                      </div>

                      <div className="flex items-center gap-3">
                        <span className={`font-extrabold text-lg px-2.5 py-1 rounded-xl border ${
                          percent > 80 
                            ? 'bg-red-50 dark:bg-red-950/30 text-red-600 dark:text-red-400 border-red-200/20'
                            : percent > 50
                            ? 'bg-amber-50 dark:bg-amber-950/30 text-amber-600 dark:text-amber-400 border-amber-200/20'
                            : 'bg-green-50 dark:bg-emerald-950/30 text-green-600 dark:text-emerald-400 border-green-200/20'
                        }`}>
                          {percent}%
                        </span>

                        <button
                          onClick={() => onDeleteBudget(budget.id)}
                          className="text-stone-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-zinc-800 p-1.5 rounded-full transition-colors cursor-pointer"
                          title="刪除此預算"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </div>

                    {/* 進度條 */}
                    <div className="w-full bg-stone-100 dark:bg-zinc-800 rounded-full h-3.5 overflow-hidden border border-stone-200/20 shadow-inner">
                      <div
                        className={`h-full rounded-full transition-all duration-500 ease-out ${getProgressColorClass(percent)}`}
                        style={{ width: `${Math.min(100, percent)}%` }}
                      ></div>
                    </div>

                    {/* 收支明細計算 */}
                    <div className="flex justify-between items-center text-xs font-semibold">
                      <span className="text-stone-500 dark:text-zinc-400">
                        已花費: NT$ {spent.toLocaleString()}
                      </span>
                      <span className={getProgressTextColorClass(percent)}>
                        {isOver 
                          ? `⚠️ 已超支: NT$ ${Math.abs(remaining).toLocaleString()}`
                          : `剩餘可用: NT$ ${remaining.toLocaleString()}`}
                      </span>
                    </div>
                  </motion.div>
                );
              })}
            </AnimatePresence>
          </div>
        )}
      </section>

      {/* 理財小叮嚀 */}
      <section className={`rounded-3xl p-5 flex gap-4 border ${
        theme.id === 'shiba' 
          ? 'bg-amber-50/50 dark:bg-zinc-800/40 border-amber-900/10 text-amber-900 dark:text-zinc-300' 
          : 'bg-emerald-50/50 dark:bg-zinc-800/40 border-emerald-900/10 text-emerald-900 dark:text-zinc-300'
      }`}>
        <Wallet className="w-8 h-8 flex-shrink-0 opacity-70 animate-bounce-slow" />
        <div>
          <h4 className="font-bold text-sm mb-1">{theme.dogName}理財悄悄話汪！</h4>
          <p className="text-xs leading-relaxed">
            透過「預算控制」，我們可以更有意識地克制消費衝動！當支出累積到預算的 80% 時，進度條會自動轉紅，提醒主人該踩煞車囉。記帳時若是會超支，我還會主動彈窗詢問，守護主人的荷包是我的神聖使命汪！🐾
          </p>
        </div>
      </section>
    </div>
  );
}
