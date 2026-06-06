import React, { useState, useEffect } from 'react';
import { Transaction, Goal, Subscription, Budget } from './types';
import Dashboard from './components/Dashboard';
import Insights from './components/Insights';
import Savings from './components/Savings';
import BudgetPlanner from './components/BudgetPlanner'; // Wait, let's make it ./components/BudgetPlanner
import { Sun, Moon, Bell, X } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { supabase } from './lib/supabaseClient';
import { useTheme } from './context/ThemeContext';

export default function App() {
  const [activeTab, setActiveTab] = useState<'dashboard' | 'insights' | 'savings' | 'budget'>('dashboard');
  const [darkMode, setDarkMode] = useState<boolean>(false);
  const { theme, toggleTheme } = useTheme();

  // 1. 全域交易明細與儲蓄目標狀態 (快取優先：初始先從 LocalStorage 載入訪客資料)
  const [transactions, setTransactions] = useState<Transaction[]>(() => {
    try {
      const saved = localStorage.getItem('guest_transactions');
      return saved ? JSON.parse(saved) : [];
    } catch (e) {
      console.error('LocalStorage read error:', e);
      return [];
    }
  });
  const [goals, setGoals] = useState<Goal[]>(() => {
    try {
      const saved = localStorage.getItem('guest_goals');
      return saved ? JSON.parse(saved) : [];
    } catch (e) {
      console.error('LocalStorage read error:', e);
      return [];
    }
  });
  const [activeGoalId, setActiveGoalId] = useState<string>(() => {
    try {
      const saved = localStorage.getItem('guest_goals');
      if (saved) {
        const parsed = JSON.parse(saved);
        return parsed.length > 0 ? parsed[0].id : '';
      }
    } catch (e) {
      console.error('LocalStorage read error:', e);
    }
    return '';
  });

  // 2. 固定開銷定期扣款 (訂閱制服務) 狀態
  const [subscriptions, setSubscriptions] = useState<Subscription[]>(() => {
    try {
      const saved = localStorage.getItem('guest_subscriptions');
      return saved ? JSON.parse(saved) : [];
    } catch (e) {
      console.error('LocalStorage read error:', e);
      return [];
    }
  });

  // 2.5 預算控制狀態
  const [budgets, setBudgets] = useState<Budget[]>(() => {
    try {
      const saved = localStorage.getItem('guest_budgets');
      return saved ? JSON.parse(saved) : [];
    } catch (e) {
      console.error('LocalStorage read error:', e);
      return [];
    }
  });

  // 3. 系統通知與鈴鐺中心
  const [notifications, setNotifications] = useState<string[]>([]);
  const [showNotificationsModal, setShowNotificationsModal] = useState<boolean>(false);

  // 4. 自動扣款 Toast 提示狀態
  const [autoDeductionToast, setAutoDeductionToast] = useState<string | null>(null);

  // 使用者認證與載入狀態
  const [user, setUser] = useState<any>(null);
  const [authLoading, setAuthLoading] = useState<boolean>(true);

  // 雲端資料載入狀態
  const [loading, setLoading] = useState<boolean>(false);

  // 計算衍生狀態：存錢筒總額與資產餘額
  const vaultTotal = goals.reduce((sum, g) => sum + g.currentAmount, 0);
  const totalIncome = transactions.filter(t => t.type === 'income').reduce((sum, t) => sum + t.amount, 0);
  const totalExpense = transactions.filter(t => t.type === 'expense').reduce((sum, t) => sum + t.amount, 0);
  const balance = totalIncome - totalExpense - vaultTotal;

  // 從 Supabase 載入使用者資料
  const fetchCloudData = async (userId: string) => {
    setLoading(true);
    try {
      // 1. 獲取交易明細
      const { data: dbTransactions, error: txError } = await supabase
        .from('transactions')
        .select('*')
        .eq('user_id', userId)
        .order('date', { ascending: false });

      if (txError) throw txError;

      // 2. 獲取存錢目標
      const { data: dbGoals, error: goalError } = await supabase
        .from('goals')
        .select('*')
        .eq('user_id', userId);

      if (goalError) throw goalError;

      // 3. 獲取固定開銷
      const { data: dbSubs, error: subError } = await supabase
        .from('subscriptions')
        .select('*')
        .eq('user_id', userId);

      if (subError) throw subError;

      // 4. 獲取預算控制
      const { data: dbBudgets, error: budgetError } = await supabase
        .from('budgets')
        .select('*')
        .eq('user_id', userId);

      if (budgetError) throw budgetError;

      // 資料轉換與映射
      const loadedTx: Transaction[] = (dbTransactions || []).map((t: any) => ({
        id: t.id,
        amount: Number(t.amount),
        type: t.type as 'income' | 'expense',
        category: t.category,
        note: t.note || undefined,
        date: t.date,
        account: t.account,
        icon: t.icon,
        synced: true // 標記為已同步
      }));

      const loadedGoals: Goal[] = (dbGoals || []).map((g: any) => ({
        id: g.id,
        name: g.name,
        targetAmount: Number(g.target_amount),
        currentAmount: Number(g.current_amount),
        unit: g.unit,
        targetDate: g.target_date || undefined
      }));

      const loadedSubs: Subscription[] = (dbSubs || []).map((s: any) => ({
        id: s.id,
        name: s.name,
        amount: Number(s.amount),
        category: s.category,
        account: s.account,
        recurringDate: Number(s.recurring_date)
      }));

      const loadedBudgets: Budget[] = (dbBudgets || []).map((b: any) => ({
        id: b.id,
        category: b.category,
        period: b.period as 'weekly' | 'monthly',
        amount: Number(b.amount)
      }));

      // 離線聯集合併：以本機快取交易為基礎，合併並對齊雲端交易，防止本機資料被覆蓋抹除
      setTransactions(prev => {
        const merged = [...prev];
        loadedTx.forEach(lt => {
          const existsIdx = merged.findIndex(t => t.id === lt.id);
          if (existsIdx > -1) {
            merged[existsIdx] = { ...lt, synced: true };
          } else {
            merged.push({ ...lt, synced: true });
          }
        });
        const sorted = merged.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
        
        // 同步更新本機帳號快取
        localStorage.setItem(`user_transactions_${userId}`, JSON.stringify(sorted));
        return sorted;
      });
      
      setGoals(loadedGoals);
      setSubscriptions(loadedSubs);
      setBudgets(loadedBudgets);

      // 同步更新本機已登入使用者的緩存
      localStorage.setItem(`user_goals_${userId}`, JSON.stringify(loadedGoals));
      localStorage.setItem(`user_subscriptions_${userId}`, JSON.stringify(loadedSubs));
      localStorage.setItem(`user_budgets_${userId}`, JSON.stringify(loadedBudgets));

      if (loadedGoals.length > 0) {
        setActiveGoalId(prev => loadedGoals.some(g => g.id === prev) ? prev : loadedGoals[0].id);
      } else {
        setActiveGoalId('');
      }
    } catch (err: any) {
      console.error('❌ 從 Supabase 載入資料失敗：', err.message);
    } finally {
      setLoading(false);
    }
  };

  // 監聽 Auth 狀態改變
  useEffect(() => {
    // 獲取當前登入使用者
    supabase.auth.getSession().then(({ data: { session } }) => {
      setUser(session?.user ?? null);
      setAuthLoading(false);
    });

    // 監聽 Auth 狀態
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null);
      setAuthLoading(false);
    });

    return () => {
      subscription.unsubscribe();
    };
  }, []);

  // 檢測當前瀏覽器或 Android WebView 是否正確開啟 DOM Storage (LocalStorage)
  useEffect(() => {
    try {
      localStorage.setItem('__test_storage__', '1');
      localStorage.removeItem('__test_storage__');
    } catch (e: any) {
      alert("🐾 提醒：偵測到您的裝置或瀏覽器限制了本機儲存 (DOM Storage/LocalStorage) 權限汪！\n這會導致離線快取與本地儲存功能失效。\n\n💡 解決方案：如果您是在自製的 Android App (WebView 殼) 中開啟，請務必在 Java/Kotlin 代碼中加入 `webSettings.setDomStorageEnabled(true);` 啟用儲存權限喔！🐾");
    }
  }, []);

  // 當 user 登入狀態變更時，優先加載本機該帳號快取，隨後於背景同步雲端
  useEffect(() => {
    try {
      if (user) {
        // 1. 優先從 LocalStorage 載入該使用者的快取資料，達成零延遲瞬間渲染
        const cachedTx = localStorage.getItem(`user_transactions_${user.id}`);
        const cachedGoals = localStorage.getItem(`user_goals_${user.id}`);
        const cachedSubs = localStorage.getItem(`user_subscriptions_${user.id}`);
        const cachedBudgets = localStorage.getItem(`user_budgets_${user.id}`);

        if (cachedTx) setTransactions(JSON.parse(cachedTx));
        if (cachedGoals) {
          const parsedGoals = JSON.parse(cachedGoals);
          setGoals(parsedGoals);
          if (parsedGoals.length > 0) {
            setActiveGoalId(prev => parsedGoals.some((g: any) => g.id === prev) ? prev : parsedGoals[0].id);
          }
        }
        if (cachedSubs) setSubscriptions(JSON.parse(cachedSubs));
        if (cachedBudgets) setBudgets(JSON.parse(cachedBudgets));

        // 2. 背景拉取雲端資料進行最終對齊與覆蓋
        fetchCloudData(user.id);
      } else {
        // 訪客模式下，載入訪客的 LocalStorage
        const savedTx = localStorage.getItem('guest_transactions');
        const savedGoals = localStorage.getItem('guest_goals');
        const savedSubs = localStorage.getItem('guest_subscriptions');
        const savedBudgets = localStorage.getItem('guest_budgets');

        setTransactions(savedTx ? JSON.parse(savedTx) : []);
        if (savedGoals) {
          const parsedGoals = JSON.parse(savedGoals);
          setGoals(parsedGoals);
          if (parsedGoals.length > 0) {
            setActiveGoalId(parsedGoals[0].id);
          } else {
            setActiveGoalId('');
          }
        } else {
          setGoals([]);
          setActiveGoalId('');
        }
        setSubscriptions(savedSubs ? JSON.parse(savedSubs) : []);
        setBudgets(savedBudgets ? JSON.parse(savedBudgets) : []);
      }
    } catch (e) {
      console.error('Failed to switch user storage caches:', e);
    }
  }, [user]);

  // 隨時將最新狀態保存到本機 LocalStorage 中（支援訪客與已登入使用者）
  useEffect(() => {
    try {
      if (user) {
        localStorage.setItem(`user_transactions_${user.id}`, JSON.stringify(transactions));
      } else {
        localStorage.setItem('guest_transactions', JSON.stringify(transactions));
      }
    } catch (e) {
      console.error('LocalStorage write failed:', e);
    }
  }, [transactions, user]);

  useEffect(() => {
    try {
      if (user) {
        localStorage.setItem(`user_goals_${user.id}`, JSON.stringify(goals));
      } else {
        localStorage.setItem('guest_goals', JSON.stringify(goals));
      }
    } catch (e) {
      console.error('LocalStorage write failed:', e);
    }
  }, [goals, user]);

  useEffect(() => {
    try {
      if (user) {
        localStorage.setItem(`user_subscriptions_${user.id}`, JSON.stringify(subscriptions));
      } else {
        localStorage.setItem('guest_subscriptions', JSON.stringify(subscriptions));
      }
    } catch (e) {
      console.error('LocalStorage write failed:', e);
    }
  }, [subscriptions, user]);

  useEffect(() => {
    try {
      if (user) {
        localStorage.setItem(`user_budgets_${user.id}`, JSON.stringify(budgets));
      } else {
        localStorage.setItem('guest_budgets', JSON.stringify(budgets));
      }
    } catch (e) {
      console.error('LocalStorage write failed:', e);
    }
  }, [budgets, user]);

  const handleLogin = async () => {
    try {
      const { error } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: {
          redirectTo: window.location.origin
        }
      });
      if (error) throw error;
    } catch (err: any) {
      console.error('❌ Google 登入錯誤：', err.message);
      alert(`登入失敗汪：${err.message}`);
    }
  };

  const handleLogout = async () => {
    try {
      const { error } = await supabase.auth.signOut();
      if (error) throw error;
      alert('🐾 登出成功汪！');
    } catch (err: any) {
      console.error('❌ 登出錯誤：', err.message);
      alert(`登出失敗汪：${err.message}`);
    }
  };

  // 刪除儲蓄目標
  const handleDeleteGoal = async (id: string) => {
    const remaining = goals.filter(g => g.id !== id);
    setGoals(remaining);
    if (remaining.length > 0) {
      if (activeGoalId === id) {
        setActiveGoalId(remaining[0].id);
      }
    } else {
      setActiveGoalId('');
    }

    if (user) {
      try {
        const { error } = await supabase
          .from('goals')
          .delete()
          .eq('id', id)
          .eq('user_id', user.id);
        if (error) throw error;
      } catch (err: any) {
        console.error('❌ 刪除儲蓄目標失敗：', err.message);
      }
    }
  };

  // 啟動時自動對賬與每月固定開銷自動扣款機制
  useEffect(() => {
    if (loading || !user) {
      if (loading) return;
    }

    const now = new Date();
    const currentYear = now.getFullYear();
    const currentMonth = String(now.getMonth() + 1).padStart(2, '0');
    const currentDay = now.getDate();

    let deductedCount = 0;
    const newTransactions: Transaction[] = [];

    subscriptions.forEach((sub) => {
      // 取得當前月份的最大天數
      const lastDayOfMonth = new Date(currentYear, now.getMonth() + 1, 0).getDate();
      const actualBillingDay = Math.min(sub.recurringDate, lastDayOfMonth);

      if (currentDay >= actualBillingDay) {
        const searchNote = `🔄 自動扣款: ${sub.name}`;
        
        // 檢查歷史交易明細中，當月份是否已經扣款過
        const alreadyDeducted = transactions.some((t) => {
          return t.note === searchNote && t.date.startsWith(`${currentYear}-${currentMonth}`);
        });

        if (!alreadyDeducted) {
          const billingDateStr = `${currentYear}-${currentMonth}-${String(actualBillingDay).padStart(2, '0')} 09:00`;
          const autoTx: Transaction = {
            id: `tx-auto-${sub.id}-${currentYear}-${currentMonth}`,
            amount: sub.amount,
            type: 'expense',
            category: sub.category,
            note: searchNote,
            date: billingDateStr,
            account: sub.account,
            icon: 'SPARKLES'
          };

          newTransactions.push(autoTx);
          deductedCount++;
        }
      }
    });

    if (deductedCount > 0) {
      setTransactions((prev) => [...newTransactions, ...prev]);
      setAutoDeductionToast(`🐾 ${theme.dogName}幫您自動扣款了 ${deductedCount} 筆固定開銷汪！`);

      if (user) {
        const insertAutoTx = async () => {
          try {
            const dbInserts = newTransactions.map(tx => ({
              id: tx.id,
              user_id: user.id,
              amount: tx.amount,
              type: tx.type,
              category: tx.category,
              note: tx.note || null,
              date: tx.date,
              account: tx.account,
              icon: tx.icon
            }));
            const { error } = await supabase.from('transactions').insert(dbInserts);
            if (error) throw error;
          } catch (err: any) {
            console.error('❌ 自動扣款寫入 Supabase 失敗：', err.message);
          }
        };
        insertAutoTx();
      }
    }
  }, [subscriptions, loading, user]);

  // 動態掃描過濾快到期或已過期未達成的存錢目標，以及短月份自動扣款日期調整通知
  useEffect(() => {
    const list: string[] = [];
    const todayStr = new Date().toISOString().split('T')[0];
    const today = new Date(todayStr);

    // 1. 儲蓄目標通知
    goals.forEach(g => {
      if (g.targetDate) {
        const target = new Date(g.targetDate);
        const diffTime = target.getTime() - today.getTime();
        const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
        
        if (g.currentAmount < g.targetAmount) {
          if (diffDays >= 0 && diffDays <= 3) {
            list.push(`🦴 提醒：您的儲蓄目標「${g.name}」即將於 ${g.targetDate} 到期（剩餘 ${diffDays} 天），目前完成度 ${Math.round((g.currentAmount / g.targetAmount) * 100)}%，快投餵骨頭給${theme.dogName}吧！🐾`);
          } else if (diffDays < 0) {
            list.push(`⚠️ 警示：您的儲蓄目標「${g.name}」已於 ${g.targetDate} 截止，目前金額 NT$ ${g.currentAmount} / ${g.targetAmount}，尚未達成目標，${theme.dogName}正等著您繼續加油喔！😢`);
          }
        }
      }
    });

    // 2. 短月份扣款調整通知
    const now = new Date();
    const currentYear = now.getFullYear();
    const currentMonth = String(now.getMonth() + 1).padStart(2, '0');
    const currentDay = now.getDate();
    const lastDayOfMonth = new Date(currentYear, now.getMonth() + 1, 0).getDate();

    subscriptions.forEach(sub => {
      if (sub.recurringDate > lastDayOfMonth) {
        // 如果扣款日大於當月最大天數，且目前已達或已過當月的實際扣款日（即最後一天）
        if (currentDay >= lastDayOfMonth) {
          list.push(`📅 通知：每月固定開銷「${sub.name}」原定於每月 ${sub.recurringDate} 號扣款，因當月（${currentYear}-${currentMonth}）天數不足，已自動調整於當月最後一天（${lastDayOfMonth} 號）進行扣款汪！`);
        }
      }
    });

    setNotifications(list);
  }, [goals, subscriptions, theme.dogName]);

  // 新增交易
  const handleAddTransaction = async (newTx: Omit<Transaction, 'id'>) => {
    const createdTx: Transaction = {
      ...newTx,
      id: `tx-${Date.now()}`,
      synced: false // 預設為未同步
    };

    setTransactions(prev => [createdTx, ...prev]);

    if (user) {
      try {
        const { error } = await supabase.from('transactions').insert({
          id: createdTx.id,
          user_id: user.id,
          amount: createdTx.amount,
          type: createdTx.type,
          category: createdTx.category,
          note: createdTx.note || null,
          date: createdTx.date,
          account: createdTx.account,
          icon: createdTx.icon
        });
        if (error) throw error;
        // 雲端同步成功後將其狀態改為已同步
        setTransactions(prev => prev.map(t => t.id === createdTx.id ? { ...t, synced: true } : t));
      } catch (err: any) {
        console.error('❌ 新增交易至 Supabase 失敗：', err.message);
        // 主動提示使用者雲端備份失敗原因，但交易依然留存於本機 LocalStorage 中
        alert(`⚠️ 雲端備份失敗汪！交易已安全暫存於您的本機裝置，原因：${err.message || err}\n您可以稍後重新載入或檢查資料庫 RLS 權限喔！`);
      }
    } else {
      // 訪客模式直接設為 synced: true
      setTransactions(prev => prev.map(t => t.id === createdTx.id ? { ...t, synced: true } : t));
    }
  };

  // 刪除交易
  const handleDeleteTransaction = async (id: string) => {
    setTransactions(prev => prev.filter(t => t.id !== id));

    if (user) {
      try {
        const { error } = await supabase
          .from('transactions')
          .delete()
          .eq('id', id)
          .eq('user_id', user.id);
        if (error) throw error;
      } catch (err: any) {
        console.error('❌ 刪除交易失敗：', err.message);
        alert(`⚠️ 雲端刪除同步失敗汪！原因：${err.message || err}`);
      }
    }
  };

  // 更新交易
  const handleUpdateTransaction = async (id: string, updatedFields: Omit<Transaction, 'id'>) => {
    setTransactions(prev => prev.map(t => {
      if (t.id === id) {
        return { ...updatedFields, id, synced: false };
      }
      return t;
    }));

    if (user) {
      try {
        const { error } = await supabase
          .from('transactions')
          .update({
            amount: updatedFields.amount,
            type: updatedFields.type,
            category: updatedFields.category,
            note: updatedFields.note || null,
            date: updatedFields.date,
            account: updatedFields.account,
            icon: updatedFields.icon
          })
          .eq('id', id)
          .eq('user_id', user.id);
        if (error) throw error;
        // 更新成功後，把 synced 改回 true
        setTransactions(prev => prev.map(t => t.id === id ? { ...t, synced: true } : t));
      } catch (err: any) {
        console.error('❌ 更新交易失敗：', err.message);
        alert(`⚠️ 雲端更新同步失敗汪！修改已安全暫存於您的本機裝置，原因：${err.message || err}`);
      }
    } else {
      // 訪客模式直接設為 synced: true
      setTransactions(prev => prev.map(t => t.id === id ? { ...t, synced: true } : t));
    }
  };

  // 數位存錢筒存款 (同步累計至當前選定目標)
  const handleAddSaving = async (amount: number) => {
    const activeGoal = goals.find(g => g.id === activeGoalId) || goals[0];
    if (!activeGoal) return;

    const newAmount = activeGoal.currentAmount + amount;

    setGoals(prevGoals => prevGoals.map(g => {
      if (g.id === activeGoal.id) {
        return { ...g, currentAmount: newAmount };
      }
      return g;
    }));

    if (user) {
      try {
        const { error } = await supabase
          .from('goals')
          .update({ current_amount: newAmount })
          .eq('id', activeGoal.id)
          .eq('user_id', user.id);
        if (error) throw error;
      } catch (err: any) {
        console.error('❌ 更新儲蓄金額至 Supabase 失敗：', err.message);
      }
    }
  };

  // 新增自訂儲蓄目標
  const handleAddGoal = async (newGoal: Omit<Goal, 'id' | 'currentAmount'>) => {
    const createdGoal: Goal = {
      ...newGoal,
      id: `goal-${Date.now()}`,
      currentAmount: 0
    };

    setGoals(prev => {
      const updated = [...prev, createdGoal];
      if (updated.length === 1) {
        setActiveGoalId(createdGoal.id);
      }
      return updated;
    });

    if (user) {
      try {
        const { error } = await supabase.from('goals').insert({
          id: createdGoal.id,
          user_id: user.id,
          name: createdGoal.name,
          target_amount: createdGoal.targetAmount,
          current_amount: createdGoal.currentAmount,
          unit: createdGoal.unit,
          target_date: createdGoal.targetDate || null
        });
        if (error) throw error;
      } catch (err: any) {
        console.error('❌ 新增儲蓄目標至 Supabase 失敗：', err.message);
      }
    }
  };

  // 新增定期開銷
  const handleAddSubscription = async (newSub: Omit<Subscription, 'id'>) => {
    const createdSub: Subscription = {
      ...newSub,
      id: `sub-${Date.now()}`
    };

    setSubscriptions(prev => [...prev, createdSub]);

    if (user) {
      try {
        const { error } = await supabase.from('subscriptions').insert({
          id: createdSub.id,
          user_id: user.id,
          name: createdSub.name,
          amount: createdSub.amount,
          category: createdSub.category,
          account: createdSub.account,
          recurring_date: createdSub.recurringDate
        });
        if (error) throw error;
      } catch (err: any) {
        console.error('❌ 新增定期開銷至 Supabase 失敗：', err.message);
      }
    }
  };

  // 刪除定期開銷
  const handleDeleteSubscription = async (id: string) => {
    setSubscriptions(prev => prev.filter(sub => sub.id !== id));

    if (user) {
      try {
        const { error } = await supabase
          .from('subscriptions')
          .delete()
          .eq('id', id)
          .eq('user_id', user.id);
        if (error) throw error;
      } catch (err: any) {
        console.error('❌ 刪除定期開銷失敗：', err.message);
      }
    }
  };

  // 新增預算額度
  const handleAddBudget = async (newBudget: Omit<Budget, 'id'>) => {
    const createdBudget: Budget = {
      ...newBudget,
      id: `budget-${Date.now()}`
    };

    setBudgets(prev => [...prev, createdBudget]);

    if (user) {
      try {
        const { error } = await supabase.from('budgets').insert({
          id: createdBudget.id,
          user_id: user.id,
          category: createdBudget.category,
          period: createdBudget.period,
          amount: createdBudget.amount
        });
        if (error) throw error;
      } catch (err: any) {
        console.error('❌ 新增預算至 Supabase 失敗：', err.message);
      }
    }
  };

  // 刪除預算額度
  const handleDeleteBudget = async (id: string) => {
    setBudgets(prev => prev.filter(b => b.id !== id));

    if (user) {
      try {
        const { error } = await supabase
          .from('budgets')
          .delete()
          .eq('id', id)
          .eq('user_id', user.id);
        if (error) throw error;
      } catch (err: any) {
        console.error('❌ 刪除預算失敗：', err.message);
      }
    }
  };

  // 同步暗色模式至 localStorage 與 document Element
  useEffect(() => {
    const savedDark = localStorage.getItem('dark-mode') === 'true';
    setDarkMode(savedDark);
    if (savedDark) {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  }, []);

  const toggleDarkMode = () => {
    setDarkMode(prev => {
      const next = !prev;
      localStorage.setItem('dark-mode', String(next));
      if (next) {
        document.documentElement.classList.add('dark');
      } else {
        document.documentElement.classList.remove('dark');
      }
      return next;
    });
  };

  if (authLoading) {
    return (
      <div className={`min-h-screen pb-24 flex flex-col items-center justify-center transition-colors duration-300 ${
        darkMode ? 'bg-zinc-950 text-zinc-100' : (theme.id === 'shiba' ? 'bg-orange-50/20 text-amber-955' : 'bg-stone-50/20 text-stone-900')
      }`}>
        <div className="flex flex-col items-center justify-center gap-4 text-center select-none">
          <span className="text-6xl animate-bounce">🍖</span>
          <h2 className="text-xl font-bold">確認登入狀態中汪...</h2>
          <p className="text-xs text-stone-500">正在準備您的精美記帳本🐾</p>
        </div>
      </div>
    );
  }

  return (
    <div className={`min-h-screen pb-24 flex justify-center transition-colors duration-300 relative ${darkMode ? 'dark' : ''} ${
      darkMode ? 'bg-zinc-950 text-zinc-100' : (theme.id === 'shiba' ? 'bg-orange-50/20 text-amber-955' : 'bg-stone-50/20 text-stone-900')
    }`}>
      {/* 行動端限制容器 */}
      <div className={`w-full max-w-[600px] flex flex-col md:border-x bg-orange-50/10 dark:bg-zinc-900/40 relative shadow-xl ${
        theme.id === 'shiba' ? 'md:border-amber-900/10' : 'md:border-emerald-900/10'
      }`}>
        
        {/* 頂部 AppBar */}
        <header className={`bg-white/80 dark:bg-zinc-900/90 backdrop-blur-md shadow-xs flex justify-between items-center w-full px-5 py-3.5 z-40 sticky top-0 border-b transition-colors ${
          theme.id === 'shiba' ? 'border-amber-900/10' : 'border-emerald-900/10'
        }`}>
          <div className="flex items-center gap-3">
            <div className={`w-10 h-10 rounded-full border-2 overflow-hidden flex items-center justify-center font-bold text-xl shadow-inner select-none ${
              theme.id === 'shiba' ? 'border-amber-400 bg-amber-100 dark:bg-amber-955' : 'border-emerald-400 bg-emerald-100 dark:bg-emerald-955'
            }`}>
              {theme.id === 'shiba' ? '🐕' : '🐾'}
            </div>
            <h1 className={`text-xl font-bold tracking-tight ${theme.styles.primaryText}`}>
              {theme.welcomeTitle}
            </h1>
          </div>

          <div className="flex items-center gap-1.5">
            {/* Google 登入/登出區域 */}
            {!user ? (
              <motion.button 
                whileTap={{ scale: 0.94 }}
                onClick={handleLogin}
                className={`px-3 py-1.5 text-white text-[11px] sm:text-xs font-bold rounded-full flex items-center gap-1 shadow-sm transition-all cursor-pointer ${theme.styles.primaryBtn}`}
                title="Google 登入"
              >
                🐾 Google 登入
              </motion.button>
            ) : (
              <div className="flex items-center gap-2">
                {user.user_metadata?.avatar_url ? (
                  <img 
                    src={user.user_metadata.avatar_url} 
                    alt="Google 使用者頭像" 
                    className={`w-7 h-7 rounded-full border object-cover shadow-sm select-none ${
                      theme.id === 'shiba' ? 'border-amber-400' : 'border-emerald-400'
                    }`}
                    referrerPolicy="no-referrer"
                  />
                ) : (
                  <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold font-mono select-none ${
                    theme.id === 'shiba' ? 'bg-amber-200 dark:bg-amber-900 text-amber-800' : 'bg-emerald-200 dark:bg-emerald-900 text-emerald-805'
                  }`}>
                    {user.email?.charAt(0).toUpperCase() || 'U'}
                  </div>
                )}
                <span className="hidden sm:inline text-xs font-bold text-stone-700 dark:text-zinc-300 max-w-[80px] truncate select-none">
                  {user.user_metadata?.full_name || '已登入'}
                </span>
                <motion.button 
                  whileTap={{ scale: 0.94 }}
                  onClick={handleLogout}
                  className="px-2.5 py-1 bg-stone-200 hover:bg-stone-300 dark:bg-zinc-800 dark:hover:bg-zinc-700 text-stone-700 dark:text-zinc-350 text-[10px] sm:text-xs font-bold rounded-lg shadow-sm transition-all cursor-pointer border border-stone-300 dark:border-zinc-700"
                  title="登出系統"
                >
                  登出
                </motion.button>
              </div>
            )}

            {/* 寵物風格切換按鈕 */}
            <motion.button
              whileTap={{ scale: 0.94 }}
              onClick={toggleTheme}
              className={`w-10 h-10 flex items-center justify-center rounded-full transition-colors cursor-pointer ${theme.styles.primaryText} ${
                theme.id === 'shiba' ? 'hover:bg-amber-100/50 dark:hover:bg-zinc-800' : 'hover:bg-emerald-100/50 dark:hover:bg-zinc-800'
              }`}
              title={`切換為${theme.id === 'shiba' ? '米克斯' : '柴犬'}風格`}
            >
              <span className="text-xl">{theme.id === 'shiba' ? '🐾' : '🐕'}</span>
            </motion.button>

            {/* 深色模式變更 */}
            <motion.button 
              whileTap={{ scale: 0.94 }}
              onClick={toggleDarkMode}
              className={`w-10 h-10 flex items-center justify-center rounded-full transition-colors cursor-pointer ${theme.styles.primaryText} ${
                theme.id === 'shiba' ? 'hover:bg-amber-100/50 dark:hover:bg-zinc-800' : 'hover:bg-emerald-100/50 dark:hover:bg-zinc-800'
              }`}
              title="切換日夜主題"
            >
              {darkMode ? <Sun className="w-5 h-5 animate-spin-slow" /> : <Moon className="w-5 h-5" />}
            </motion.button>

            {/* 通知中心鈴鐺按鈕 */}
            <motion.button 
              whileTap={{ scale: 0.94 }}
              onClick={() => setShowNotificationsModal(true)}
              className={`w-10 h-10 flex items-center justify-center rounded-full transition-colors relative cursor-pointer ${theme.styles.primaryText} ${
                theme.id === 'shiba' ? 'hover:bg-amber-100/50 dark:hover:bg-zinc-800' : 'hover:bg-emerald-100/50 dark:hover:bg-zinc-800'
              }`}
            >
              <Bell className="w-5 h-5" />
              {notifications.length > 0 && (
                <span className="absolute top-2 right-2 w-2.5 h-2.5 bg-red-500 rounded-full border border-white animate-pulse"></span>
              )}
            </motion.button>
          </div>
        </header>

        {/* 內容渲染主視窗 */}
        <main className="flex-1 flex flex-col px-5 py-6 gap-6 overflow-y-auto">
          <AnimatePresence mode="wait">
            <motion.div
              key={activeTab}
              initial={{ opacity: 0, y: 15 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -15 }}
              transition={{ duration: 0.22, ease: 'easeInOut' }}
              className="flex-1 flex flex-col"
            >
              {activeTab === 'dashboard' && (
                <Dashboard 
                  balance={balance} 
                  transactions={transactions} 
                  onAddTransaction={handleAddTransaction} 
                  onDeleteTransaction={handleDeleteTransaction}
                  onUpdateTransaction={handleUpdateTransaction}
                  budgets={budgets}
                />
              )}

              {activeTab === 'insights' && (
                <Insights 
                  transactions={transactions} 
                />
              )}

              {activeTab === 'savings' && (
                <Savings 
                  vaultTotal={vaultTotal} 
                  onAddSaving={handleAddSaving} 
                  goals={goals}
                  activeGoalId={activeGoalId}
                  onSelectGoal={setActiveGoalId}
                  onAddGoal={handleAddGoal}
                  onDeleteGoal={handleDeleteGoal}
                  subscriptions={subscriptions}
                  onAddSubscription={handleAddSubscription}
                  onDeleteSubscription={handleDeleteSubscription}
                />
              )}

              {activeTab === 'budget' && (
                <BudgetPlanner 
                  transactions={transactions}
                  budgets={budgets}
                  onAddBudget={handleAddBudget}
                  onDeleteBudget={handleDeleteBudget}
                />
              )}
            </motion.div>
          </AnimatePresence>
        </main>

        {/* 底部導覽列 */}
        <nav className={`backdrop-blur-md border-t fixed bottom-0 left-1/2 -translate-x-1/2 w-full max-w-[600px] z-40 flex justify-around items-center px-4 pb-5 pt-2 rounded-t-2xl transition-all ${
          theme.id === 'shiba' 
            ? 'bg-white/95 dark:bg-zinc-900/95 border-amber-900/10 shadow-[0_-4px_20px_0_rgba(138,81,0,0.08)]' 
            : 'bg-white/95 dark:bg-zinc-900/95 border-emerald-900/10 shadow-[0_-4px_20px_0_rgba(0,138,81,0.08)]'
        }`}>
          <button 
            onClick={() => setActiveTab('dashboard')}
            className={`flex flex-col items-center justify-center py-2 px-5 rounded-2xl transition-all cursor-pointer ${
              activeTab === 'dashboard' 
                ? theme.styles.navActive 
                : 'text-zinc-500 ' + (theme.id === 'shiba' ? 'hover:text-amber-700 dark:hover:text-amber-305' : 'hover:text-emerald-700 dark:hover:text-emerald-305')
            }`}
          >
            <span className="text-xl">🐾</span>
            <span className="text-xs mt-1">極速記帳</span>
          </button>

          <button 
            onClick={() => setActiveTab('insights')}
            className={`flex flex-col items-center justify-center py-2 px-5 rounded-2xl transition-all cursor-pointer ${
              activeTab === 'insights' 
                ? theme.styles.navActive 
                : 'text-zinc-500 ' + (theme.id === 'shiba' ? 'hover:text-amber-700 dark:hover:text-amber-305' : 'hover:text-emerald-700 dark:hover:text-emerald-305')
            }`}
          >
            <span className="text-xl">📊</span>
            <span className="text-xs mt-1">財務分析</span>
          </button>

          <button 
            onClick={() => setActiveTab('savings')}
            className={`flex flex-col items-center justify-center py-2 px-5 rounded-2xl transition-all cursor-pointer ${
              activeTab === 'savings' 
                ? theme.styles.navActive 
                : 'text-zinc-500 ' + (theme.id === 'shiba' ? 'hover:text-amber-700 dark:hover:text-amber-305' : 'hover:text-emerald-700 dark:hover:text-emerald-355')
            }`}
          >
            <span className="text-xl">{theme.id === 'shiba' ? '🦴' : '🍖'}</span>
            <span className="text-xs mt-1">{theme.dogName}存錢筒</span>
          </button>

          <button 
            onClick={() => setActiveTab('budget')}
            className={`flex flex-col items-center justify-center py-2 px-5 rounded-2xl transition-all cursor-pointer ${
              activeTab === 'budget' 
                ? theme.styles.navActive 
                : 'text-zinc-500 ' + (theme.id === 'shiba' ? 'hover:text-amber-700 dark:hover:text-amber-305' : 'hover:text-emerald-700 dark:hover:text-emerald-355')
            }`}
          >
            <span className="text-xl">📅</span>
            <span className="text-xs mt-1">預算控制</span>
          </button>
        </nav>

        {/* 自動扣款成功 Toast 提示框 */}
        <AnimatePresence>
          {autoDeductionToast && (
            <motion.div 
              initial={{ opacity: 0, y: 50, scale: 0.9 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 50, scale: 0.9 }}
              className="fixed bottom-24 right-5 left-5 sm:left-auto sm:w-80 z-50 bg-indigo-600 text-white rounded-3xl p-4 shadow-2xl flex items-center justify-between border-2 border-indigo-400"
            >
              <div className="flex items-center gap-2.5">
                <span className="text-2xl animate-spin-slow">🔄</span>
                <div>
                  <h4 className="text-xs font-extrabold uppercase tracking-widest text-indigo-200">
                    固定定期開銷扣費
                  </h4>
                  <p className="text-xs font-bold mt-0.5 leading-relaxed text-white">
                    {autoDeductionToast}
                  </p>
                </div>
              </div>
              <button 
                onClick={() => setAutoDeductionToast(null)}
                className="text-white/80 hover:text-white ml-2 text-sm font-bold bg-white/10 hover:bg-white/20 rounded-full w-6 h-6 flex items-center justify-center cursor-pointer transition-colors"
              >
                ×
              </button>
            </motion.div>
          )}
        </AnimatePresence>

        {/* 🔔 通知中心彈出視窗 */}
        <AnimatePresence>
          {showNotificationsModal && (
            <div className="fixed inset-0 z-55 flex items-center justify-center bg-black/40 backdrop-blur-xs select-none p-4">
              <div className={`bg-white dark:bg-zinc-900 rounded-3xl p-5 max-w-[90%] w-96 border shadow-xl relative animate-fade-in ${
                theme.id === 'shiba' ? 'border-amber-955/20' : 'border-emerald-955/20'
              }`}>
                <div className="flex justify-between items-center mb-3">
                  <h3 className={`text-lg font-bold flex items-center gap-1.5 ${theme.styles.primaryText}`}>
                    <span>🔔</span> {theme.dogName}通知中心
                  </h3>
                  <button 
                    onClick={() => setShowNotificationsModal(false)}
                    className={`w-8 h-8 rounded-full dark:bg-zinc-800 dark:text-zinc-300 flex items-center justify-center transition-colors cursor-pointer ${
                      theme.id === 'shiba' ? 'bg-amber-50 text-amber-805 hover:bg-amber-100' : 'bg-emerald-50 text-emerald-800 hover:bg-emerald-100'
                    }`}
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>

                <div className="flex flex-col gap-3.5 max-h-60 overflow-y-auto pr-1">
                  {notifications.length === 0 ? (
                    <div className="py-8 flex flex-col items-center justify-center text-center">
                      <span className="text-4xl mb-2">🐾</span>
                      <p className={`text-xs font-bold ${theme.styles.quotesBottom}`}>
                        目前沒有新通知汪！
                      </p>
                    </div>
                  ) : (
                    notifications.map((notif, idx) => (
                      <div 
                        key={idx} 
                        className={`p-3 rounded-2xl border text-xs font-semibold leading-relaxed ${
                          theme.id === 'shiba' 
                            ? 'bg-amber-50/50 dark:bg-zinc-800/50 border-amber-955/5 text-amber-955 dark:text-zinc-300' 
                            : 'bg-emerald-50/50 dark:bg-zinc-800/50 border-emerald-955/5 text-emerald-955 dark:text-zinc-300'
                        }`}
                      >
                        {notif}
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
          )}
        </AnimatePresence>

      </div>
    </div>
  );
}
