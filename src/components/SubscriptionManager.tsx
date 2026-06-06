import React, { useState } from 'react';
import { Subscription } from '../types';
import { Trash2, Plus, X } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { useTheme } from '../context/ThemeContext';

interface SubscriptionManagerProps {
  subscriptions: Subscription[];
  onAddSubscription: (sub: Omit<Subscription, 'id'>) => void;
  onDeleteSubscription: (id: string) => void;
}

export default function SubscriptionManager({
  subscriptions,
  onAddSubscription,
  onDeleteSubscription
}: SubscriptionManagerProps) {
  const { theme } = useTheme();
  const [showAddModal, setShowAddModal] = useState<boolean>(false);
  const [name, setName] = useState<string>('');
  const [amount, setAmount] = useState<string>('');
  const [recurringDate, setRecurringDate] = useState<string>('5');
  const [category, setCategory] = useState<string>('固定開銷');
  const [account, setAccount] = useState<'Cash' | 'Card'>('Card');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const parsedAmount = parseFloat(amount);
    const parsedDate = parseInt(recurringDate);
    if (!name.trim() || isNaN(parsedAmount) || parsedAmount <= 0 || isNaN(parsedDate) || parsedDate < 1 || parsedDate > 31) return;

    onAddSubscription({
      name: name.trim(),
      amount: parsedAmount,
      category,
      account,
      recurringDate: parsedDate
    });

    setName('');
    setAmount('');
    setRecurringDate('5');
    setCategory('固定開銷');
    setAccount('Card');
    setShowAddModal(false);
  };

  return (
    <div className="flex flex-col gap-5 animate-fade-in select-none">
      {/* 區塊標題與新增按鈕 */}
      <div className="flex justify-between items-center">
        <div>
          <h3 className={`text-headline-md font-headline-md flex items-center gap-1.5 ${theme.styles.primaryText}`}>
            <span>📅</span> 每月固定開銷
          </h3>
          <p className={`text-xs mt-1 font-medium ${theme.styles.quotesBottom}`}>
            設定您的定期自動扣款項目（如 Netflix, iCloud 等），{theme.dogName}會依期自動記帳！
          </p>
        </div>
        <motion.button
          whileTap={{ scale: 0.94 }}
          onClick={() => setShowAddModal(true)}
          className={`text-white text-xs font-bold py-2.5 px-3.5 rounded-xl flex items-center gap-1.5 shadow-md transition-all cursor-pointer whitespace-nowrap ${theme.styles.primaryBtn}`}
        >
          <Plus className="w-3.5 h-3.5" /> 新增開銷
        </motion.button>
      </div>

      {/* 固定開銷訂閱清單 */}
      {subscriptions.length === 0 ? (
        <div className={`border-2 border-dashed rounded-3xl p-8 text-center bg-white dark:bg-zinc-900 ${
          theme.id === 'shiba' ? 'border-amber-200 text-amber-900/40 dark:text-zinc-500' : 'border-emerald-200 text-emerald-900/40 dark:text-zinc-500'
        }`}>
          <span className="text-4xl mb-2 block">🔄</span>
          <p className="text-sm font-semibold">目前沒有設定任何每月固定開銷項目汪！</p>
          <p className="text-[10px] text-stone-500 dark:text-zinc-500 mt-1">點擊右上方「新增開銷」來為定期付款服務（如軟體訂閱、房租）設定自動扣款記帳吧！</p>
        </div>
      ) : (
        <motion.div 
          layout 
          className="grid grid-cols-1 gap-3.5"
        >
          <AnimatePresence initial={false}>
            {subscriptions.map((sub) => (
              <motion.div
                layout
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.95 }}
                transition={{ duration: 0.25 }}
                key={sub.id}
                className={`bg-white dark:bg-zinc-900 rounded-2xl p-4 border shadow-sm flex items-center justify-between relative overflow-hidden group transition-all ${
                  theme.id === 'shiba' ? 'border-amber-955/10 hover:border-amber-300' : 'border-emerald-955/10 hover:border-emerald-300'
                }`}
              >
                {/* 裝飾線條色塊 */}
                <div className={`absolute top-0 left-0 h-full w-1 ${theme.id === 'shiba' ? 'bg-amber-600' : 'bg-emerald-600'}`}></div>

                <div className="flex items-center gap-3.5 pl-2">
                  <div className={`w-11 h-11 rounded-full flex items-center justify-center font-bold text-lg ${theme.styles.primaryBg} ${theme.styles.primaryText}`}>
                    {sub.category === '娛樂' ? '🍿' : sub.category === '餐飲' ? '☕' : sub.category === '交通' ? '🚌' : '🔄'}
                  </div>
                  <div>
                    <h4 className="font-bold text-sm text-stone-900 dark:text-zinc-100 flex items-center gap-1.5">
                      {sub.name}
                      <span className={`inline-flex items-center text-[9px] px-1.5 py-0.5 rounded-md font-bold ${
                        theme.id === 'shiba' ? 'bg-amber-100/50 text-amber-800' : 'bg-emerald-100/50 text-emerald-800'
                      }`}>
                        每月 {sub.recurringDate} 號
                      </span>
                    </h4>
                    <p className={`text-xs mt-1 ${theme.styles.quotesBottom}`}>
                      分類: {sub.category} • 付款: {sub.account === 'Cash' ? '💵 現金' : '💳 刷卡'}
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-3.5">
                  <span className="font-extrabold text-sm sm:text-base text-red-650 dark:text-red-400">
                    - NT$ {sub.amount.toLocaleString()}
                  </span>
                  
                  {/* 刪除按鈕 */}
                  <motion.button
                    whileTap={{ scale: 0.9 }}
                    onClick={() => onDeleteSubscription(sub.id)}
                    className="p-2 rounded-full text-zinc-400 hover:text-red-500 hover:bg-red-55/10 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
                    title="刪除此開銷"
                  >
                    <Trash2 className="w-4 h-4" />
                  </motion.button>
                </div>
              </motion.div>
            ))}
          </AnimatePresence>
        </motion.div>
      )}

      {/* ➕ 新增固定開銷彈出視窗 */}
      <AnimatePresence>
        {showAddModal && (
          <div className="fixed inset-0 z-55 flex items-center justify-center bg-black/40 backdrop-blur-xs p-4">
            <motion.div 
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.9 }}
              className={`bg-white dark:bg-zinc-900 rounded-3xl p-5 max-w-[90%] w-96 border shadow-xl relative animate-fade-in ${
                theme.id === 'shiba' ? 'border-amber-955/20' : 'border-emerald-955/20'
              }`}
            >
              <div className="flex justify-between items-center mb-3">
                <h3 className={`text-headline-md font-headline-md flex items-center gap-1.5 ${theme.styles.primaryText}`}>
                  <span>📅</span> 新增固定定期開銷
                </h3>
                <button 
                  onClick={() => setShowAddModal(false)}
                  className={`w-8 h-8 rounded-full flex items-center justify-center transition-colors cursor-pointer ${
                    theme.id === 'shiba' ? 'bg-amber-50 text-amber-800 hover:bg-amber-100' : 'bg-emerald-50 text-emerald-800 hover:bg-emerald-100'
                  }`}
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <form onSubmit={handleSubmit} className="flex flex-col gap-4">
                <div className="flex flex-col gap-3">
                  {/* 項目名稱 */}
                  <div className={`p-3 rounded-xl border ${
                    theme.id === 'shiba' ? 'bg-amber-50/60 dark:bg-zinc-800/60 border-amber-955/10' : 'bg-emerald-50/60 dark:bg-zinc-800/60 border-emerald-955/10'
                  }`}>
                    <label className={`text-xs font-bold block mb-1 ${theme.styles.inputLabel}`}>
                      開銷項目名稱 (例如：Netflix, Google One) *
                    </label>
                    <input
                      type="text"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder="輸入項目名稱"
                      className="w-full bg-transparent border-none p-0 text-sm font-bold text-stone-900 dark:text-zinc-100 focus:ring-0 placeholder:text-stone-300"
                      required
                    />
                  </div>

                  {/* 開銷金額 */}
                  <div className={`p-3 rounded-xl border ${
                    theme.id === 'shiba' ? 'bg-amber-50/60 dark:bg-zinc-800/60 border-amber-955/10' : 'bg-emerald-50/60 dark:bg-zinc-800/60 border-emerald-955/10'
                  }`}>
                    <label className={`text-xs font-bold block mb-1 ${theme.styles.inputLabel}`}>
                      每月扣款金額 (NT$) *
                    </label>
                    <input
                      type="number"
                      value={amount}
                      onChange={(e) => setAmount(e.target.value)}
                      placeholder="例如：390"
                      className="w-full bg-transparent border-none p-0 text-sm font-bold text-stone-900 dark:text-zinc-100 focus:ring-0 placeholder:text-stone-300"
                      required
                      min="1"
                    />
                  </div>

                  {/* 每月扣款日 (1-31) */}
                  <div className={`p-3 rounded-xl border ${
                    theme.id === 'shiba' ? 'bg-amber-50/60 dark:bg-zinc-800/60 border-amber-955/10' : 'bg-emerald-50/60 dark:bg-zinc-800/60 border-emerald-955/10'
                  }`}>
                    <label className={`text-xs font-bold block mb-1 ${theme.styles.inputLabel}`}>
                      每月扣款日 (1 至 31 號) *
                    </label>
                    <input
                      type="number"
                      value={recurringDate}
                      onChange={(e) => setRecurringDate(e.target.value)}
                      className="w-full bg-transparent border-none p-0 text-sm font-bold text-stone-900 dark:text-zinc-100 focus:ring-0"
                      required
                      min="1;;"
                      max="31"
                    />
                  </div>

                  {/* 選擇分類 */}
                  <div className={`p-3 rounded-xl border ${
                    theme.id === 'shiba' ? 'bg-amber-50/60 dark:bg-zinc-800/60 border-amber-955/10' : 'bg-emerald-50/60 dark:bg-zinc-800/60 border-emerald-955/10'
                  }`}>
                    <label className={`text-xs font-bold block mb-1 ${theme.styles.inputLabel}`}>
                      選擇扣款分類
                    </label>
                    <select
                      value={category}
                      onChange={(e) => setCategory(e.target.value)}
                      className="w-full bg-transparent border-none p-0 text-sm font-bold text-stone-900 dark:text-zinc-100 focus:ring-0 cursor-pointer"
                    >
                      <option value="固定開銷" className="text-stone-900 dark:text-zinc-100 bg-white dark:bg-zinc-900">🔄 固定開銷</option>
                      <option value="娛樂" className="text-stone-900 dark:text-zinc-100 bg-white dark:bg-zinc-900">🍿 娛樂</option>
                      <option value="餐飲" className="text-stone-900 dark:text-zinc-100 bg-white dark:bg-zinc-900">☕ 餐飲</option>
                      <option value="交通" className="text-stone-900 dark:text-zinc-100 bg-white dark:bg-zinc-900">🚌 交通</option>
                      <option value="購物" className="text-stone-900 dark:text-zinc-100 bg-white dark:bg-zinc-900">🛍️ 購物</option>
                    </select>
                  </div>

                  {/* 付款方式 */}
                  <div className={`p-3 rounded-xl border ${
                    theme.id === 'shiba' ? 'bg-amber-50/60 dark:bg-zinc-800/60 border-amber-955/10' : 'bg-emerald-50/60 dark:bg-zinc-800/60 border-emerald-955/10'
                  }`}>
                    <label className={`text-xs font-bold block mb-1 ${theme.styles.inputLabel}`}>
                      扣款付款方式
                    </label>
                    <select
                      value={account}
                      onChange={(e) => setAccount(e.target.value as any)}
                      className="w-full bg-transparent border-none p-0 text-sm font-bold text-stone-900 dark:text-zinc-100 focus:ring-0 cursor-pointer"
                    >
                      <option value="Card" className="text-stone-900 dark:text-zinc-100 bg-white dark:bg-zinc-900">💳 信用卡 / 行動支付</option>
                      <option value="Cash" className="text-stone-900 dark:text-zinc-100 bg-white dark:bg-zinc-900">💵 現金 / 銀行扣款</option>
                    </select>
                  </div>
                </div>

                <div className="flex gap-2 pt-2">
                  <button
                    type="button"
                    onClick={() => setShowAddModal(false)}
                    className={`flex-1 border text-stone-605 dark:text-zinc-300 py-3 rounded-xl font-semibold text-sm transition-colors cursor-pointer border-stone-200 hover:bg-stone-50 dark:hover:bg-zinc-850`}
                  >
                    取消
                  </button>
                  <button
                    type="submit"
                    className={`flex-1 text-white font-bold py-3 rounded-xl text-sm shadow-md transition-all cursor-pointer ${theme.styles.primaryBtn}`}
                  >
                    確認新增
                  </button>
                </div>
              </form>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}
