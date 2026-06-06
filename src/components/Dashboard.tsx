import React, { useState, useEffect } from 'react';
import { Transaction, Budget } from '../types';
import { 
  Plus, 
  Search, 
  MessageSquare,
  ArrowUpRight,
  ArrowDownRight,
  X,
  Trash2
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { useTheme } from '../context/ThemeContext';

const formatAccountName = (acc: string) => {
  if (acc === 'Cash') return '現金';
  if (acc === 'Card') return '信用卡';
  return acc;
};

interface DashboardProps {
  balance: number;
  transactions: Transaction[];
  onAddTransaction: (transaction: Omit<Transaction, 'id'>) => void;
  onDeleteTransaction: (id: string) => void;
  onUpdateTransaction: (id: string, updatedTx: Omit<Transaction, 'id'>) => void;
  budgets: Budget[];
}

export default function Dashboard({ balance, transactions, onAddTransaction, onDeleteTransaction, onUpdateTransaction, budgets }: DashboardProps) {
  const { theme } = useTheme();
  const [amount, setAmount] = useState<string>('');
  const [type, setType] = useState<'expense' | 'income'>('expense');
  const [account, setAccount] = useState<string>('現金');
  const [category, setCategory] = useState<string>('餐飲');
  const [desc, setDesc] = useState<string>('');
  const [searchQuery, setSearchQuery] = useState<string>('');

  // 支付方式狀態與本機持久化
  const [paymentMethods, setPaymentMethods] = useState<string[]>(() => {
    const saved = localStorage.getItem('payment_methods');
    return saved ? JSON.parse(saved) : ['現金', '信用卡', '行動支付'];
  });
  const [showAddPayment, setShowAddPayment] = useState<boolean>(false);
  const [newPaymentName, setNewPaymentName] = useState<string>('');

  useEffect(() => {
    localStorage.setItem('payment_methods', JSON.stringify(paymentMethods));
  }, [paymentMethods]);

  // 自訂時間與自動刷新狀態
  const [customDate, setCustomDate] = useState<string>('');
  const [isTimeEdited, setIsTimeEdited] = useState<boolean>(false);

  const getSystemDateTimeString = () => {
    const now = new Date();
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    const hh = String(now.getHours()).padStart(2, '0');
    const min = String(now.getMinutes()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}T${hh}:${min}`;
  };

  useEffect(() => {
    setCustomDate(getSystemDateTimeString());

    const clockTimer = setInterval(() => {
      if (!isTimeEdited) {
        setCustomDate(getSystemDateTimeString());
      }
    }, 10000); // 每 10 秒刷新一次，保障時間即時精準
    return () => clearInterval(clockTimer);
  }, [isTimeEdited]);

  // 預算超支警告相關狀態
  const [showOverrunModal, setShowOverrunModal] = useState<boolean>(false);
  const [pendingTransaction, setPendingTransaction] = useState<Omit<Transaction, 'id'> | null>(null);
  const [overrunInfo, setOverrunInfo] = useState<{ period: string; limit: number; currentSpent: number; newTotal: number; overBy: number }[]>([]);

  const confirmAddPendingTransaction = () => {
    if (pendingTransaction) {
      onAddTransaction(pendingTransaction);
      setPendingTransaction(null);
      setOverrunInfo([]);
      setShowOverrunModal(false);

      setAmount('');
      setDesc('');
      setIsTimeEdited(false);
      setCustomDate(getSystemDateTimeString());
    }
  };

  const cancelAddPendingTransaction = () => {
    setPendingTransaction(null);
    setOverrunInfo([]);
    setShowOverrunModal(false);
  };

  // 長按與編輯模式狀態
  const longPressTimerRef = React.useRef<number | null>(null);
  const [editingTransaction, setEditingTransaction] = useState<Transaction | null>(null);
  const [editAmount, setEditAmount] = useState<string>('');
  const [editType, setEditType] = useState<'expense' | 'income'>('expense');
  const [editAccount, setEditAccount] = useState<string>('現金');
  const [editCategory, setEditCategory] = useState<string>('餐飲');
  const [editDesc, setEditDesc] = useState<string>('');
  const [editDate, setEditDate] = useState<string>('');

  const handlePointerDown = (e: React.PointerEvent, tx: Transaction) => {
    if (e.button !== 0) return; // 僅限主按鍵/觸控
    const target = e.target as HTMLElement;
    if (target.closest('button')) return; // 避免與刪除等按鈕衝突

    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
    }

    longPressTimerRef.current = window.setTimeout(() => {
      handleStartEdit(tx);
      longPressTimerRef.current = null;
    }, 500); // 500ms 長按
  };

  const handlePointerUp = () => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  };

  const handlePointerCancel = () => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  };

  const handleStartEdit = (tx: Transaction) => {
    setEditingTransaction(tx);
    setEditAmount(String(tx.amount));
    setEditType(tx.type);
    setEditAccount(formatAccountName(tx.account));
    setEditCategory(tx.category);
    setEditDesc(tx.note || '');
    setEditDate(tx.date.replace(' ', 'T'));
  };

  const handleEditSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingTransaction) return;
    const parsedAmount = parseFloat(editAmount);
    if (isNaN(parsedAmount) || parsedAmount <= 0) return;

    onUpdateTransaction(editingTransaction.id, {
      amount: parsedAmount,
      type: editType,
      category: editCategory,
      note: editDesc.trim() || undefined,
      account: editAccount,
      date: editDate.replace('T', ' '),
      icon: editCategory === '餐飲' ? 'UTENSILS' : editCategory === '交通' ? 'CAR' : editCategory === '購物' ? 'BAG' : 'SPARKLES'
    });

    setEditingTransaction(null);
  };

  // 動態分類管理：支援類別自由增加與「刪除 (x)」功能
  const [categories, setCategories] = useState<{name: string, icon: string, color: string, type: string}[]>(() => {
    const saved = localStorage.getItem('custom_categories');
    if (saved) {
      try {
        return JSON.parse(saved);
      } catch (e) {
        console.error(e);
      }
    }
    return [
      // 預設支出分類
      { name: '餐飲', icon: '🍖', color: theme.id === 'shiba' ? 'bg-amber-100/60 dark:bg-amber-955/40 text-amber-808 dark:text-amber-300' : 'bg-emerald-100/60 dark:bg-emerald-955/40 text-emerald-808 dark:text-emerald-300', type: 'expense' },
      { name: '交通', icon: '🚗', color: 'bg-blue-100/60 dark:bg-blue-955/40 text-blue-808 dark:text-blue-300', type: 'expense' },
      { name: '購物', icon: '🛍️', color: 'bg-pink-100/60 dark:bg-pink-955/40 text-pink-808 dark:text-pink-300', type: 'expense' },
      { name: '娛樂', icon: '✨', color: 'bg-purple-100/60 dark:bg-purple-955/40 text-purple-808 dark:text-purple-300', type: 'expense' },
      // 預設收入分類
      { name: '薪水', icon: '💼', color: 'bg-green-100/60 dark:bg-green-955/40 text-green-808 dark:text-green-300', type: 'income' },
      { name: '獎金', icon: '🎁', color: 'bg-red-100/60 dark:bg-red-955/40 text-red-808 dark:text-red-300', type: 'income' },
      { name: '投資', icon: '📈', color: 'bg-teal-100/60 dark:bg-teal-955/40 text-teal-808 dark:text-teal-300', type: 'income' },
    ];
  });

  useEffect(() => {
    localStorage.setItem('custom_categories', JSON.stringify(categories));
  }, [categories]);

  const [showAddCategoryModal, setShowAddCategoryModal] = useState<boolean>(false);
  const [newCatName, setNewCatName] = useState<string>('');
  const [newCatIcon, setNewCatIcon] = useState<string>('🐾');

  // 切換「支出/收入」時，自動選定對應類型的第一個分類
  const handleTypeChange = (newType: 'expense' | 'income') => {
    setType(newType);
    const firstOfSameType = categories.find(c => c.type === newType);
    if (firstOfSameType) {
      setCategory(firstOfSameType.name);
    } else {
      setCategory('');
    }
  };

  // 刪除分類的處理邏輯
  const handleDeleteCategory = (catName: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const remaining = categories.filter(c => c.name !== catName);
    setCategories(remaining);
    
    if (category === catName) {
      const firstOfSameType = remaining.find(c => c.type === type);
      if (firstOfSameType) {
        setCategory(firstOfSameType.name);
      } else {
        setCategory('');
      }
    }
  };

  // 動態獲取該分類對應的圖示 (Emoji)
  const getCategoryEmoji = (catName: string) => {
    const found = categories.find(c => c.name === catName);
    if (found) return found.icon;
    if (catName === '餐飲') return '🍖';
    if (catName === '交通') return '🚗';
    if (catName === '購物') return '🛍️';
    if (catName === '娛樂') return '✨';
    if (catName === '薪水') return '💼';
    if (catName === '獎金') return '🎁';
    if (catName === '投資') return '📈';
    return '🐾';
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const parsedAmount = parseFloat(amount);
    if (isNaN(parsedAmount) || parsedAmount <= 0) return;

    // 檢查預算超支
    if (type === 'expense') {
      const matchingBudgets = budgets.filter(b => b.category === category);
      let isOverrun = false;
      const overrunDetails: { period: string; limit: number; currentSpent: number; newTotal: number; overBy: number }[] = [];
      const now = new Date();

      for (const b of matchingBudgets) {
        let currentSpent = 0;
        if (b.period === 'monthly') {
          const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
          const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
          
          currentSpent = transactions
            .filter(t => t.type === 'expense' && t.category === category)
            .reduce((sum, t) => {
              const txDate = new Date(t.date.replace(' ', 'T'));
              if (txDate >= startOfMonth && txDate <= endOfMonth) {
                return sum + t.amount;
              }
              return sum;
            }, 0);
        } else {
          // weekly
          const currentDay = now.getDay();
          const distanceToMonday = currentDay === 0 ? 6 : currentDay - 1;
          const startOfWeek = new Date(now.getFullYear(), now.getMonth(), now.getDate() - distanceToMonday, 0, 0, 0, 0);
          const endOfWeek = new Date(startOfWeek.getTime() + 7 * 24 * 60 * 60 * 1000 - 1);
          
          currentSpent = transactions
            .filter(t => t.type === 'expense' && t.category === category)
            .reduce((sum, t) => {
              const txDate = new Date(t.date.replace(' ', 'T'));
              if (txDate >= startOfWeek && txDate <= endOfWeek) {
                return sum + t.amount;
              }
              return sum;
            }, 0);
        }

        const newTotal = currentSpent + parsedAmount;
        if (newTotal > b.amount) {
          isOverrun = true;
          overrunDetails.push({
            period: b.period === 'weekly' ? '每週' : '每月',
            limit: b.amount,
            currentSpent,
            newTotal,
            overBy: newTotal - b.amount
          });
        }
      }

      if (isOverrun) {
        setPendingTransaction({
          amount: parsedAmount,
          type,
          category,
          note: desc.trim() || undefined,
          account,
          date: customDate.replace('T', ' '),
          icon: category === '餐飲' ? 'UTENSILS' : category === '交通' ? 'CAR' : category === '購物' ? 'BAG' : 'SPARKLES'
        });
        setOverrunInfo(overrunDetails);
        setShowOverrunModal(true);
        return; // 等待 Modal 確認
      }
    }

    onAddTransaction({
      amount: parsedAmount,
      type,
      category,
      note: desc.trim() || undefined,
      account,
      date: customDate.replace('T', ' '),
      icon: category === '餐飲' ? 'UTENSILS' : category === '交通' ? 'CAR' : category === '購物' ? 'BAG' : 'SPARKLES'
    });

    setAmount('');
    setDesc('');
    setIsTimeEdited(false);
    setCustomDate(getSystemDateTimeString());
  };

  const filteredTransactions = transactions.filter((t) => {
    const matchCategory = t.category.toLowerCase().includes(searchQuery.toLowerCase());
    const matchNote = t.note ? t.note.toLowerCase().includes(searchQuery.toLowerCase()) : false;
    const matchAccount = formatAccountName(t.account).toLowerCase().includes(searchQuery.toLowerCase());
    const matchType = (t.type === 'income' ? '收入' : '支出').toLowerCase().includes(searchQuery.toLowerCase());
    const matchDate = t.date.toLowerCase().includes(searchQuery.toLowerCase());
    return matchCategory || matchNote || matchAccount || matchType || matchDate;
  });

  const sortedTransactions = [...filteredTransactions].sort((a, b) => {
    return new Date(b.date).getTime() - new Date(a.date).getTime();
  });

  const visibleCategories = categories.filter(c => c.type === type);

  return (
    <div className="flex flex-col gap-6 select-none animate-fade-in">
      {/* 總餘額卡片 */}
      <section className={`bg-white dark:bg-zinc-900 rounded-3xl p-6 shadow-md border flex flex-col items-center justify-center relative overflow-hidden ${
        theme.id === 'shiba' ? 'border-amber-900/10 shadow-amber-900/5' : 'border-emerald-900/10 shadow-emerald-900/5'
      }`}>
        <div className="absolute bottom-0 right-0 pointer-events-none select-none z-0">
          {theme.mascotAvatarType === 'image' ? (
            <img 
              src="/mix_lying.png" 
              alt="Mascot background" 
              className="w-72 h-48 object-contain opacity-45 dark:opacity-55 translate-x-6 translate-y-6" 
            />
          ) : (
            <span className="text-9xl text-stone-500/10 dark:text-zinc-500/15 leading-none select-none -mr-4 -mb-4 block">{theme.avatarEmoji}</span>
          )}
        </div>

        <span className={`text-label-md font-label-md uppercase tracking-wider mb-2 z-10 relative ${theme.styles.quotesBottom}`}>
          💰 總資產餘額
        </span>

        <div className="text-4xl font-extrabold tracking-tight text-stone-900 dark:text-zinc-100 z-10 relative">
          NT$ {balance.toLocaleString()}
        </div>

        <div className="mt-4 flex gap-2 z-10 relative">
          <span className={`inline-flex items-center gap-1 py-1.5 px-3.5 rounded-full text-label-md font-label-md ${theme.styles.primaryBg} ${theme.styles.primaryText}`}>
            <span className="w-1.5 h-1.5 bg-green-500 rounded-full animate-ping"></span>
            台灣在地化極速記帳
          </span>
          <span className={`inline-flex items-center gap-1 py-1.5 px-3.5 rounded-full text-label-md font-label-md ${theme.styles.accentBtn}`}>
            {theme.name} {theme.avatarEmoji}
          </span>
        </div>
      </section>

      {/* 記帳填寫面板 */}
      <section className={`bg-white dark:bg-zinc-900 rounded-2xl p-5 border shadow-sm flex flex-col gap-4 ${
        theme.id === 'shiba' ? 'border-amber-900/10' : 'border-emerald-900/10'
      }`}>
        
        {/* 頂部極速記帳標題與寵物精密時鐘 */}
        <div className="flex justify-between items-center">
          <h3 className={`text-headline-md font-headline-md flex items-center gap-2 ${theme.styles.primaryText}`}>
            <span>🐾</span> 極速記帳
          </h3>
          <span className={`inline-flex items-center gap-1.5 text-[10px] sm:text-xs font-bold px-3 py-1 rounded-full border ${theme.styles.clockBg}`}>
            {theme.clockPrefix}{customDate.replace('T', ' ') || '載入中...'}
          </span>
        </div>
        
        {/* 支出 / 收入 膠囊式雙向切換 Tabs */}
        <div className={`rounded-xl p-1.5 gap-1.5 shadow-xs border flex ${
          theme.id === 'shiba' 
            ? 'bg-amber-100/40 dark:bg-zinc-800/80 border-amber-900/5' 
            : 'bg-emerald-100/40 dark:bg-zinc-800/80 border-emerald-900/5'
        }`}>
          <motion.button
            whileTap={{ scale: 0.96 }}
            type="button"
            onClick={() => handleTypeChange('expense')}
            className={`flex-1 py-2.5 rounded-lg text-sm font-bold flex items-center justify-center gap-1.5 transition-all cursor-pointer ${
              type === 'expense'
                ? theme.styles.tabActive
                : theme.styles.tabInactive
            }`}
          >
            <ArrowDownRight className="w-4 h-4" /> {theme.id === 'shiba' ? '🐾 記支出' : '🐕 記支出'}
          </motion.button>
          <motion.button
            whileTap={{ scale: 0.96 }}
            type="button"
            onClick={() => handleTypeChange('income')}
            className={`flex-1 py-2.5 rounded-lg text-sm font-bold flex items-center justify-center gap-1.5 transition-all cursor-pointer ${
              type === 'income'
                ? 'bg-emerald-600 text-white shadow-sm'
                : 'text-zinc-500 hover:bg-emerald-50/10 dark:text-zinc-400'
            }`}
          >
            <ArrowUpRight className="w-4 h-4" /> {theme.id === 'shiba' ? '🦴 記收入' : '🍖 記收入'}
          </motion.button>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          {/* 金額輸入區 */}
          <div className={`rounded-xl p-4 border-2 border-transparent transition-all ${
            theme.id === 'shiba' 
              ? 'bg-amber-50/50 dark:bg-zinc-800/50 focus-within:border-amber-400 focus-within:bg-white dark:focus-within:bg-zinc-800' 
              : 'bg-emerald-50/50 dark:bg-zinc-800/50 focus-within:border-emerald-400 focus-within:bg-white dark:focus-within:bg-zinc-800'
          }`}>
            <label className={`text-label-md font-label-md block mb-1 ${theme.styles.inputLabel}`}>
              {type === 'expense' ? '支出金額 (NT$)' : '收入金額 (NT$)'}
            </label>
            <div className="flex items-center">
              <span className={`text-3xl font-bold mr-2 ${type === 'expense' ? (theme.id === 'shiba' ? 'text-amber-600' : 'text-emerald-600') : 'text-emerald-600'}`}>NT$</span>
              <input
                type="number"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="0"
                className="w-full bg-transparent border-none p-0 focus:ring-0 text-3xl font-bold text-stone-900 dark:text-zinc-100 placeholder:text-stone-300 dark:placeholder:text-zinc-700"
                required
                min="1"
              />
            </div>
          </div>

          {/* 付款方式 */}
          <div className="flex flex-col gap-2">
            <span className={`text-label-md font-label-md ${theme.styles.inputLabel}`}>
              {type === 'expense' ? '付款方式' : '存入帳戶'}
            </span>
            <div className="flex flex-wrap gap-2 items-center">
              {paymentMethods.map((pm) => (
                <motion.button
                  whileTap={{ scale: 0.95 }}
                  key={pm}
                  type="button"
                  onClick={() => setAccount(pm)}
                  className={`py-2 px-3.5 rounded-xl text-xs font-bold transition-all cursor-pointer border ${
                    account === pm
                      ? theme.id === 'shiba'
                        ? 'bg-amber-600 border-amber-600 text-white shadow-sm'
                        : 'bg-emerald-600 border-emerald-600 text-white shadow-sm'
                      : `bg-stone-55 dark:bg-zinc-800 border-stone-200 dark:border-zinc-700 text-stone-600 dark:text-zinc-400 hover:bg-stone-100 dark:hover:bg-zinc-750`
                  }`}
                >
                  {pm}
                </motion.button>
              ))}
              
              {!showAddPayment ? (
                <motion.button
                  whileTap={{ scale: 0.95 }}
                  type="button"
                  onClick={() => setShowAddPayment(true)}
                  className={`py-2 px-3.5 rounded-xl text-xs font-bold border-2 border-dashed bg-transparent cursor-pointer transition-colors ${
                    theme.id === 'shiba'
                      ? 'border-amber-300 text-amber-650 hover:border-amber-500'
                      : 'border-emerald-300 text-emerald-600 hover:border-emerald-500'
                  }`}
                >
                  ➕ 新增自訂
                </motion.button>
              ) : (
                <div className="flex items-center gap-1.5 bg-stone-50 dark:bg-zinc-800 p-1 rounded-xl border border-stone-200 dark:border-zinc-700">
                  <input
                    type="text"
                    value={newPaymentName}
                    onChange={(e) => setNewPaymentName(e.target.value)}
                    placeholder="輸入自訂名稱"
                    className="py-1 px-2 w-28 bg-transparent border-none text-xs font-bold text-stone-905 dark:text-zinc-100 placeholder:text-stone-300 focus:ring-0"
                    maxLength={10}
                    autoFocus
                  />
                  <button
                    type="button"
                    onClick={() => {
                      const name = newPaymentName.trim();
                      if (name && !paymentMethods.includes(name)) {
                        setPaymentMethods([...paymentMethods, name]);
                        setAccount(name);
                      }
                      setNewPaymentName('');
                      setShowAddPayment(false);
                    }}
                    className={`py-1 px-2.5 rounded-lg text-xs font-bold text-white shadow-sm cursor-pointer ${theme.styles.primaryBtn}`}
                  >
                    確定
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setNewPaymentName('');
                      setShowAddPayment(false);
                    }}
                    className="py-1 px-2.5 rounded-lg text-xs font-bold border border-stone-200 text-stone-605 dark:text-zinc-300 cursor-pointer"
                  >
                    取消
                  </button>
                </div>
              )}
            </div>
          </div>

          {/* 記帳時間 */}
          <div className="flex flex-col gap-2">
            <span className={`text-label-md font-label-md ${theme.styles.inputLabel}`}>
              記帳時間
            </span>
            <div className={`rounded-xl p-3 border transition-all flex items-center justify-between gap-2 ${
              theme.id === 'shiba' 
                ? 'bg-amber-50/30 dark:bg-zinc-800/30 border-amber-955/10 focus-within:border-amber-400 focus-within:bg-white dark:focus-within:bg-zinc-800' 
                : 'bg-emerald-50/30 dark:bg-zinc-800/30 border-emerald-955/10 focus-within:border-emerald-400 focus-within:bg-white dark:focus-within:bg-zinc-800'
            }`}>
              <input
                type="datetime-local"
                value={customDate}
                onChange={(e) => {
                  setCustomDate(e.target.value);
                  setIsTimeEdited(true);
                }}
                className="bg-transparent border-none p-0 focus:ring-0 text-sm text-stone-900 dark:text-zinc-100 cursor-pointer flex-1"
                required
              />
              {isTimeEdited && (
                <button
                  type="button"
                  onClick={() => {
                    setIsTimeEdited(false);
                    setCustomDate(getSystemDateTimeString());
                  }}
                  className={`text-[10px] font-bold px-2 py-1 rounded-md cursor-pointer transition-colors ${
                    theme.id === 'shiba' ? 'bg-amber-100 text-amber-800 hover:bg-amber-200' : 'bg-emerald-100 text-emerald-800 hover:bg-emerald-200'
                  }`}
                >
                  🕒 恢復當下
                </button>
              )}
            </div>
          </div>

          {/* 備註欄 (Note) */}
          <div className={`rounded-xl p-3 border transition-all flex flex-col gap-1 ${
            theme.id === 'shiba' 
              ? 'bg-amber-50/30 dark:bg-zinc-800/30 border-amber-955/10 focus-within:border-amber-400 focus-within:bg-white dark:focus-within:bg-zinc-800' 
              : 'bg-emerald-50/30 dark:bg-zinc-800/30 border-emerald-955/10 focus-within:border-emerald-400 focus-within:bg-white dark:focus-within:bg-zinc-800'
          }`}>
            <label className={`text-xs font-semibold flex items-center gap-1 ${theme.styles.inputLabel}`}>
              <MessageSquare className="w-3.5 h-3.5" /> 記帳備註 (選填)
            </label>
            <input
              type="text"
              value={desc}
              onChange={(e) => setDesc(e.target.value)}
              placeholder="輸入細節說明，例如：發票中獎、全聯採購、加班費..."
              className="w-full bg-transparent border-none p-0 focus:ring-0 text-sm text-stone-900 dark:text-zinc-100 placeholder:text-stone-300 dark:placeholder:text-zinc-600"
            />
          </div>

          {/* 分類選擇區：支援刪除（X）與自訂項目 */}
          <div>
            <label className={`text-label-md font-label-md block mb-2 ${theme.styles.inputLabel}`}>
              選擇分類
            </label>
            <div className="grid grid-cols-4 gap-2.5">
              <AnimatePresence>
                {visibleCategories.map((cat) => (
                  <motion.button
                    initial={{ opacity: 0, scale: 0.8 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.8 }}
                    whileTap={{ scale: 0.94 }}
                    key={cat.name}
                    type="button"
                    onClick={() => setCategory(cat.name)}
                    className={`py-2 px-3 rounded-full font-label-md text-label-md flex flex-col sm:flex-row items-center justify-center gap-1 transition-all border-2 relative select-none ${
                      category === cat.name
                        ? type === 'expense' 
                          ? theme.id === 'shiba' 
                            ? 'border-amber-600 bg-amber-100 dark:bg-amber-955/50 text-amber-900 dark:text-amber-100 font-bold'
                            : 'border-emerald-600 bg-emerald-50 dark:bg-emerald-955/30 text-emerald-900 dark:text-emerald-100 font-bold'
                          : 'border-emerald-600 bg-emerald-50 dark:bg-emerald-955/30 text-emerald-900 dark:text-emerald-100 font-bold'
                        : `border-transparent bg-stone-50 dark:bg-zinc-800 text-stone-600 dark:text-zinc-400 ${theme.id === 'shiba' ? 'hover:bg-amber-105/40' : 'hover:bg-emerald-100/40'}`
                    }`}
                  >
                    <span 
                      onClick={(e) => handleDeleteCategory(cat.name, e)}
                      className="absolute -top-1 -right-1 w-4 h-4 bg-red-500 hover:bg-red-600 text-white rounded-full flex items-center justify-center text-[10px] shadow-sm transition-all"
                      title="刪除此分類"
                    >
                      <X className="w-2.5 h-2.5" />
                    </span>
                    <span className="text-base">{cat.icon}</span>
                    <span className="text-xs sm:text-sm">{cat.name}</span>
                  </motion.button>
                ))}
              </AnimatePresence>

              {/* ➕ 新增自訂分類按鈕 */}
              <motion.button
                whileTap={{ scale: 0.94 }}
                type="button"
                onClick={() => setShowAddCategoryModal(true)}
                className={`py-2 px-3 rounded-full border-2 border-dashed bg-transparent font-label-md text-xs sm:text-sm flex flex-col sm:flex-row items-center justify-center gap-1 transition-all cursor-pointer ${
                  theme.id === 'shiba' 
                    ? 'border-amber-300 text-amber-600 hover:border-amber-500 hover:bg-amber-50/30' 
                    : 'border-emerald-300 text-emerald-600 hover:border-emerald-500 hover:bg-emerald-50/30'
                }`}
              >
                <span>➕</span>
                <span className="text-xs sm:text-sm font-semibold">自訂項目</span>
              </motion.button>
            </div>
          </div>

          {/* 記帳送出鍵 */}
          <motion.button
            whileTap={{ scale: 0.98 }}
            type="submit"
            className={`mt-2 w-full active:scale-[0.98] text-white font-headline-md text-headline-md py-4 rounded-xl flex items-center justify-center gap-2 shadow-lg transition-all cursor-pointer ${
              type === 'expense' 
                ? theme.styles.primaryBtn 
                : 'bg-emerald-600 hover:bg-emerald-700 shadow-emerald-900/20'
            }`}
          >
            <span>🐾</span> 存入這筆{type === 'expense' ? '支出' : '收入'} 
          </motion.button>
        </form>
      </section>

      {/* 歷史近況記帳明細 */}
      <section className={`bg-white dark:bg-zinc-900 rounded-2xl p-5 border shadow-sm flex flex-col gap-4 ${
        theme.id === 'shiba' ? 'border-amber-900/10' : 'border-emerald-900/10'
      }`}>
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <h3 className={`text-headline-md font-headline-md flex items-center gap-1.5 ${theme.styles.primaryText}`}>
              <span>📅</span> 最近記帳明細
            </h3>
            <p className={`text-[10px] mt-0.5 font-medium ${theme.styles.quotesBottom}`}>
              💡 提示：長按項目可進行修改與編輯明細汪！
            </p>
          </div>

          {/* 搜尋過濾輸入框 */}
          <div className="relative w-full sm:w-60">
            <Search className={`w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 ${theme.id === 'shiba' ? 'text-amber-900/30' : 'text-emerald-900/30'}`} />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="搜尋備註、分類、付款或收支..."
              className={`w-full pl-9 pr-4 py-1.5 rounded-full border focus:ring-0 text-xs transition-all bg-white dark:bg-zinc-800 text-stone-900 dark:text-zinc-100 ${
                theme.id === 'shiba' 
                  ? 'border-amber-955/15 focus:border-amber-400' 
                  : 'border-emerald-955/15 focus:border-emerald-400'
              }`}
            />
          </div>
        </div>

        {/* 交易清單與 Framer Motion 動態渲染 */}
        <div className="overflow-hidden">
          {sortedTransactions.length === 0 ? (
            <div className={`py-8 flex flex-col items-center justify-center ${theme.styles.quotesBottom}`}>
              <span className="text-4xl mb-2">🦴</span>
              <p className="text-sm">
                {searchQuery ? '沒有找到符合搜尋條件的記帳紀錄喔！' : theme.emptyStateMsg}
              </p>
            </div>
          ) : (
            <motion.div 
              layout
              className="flex flex-col gap-3"
            >
              <AnimatePresence initial={false}>
                {sortedTransactions.map((t) => (
                  <motion.div 
                    layout
                    initial={{ opacity: 0, y: 15 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -15 }}
                    transition={{ duration: 0.25 }}
                    key={t.id} 
                    onPointerDown={(e) => handlePointerDown(e, t)}
                    onPointerUp={handlePointerUp}
                    onPointerCancel={handlePointerCancel}
                    onPointerLeave={handlePointerCancel}
                    onPointerMove={handlePointerCancel}
                    className={`flex items-center justify-between p-3.5 rounded-xl transition-colors border select-none cursor-pointer ${
                      theme.id === 'shiba' 
                        ? 'bg-amber-50/40 dark:bg-zinc-800/40 hover:bg-amber-50 dark:hover:bg-zinc-800 border-amber-955/5' 
                        : 'bg-emerald-50/40 dark:bg-zinc-800/40 hover:bg-emerald-50 dark:hover:bg-zinc-800 border-emerald-955/5'
                    }`}
                    style={{ touchAction: 'pan-y' }}
                    title="長按項目可以編輯修改喔！"
                  >
                    <div className="flex items-center gap-3">
                      <div className={`w-10 h-10 rounded-full flex items-center justify-center font-bold text-lg ${theme.styles.primaryBg} ${theme.styles.primaryText}`}>
                        {getCategoryEmoji(t.category)}
                      </div>
                      <div>
                        <div className="flex items-center gap-2">
                          <p className="font-semibold text-stone-900 dark:text-zinc-100">{t.category}</p>
                          {t.note && (
                            <span className={`inline-flex items-center gap-0.5 text-[10px] px-2 py-0.5 rounded-md font-medium border max-w-[120px] truncate ${
                              theme.id === 'shiba' 
                                ? 'bg-amber-100/50 dark:bg-amber-955/40 text-amber-900 border-amber-200/20' 
                                : 'bg-emerald-100/50 dark:bg-emerald-955/40 text-emerald-900 border-emerald-200/20'
                            }`} title={t.note}>
                              💬 {t.note}
                            </span>
                          )}
                        </div>
                        <p className={`text-xs mt-1 ${theme.styles.quotesBottom}`}>
                          {t.type === 'income' ? '🦴 收入' : '🐾 支出'} • {formatAccountName(t.account)} • {t.date}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <div className="text-right">
                        {t.type === 'income' ? (
                          <span className="font-bold text-emerald-600 dark:text-emerald-400">
                            + NT$ {t.amount.toLocaleString()}
                          </span>
                        ) : (
                          <span className="font-bold text-red-600 dark:text-red-400">
                            - NT$ {t.amount.toLocaleString()}
                          </span>
                        )}
                      </div>
                      <button
                        onClick={() => onDeleteTransaction(t.id)}
                        className="text-stone-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-zinc-800 p-1.5 rounded-full transition-colors cursor-pointer"
                        title="刪除此記帳明細"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </motion.div>
                ))}
              </AnimatePresence>
            </motion.div>
          )}
        </div>
      </section>

      {/* 新增自訂分類的彈出視窗 */}
      {showAddCategoryModal && (
        <div className="fixed inset-0 z-55 flex items-center justify-center bg-black/40 backdrop-blur-xs select-none p-4">
          <div className={`bg-white dark:bg-zinc-900 rounded-3xl p-5 max-w-[90%] w-96 border shadow-xl relative animate-fade-in ${
            theme.id === 'shiba' ? 'border-amber-955/20' : 'border-emerald-955/20'
          }`}>
            <h3 className={`text-headline-md font-headline-md mb-3 flex items-center gap-1.5 ${theme.styles.primaryText}`}>
              <span>🐾</span> 新增自訂分類
            </h3>
            
            <div className="flex flex-col gap-4">
              <div className={`p-3.5 rounded-xl border-2 ${
                theme.id === 'shiba' ? 'bg-amber-50/60 dark:bg-zinc-800/60 border-amber-300' : 'bg-emerald-50/60 dark:bg-zinc-800/60 border-emerald-300'
              }`}>
                <label className={`text-xs font-semibold block mb-1 ${theme.styles.inputLabel}`}>
                  項目名稱
                </label>
                <input
                  type="text"
                  value={newCatName}
                  onChange={(e) => setNewCatName(e.target.value)}
                  placeholder="例如：醫療健檢、貓罐罐..."
                  className="w-full bg-transparent border-0 p-0 text-base font-bold text-stone-900 dark:text-zinc-100 focus:ring-0 placeholder:text-stone-300"
                  required
                />
              </div>

              <div>
                <label className={`text-xs font-semibold block mb-2 ${theme.styles.inputLabel}`}>
                  選擇圖示 (Emoji)
                </label>
                <div className="grid grid-cols-6 gap-2">
                  {['🐾', '🐕', '🦴', '🏠', '💊', '🎓', '👔', '🎁', '🧸', '💇', '🍕', '☕', '🛒', '🎮', '✈️', '💡', '🧼', '🍿'].map((emoji) => (
                    <button
                      key={emoji}
                      type="button"
                      onClick={() => setNewCatIcon(emoji)}
                      className={`w-10 h-10 rounded-full flex items-center justify-center text-lg transition-all border-2 ${
                        newCatIcon === emoji
                          ? theme.id === 'shiba' 
                            ? 'border-amber-600 bg-amber-100 dark:bg-amber-955/50 scale-110 font-bold'
                            : 'border-emerald-600 bg-emerald-50 dark:bg-emerald-955/50 scale-110 font-bold'
                          : 'border-transparent bg-stone-55/50 dark:bg-zinc-800 hover:bg-stone-100/40'
                      }`}
                    >
                      {emoji}
                    </button>
                  ))}
                </div>
              </div>

              <div className="flex gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => {
                    setShowAddCategoryModal(false);
                    setNewCatName('');
                  }}
                  className="flex-1 border border-stone-200 text-stone-605 dark:text-zinc-300 py-3 rounded-xl font-semibold text-sm hover:bg-stone-50 dark:hover:bg-zinc-850 transition-colors cursor-pointer"
                >
                  取消
                </button>
                <button
                  type="button"
                  onClick={() => {
                    if (!newCatName.trim()) return;
                    const colors = [
                      'bg-red-100/60 dark:bg-red-955/40 text-red-808 dark:text-red-300',
                      'bg-orange-100/60 dark:bg-orange-955/40 text-orange-808 dark:text-orange-300',
                      'bg-green-100/60 dark:bg-green-955/40 text-green-808 dark:text-green-300',
                      'bg-teal-100/60 dark:bg-teal-955/40 text-teal-808 dark:text-teal-300',
                      'bg-indigo-100/60 dark:bg-indigo-955/40 text-indigo-808 dark:text-indigo-300',
                      'bg-purple-100/60 dark:bg-purple-955/40 text-purple-808 dark:text-purple-300'
                    ];
                    const randomColor = colors[Math.floor(Math.random() * colors.length)];
                    setCategories([
                      ...categories,
                      { name: newCatName.trim(), icon: newCatIcon, color: randomColor, type }
                    ]);
                    setCategory(newCatName.trim());
                    setShowAddCategoryModal(false);
                    setNewCatName('');
                  }}
                  className={`flex-1 text-white font-bold py-3 rounded-xl text-sm shadow-md transition-all cursor-pointer ${theme.styles.primaryBtn}`}
                >
                  確認新增
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 📝 編輯記帳明細彈出視窗 */}
      <AnimatePresence>
        {editingTransaction && (
          <div className="fixed inset-0 z-55 flex items-center justify-center bg-black/40 backdrop-blur-xs select-none p-4">
            <motion.div
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.9 }}
              className={`bg-white dark:bg-zinc-900 rounded-3xl p-5 max-w-[90%] w-96 border shadow-xl relative max-h-[90vh] overflow-y-auto ${
                theme.id === 'shiba' ? 'border-amber-955/20' : 'border-emerald-955/20'
              }`}
            >
              <div className="flex justify-between items-center mb-3">
                <h3 className={`text-headline-md font-headline-md flex items-center gap-1.5 ${theme.styles.primaryText}`}>
                  <span>📝</span> 編輯記帳明細
                </h3>
                <button
                  onClick={() => setEditingTransaction(null)}
                  className={`w-8 h-8 rounded-full flex items-center justify-center transition-colors cursor-pointer ${
                    theme.id === 'shiba' ? 'bg-amber-50 text-amber-805 hover:bg-amber-100' : 'bg-emerald-50 text-emerald-800 hover:bg-emerald-100'
                  }`}
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <form onSubmit={handleEditSubmit} className="flex flex-col gap-4">
                {/* 收支類型 */}
                <div className="flex flex-col gap-2">
                  <span className={`text-xs font-semibold block ${theme.styles.inputLabel}`}>交易類型</span>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        setEditType('expense');
                        const firstExpense = categories.find(c => c.type === 'expense');
                        if (firstExpense) setEditCategory(firstExpense.name);
                      }}
                      className={`flex-1 py-2 rounded-xl text-xs font-bold text-center border transition-all cursor-pointer ${
                        editType === 'expense'
                          ? 'bg-red-500 border-red-500 text-white shadow-sm'
                          : 'border-stone-200 text-stone-600 dark:text-zinc-400 hover:bg-stone-50 dark:hover:bg-zinc-800'
                      }`}
                    >
                      🐾 支出
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setEditType('income');
                        const firstIncome = categories.find(c => c.type === 'income');
                        if (firstIncome) setEditCategory(firstIncome.name);
                      }}
                      className={`flex-1 py-2 rounded-xl text-xs font-bold text-center border transition-all cursor-pointer ${
                        editType === 'income'
                          ? 'bg-emerald-600 border-emerald-600 text-white shadow-sm'
                          : 'border-stone-200 text-stone-600 dark:text-zinc-400 hover:bg-stone-50 dark:hover:bg-zinc-800'
                      }`}
                    >
                      🦴 收入
                    </button>
                  </div>
                </div>

                {/* 交易金額 */}
                <div className={`p-3 rounded-xl border-2 ${
                  theme.id === 'shiba' ? 'bg-amber-50/60 dark:bg-zinc-800/60 border-amber-300' : 'bg-emerald-50/60 dark:bg-zinc-800/60 border-emerald-300'
                }`}>
                  <label className={`text-xs font-semibold block mb-1 ${theme.styles.inputLabel}`}>金額 (NT$)</label>
                  <input
                    type="number"
                    value={editAmount}
                    onChange={(e) => setEditAmount(e.target.value)}
                    placeholder="0"
                    className="w-full bg-transparent border-0 p-0 text-lg font-bold text-stone-900 dark:text-zinc-100 focus:ring-0"
                    required
                    min="1"
                  />
                </div>

                {/* 類別 */}
                <div className={`p-3 rounded-xl border ${
                  theme.id === 'shiba' ? 'bg-amber-50/60 dark:bg-zinc-800/60 border-amber-955/10' : 'bg-emerald-50/60 dark:bg-zinc-800/60 border-emerald-955/10'
                }`}>
                  <label className={`text-xs font-semibold block mb-1 ${theme.styles.inputLabel}`}>選擇分類</label>
                  <select
                    value={editCategory}
                    onChange={(e) => setEditCategory(e.target.value)}
                    className="w-full bg-transparent border-0 p-0 text-sm font-bold text-stone-900 dark:text-zinc-100 focus:ring-0 cursor-pointer"
                  >
                    {categories.filter(c => c.type === editType).map(c => (
                      <option key={c.name} value={c.name} className="text-stone-900 dark:text-zinc-100 bg-white dark:bg-zinc-900">
                        {c.icon} {c.name}
                      </option>
                    ))}
                  </select>
                </div>

                {/* 支付方式 */}
                <div className="flex flex-col gap-2">
                  <span className={`text-xs font-semibold block ${theme.styles.inputLabel}`}>付款方式</span>
                  <div className="flex flex-wrap gap-2">
                    {paymentMethods.map(pm => (
                      <button
                        key={pm}
                        type="button"
                        onClick={() => setEditAccount(pm)}
                        className={`py-1.5 px-3 rounded-full text-xs font-bold transition-all cursor-pointer border ${
                          editAccount === pm
                            ? theme.id === 'shiba'
                              ? 'bg-amber-600 border-amber-600 text-white shadow-xs'
                              : 'bg-emerald-600 border-emerald-600 text-white shadow-xs'
                            : `bg-stone-55 dark:bg-zinc-800/80 border-stone-200 text-stone-600 dark:text-zinc-400 hover:bg-stone-100`
                        }`}
                      >
                        {pm}
                      </button>
                    ))}
                  </div>
                </div>

                {/* 記帳時間 */}
                <div className={`p-3 rounded-xl border ${
                  theme.id === 'shiba' ? 'bg-amber-50/60 dark:bg-zinc-800/60 border-amber-955/10' : 'bg-emerald-50/60 dark:bg-zinc-800/60 border-emerald-955/10'
                }`}>
                  <label className={`text-xs font-semibold block mb-1 ${theme.styles.inputLabel}`}>記帳時間</label>
                  <input
                    type="datetime-local"
                    value={editDate}
                    onChange={(e) => setEditDate(e.target.value)}
                    className="w-full bg-transparent border-none p-0 focus:ring-0 text-sm text-stone-900 dark:text-zinc-100 cursor-pointer"
                    required
                  />
                </div>

                {/* 備註 */}
                <div className={`p-3 rounded-xl border ${
                  theme.id === 'shiba' ? 'bg-amber-50/60 dark:bg-zinc-800/60 border-amber-955/10' : 'bg-emerald-50/60 dark:bg-zinc-800/60 border-emerald-955/10'
                }`}>
                  <label className={`text-xs font-semibold block mb-1 ${theme.styles.inputLabel}`}>備註 (選填)</label>
                  <input
                    type="text"
                    value={editDesc}
                    onChange={(e) => setEditDesc(e.target.value)}
                    placeholder="輸入備註說明..."
                    className="w-full bg-transparent border-none p-0 focus:ring-0 text-sm text-stone-900 dark:text-zinc-100"
                  />
                </div>

                {/* 提交/取消 */}
                <div className="flex gap-2 pt-2">
                  <button
                    type="button"
                    onClick={() => setEditingTransaction(null)}
                    className="flex-1 border border-stone-200 text-stone-605 dark:text-zinc-300 py-3 rounded-xl font-semibold text-sm hover:bg-stone-50 dark:hover:bg-zinc-850 transition-colors cursor-pointer"
                  >
                    取消
                  </button>
                  <button
                    type="submit"
                    className={`flex-1 text-white font-bold py-3 rounded-xl text-sm shadow-md transition-all cursor-pointer ${theme.styles.primaryBtn}`}
                  >
                    確認修改
                  </button>
                </div>
              </form>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* ⚠️ 預算超支警告彈出視窗 */}
      <AnimatePresence>
        {showOverrunModal && (
          <div className="fixed inset-0 z-55 flex items-center justify-center bg-black/40 backdrop-blur-xs select-none p-4">
            <motion.div
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.9 }}
              className="bg-white dark:bg-zinc-900 rounded-3xl p-6 max-w-[90%] w-96 border shadow-2xl relative border-red-500/30 dark:border-red-500/20"
            >
              <div className="flex flex-col items-center text-center gap-3">
                <div className="w-14 h-14 rounded-full bg-red-50 dark:bg-red-955/45 text-red-500 dark:text-red-400 flex items-center justify-center text-3xl animate-bounce">
                  ⚠️
                </div>
                
                <h3 className="text-lg font-extrabold text-red-600 dark:text-red-400">
                  預算超支警告汪！
                </h3>

                <p className="text-xs text-stone-600 dark:text-zinc-350 leading-relaxed font-semibold">
                  您剛輸入的「{pendingTransaction?.category}」支出為 <strong className="text-stone-900 dark:text-zinc-100 font-bold">NT$ {pendingTransaction?.amount.toLocaleString()}</strong>，將導致以下預算超支：
                </p>

                <div className="w-full flex flex-col gap-2.5 my-1.5">
                  {overrunInfo.map((info, idx) => (
                    <div 
                      key={idx}
                      className="p-3 rounded-2xl bg-red-50/50 dark:bg-red-955/10 border border-red-200/20 text-xs text-left"
                    >
                      <div className="flex justify-between font-bold text-red-700 dark:text-red-400 mb-1">
                        <span>{info.period}預算限額:</span>
                        <span>NT$ {info.limit.toLocaleString()}</span>
                      </div>
                      <div className="flex justify-between text-stone-500 dark:text-zinc-455">
                        <span>目前累計支出:</span>
                        <span>NT$ {info.currentSpent.toLocaleString()}</span>
                      </div>
                      <div className="flex justify-between font-semibold mt-1 text-red-650 dark:text-rose-400 pt-1 border-t border-red-100/10">
                        <span>預計超支金額:</span>
                        <span>+ NT$ {info.overBy.toLocaleString()}</span>
                      </div>
                    </div>
                  ))}
                </div>

                <p className="text-xs text-stone-500 dark:text-zinc-400 font-medium">
                  請問您確認要繼續存入這筆支出嗎？
                </p>

                <div className="flex gap-2 w-full mt-2">
                  <button
                    type="button"
                    onClick={cancelAddPendingTransaction}
                    className="flex-1 border border-stone-200 text-stone-600 dark:text-zinc-300 py-3 rounded-xl font-semibold text-xs hover:bg-stone-50 dark:hover:bg-zinc-850 transition-colors cursor-pointer"
                  >
                    我再想想 (取消)
                  </button>
                  <button
                    type="button"
                    onClick={confirmAddPendingTransaction}
                    className="flex-1 bg-red-600 hover:bg-red-700 text-white font-bold py-3 rounded-xl text-xs shadow-md transition-all cursor-pointer"
                  >
                    確認存入汪！
                  </button>
                </div>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}
