import React, { useEffect, useRef, useState } from 'react';
import { Transaction } from '../types';
import Chart from 'chart.js/auto';
import { TrendingUp, AlertCircle, ArrowUpRight, ArrowDownRight } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { useTheme } from '../context/ThemeContext';

interface InsightsProps {
  transactions: Transaction[];
}

export default function Insights({ transactions }: InsightsProps) {
  const { theme } = useTheme();
  const [timeRange, setTimeRange] = useState<'week' | 'month' | 'year' | 'custom'>('month');
  const [startDate, setStartDate] = useState<string>('');
  const [endDate, setEndDate] = useState<string>('');
  
  // 圖表異常與防白畫面崩潰狀態
  const [chartError, setChartError] = useState<boolean>(false);

  const pieCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const lineCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const pieChartInstance = useRef<Chart | null>(null);
  const lineChartInstance = useRef<Chart | null>(null);

  // 自訂時間區段動態篩選交易紀錄的計算邏輯
  const getFilteredTransactions = () => {
    const today = new Date();
    today.setHours(23, 59, 59, 999);

    return transactions.filter(t => {
      const txDate = new Date(t.date);
      if (timeRange === 'week') {
        const diffTime = today.getTime() - txDate.getTime();
        const diffDays = diffTime / (1000 * 60 * 60 * 24);
        return diffDays >= 0 && diffDays <= 7;
      }
      if (timeRange === 'month') {
        const diffTime = today.getTime() - txDate.getTime();
        const diffDays = diffTime / (1000 * 60 * 60 * 24);
        return diffDays >= 0 && diffDays <= 30;
      }
      if (timeRange === 'year') {
        const diffTime = today.getTime() - txDate.getTime();
        const diffDays = diffTime / (1000 * 60 * 60 * 24);
        return diffDays >= 0 && diffDays <= 365;
      }
      if (timeRange === 'custom') {
        if (startDate && endDate) {
          return t.date >= startDate && t.date <= endDate;
        } else if (startDate) {
          return t.date >= startDate;
        } else if (endDate) {
          return t.date <= endDate;
        }
      }
      return true;
    });
  };

  const filteredTxs = getFilteredTransactions();

  // 計算篩選後區間內的總支出與總收入
  const totalSpent = filteredTxs.reduce((acc, current) => {
    return current.type === 'expense' ? acc + current.amount : acc;
  }, 0);

  const totalIncome = filteredTxs.reduce((acc, current) => {
    return current.type === 'income' ? acc + current.amount : acc;
  }, 0);

  // 寵物新窩基金變數
  const dogHouseGoal = 5000;
  const dogHouseCurrent = 3750;
  const dogHousePercent = Math.round((dogHouseCurrent / dogHouseGoal) * 100);

  // 圖表渲染 useEffect (加上防崩潰 try-catch 機制)
  useEffect(() => {
    setChartError(false);

    // 聚合支出分類金額 (只統計支出)
    const categoryTotals: { [key: string]: number } = {};
    filteredTxs.forEach(t => {
      if (t.type === 'expense') {
        categoryTotals[t.category] = (categoryTotals[t.category] || 0) + t.amount;
      }
    });

    const categories = Object.keys(categoryTotals);
    const amounts = Object.values(categoryTotals);
    
    const chartLabels = categories.length > 0 ? categories : [`無消費支出 ${theme.id === 'shiba' ? '🦴' : '🍖'}`];
    const chartAmounts = amounts.length > 0 ? amounts : [1];

    const colors = theme.id === 'shiba' ? [
      '#8a5100', // Toasted Caramel
      '#e69a44', // Golden Cookie
      '#ffb068', // Roasted Toast
      '#cdc6b8', // Toasted Sesame
      '#635e53', // Toasted Charcoal
      '#e11d48', // Crimson Red
      '#0d9488'  // Teal Green
    ] : [
      '#059669', // Emerald
      '#10b981', // Emerald Medium
      '#34d399', // Emerald Light
      '#6ee7b7', // Mint
      '#a7f3d0', // Pale Mint
      '#e11d48', // Crimson Red
      '#8a5100'  // Caramel
    ];

    // 依日期聚合每日支出
    const dailyTotals: { [key: string]: number } = {};
    filteredTxs.forEach(t => {
      if (t.type === 'expense') {
        dailyTotals[t.date.split(' ')[0]] = (dailyTotals[t.date.split(' ')[0]] || 0) + t.amount;
      }
    });

    const sortedDates = Object.keys(dailyTotals).sort();
    const lineLabels = sortedDates.length > 0 ? sortedDates : ['週一', '週二', '週三', '週四', '週五', '週六', '週日'];
    const lineData = sortedDates.length > 0 ? sortedDates.map(d => dailyTotals[d]) : [0, 0, 0, 0, 0, 0, 0];

    try {
      // 1. 初始化圓餅圖
      if (pieCanvasRef.current) {
        if (pieChartInstance.current) {
          pieChartInstance.current.destroy();
        }

        pieChartInstance.current = new Chart(pieCanvasRef.current, {
          type: 'doughnut',
          data: {
            labels: chartLabels,
            datasets: [{
              data: chartAmounts,
              backgroundColor: colors.slice(0, chartLabels.length),
              borderWidth: 2,
              borderColor: '#ffffff',
              hoverOffset: 4
            }]
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
              legend: {
                position: 'bottom',
                labels: {
                  font: {
                    family: 'Quicksand, sans-serif',
                    size: 13,
                    weight: 'bold'
                  },
                  padding: 15
                }
              }
            }
          }
        });
      }

      // 2. 初始化折線趨勢圖
      if (lineCanvasRef.current) {
        if (lineChartInstance.current) {
          lineChartInstance.current.destroy();
        }

        lineChartInstance.current = new Chart(lineCanvasRef.current, {
          type: 'line',
          data: {
            labels: lineLabels,
            datasets: [{
              label: '每日支出趨勢 (NT$)',
              data: lineData,
              borderColor: theme.id === 'shiba' ? '#8a5100' : '#059669',
              backgroundColor: theme.id === 'shiba' ? 'rgba(230, 154, 68, 0.15)' : 'rgba(52, 211, 153, 0.15)',
              fill: true,
              tension: 0.4,
              borderWidth: 3,
              pointBackgroundColor: theme.id === 'shiba' ? '#8a5100' : '#059669',
              pointRadius: 4
            }]
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
              legend: {
                display: false
              }
            },
            scales: {
              y: {
                beginAtZero: true,
                grid: {
                  color: 'rgba(0, 0, 0, 0.05)'
                },
                ticks: {
                  font: {
                    family: 'Quicksand'
                  }
                }
              },
              x: {
                grid: {
                  display: false
                },
                ticks: {
                  font: {
                    family: 'Quicksand'
                  }
                }
              }
            }
          }
        });
      }
    } catch (error) {
      console.error('Failed to create Chart.js graphs dynamically:', error);
      setChartError(true);
    }

    return () => {
      if (pieChartInstance.current) pieChartInstance.current.destroy();
      if (lineChartInstance.current) lineChartInstance.current.destroy();
    };
  }, [filteredTxs, chartError, theme.id]);

  return (
    <div className="flex flex-col gap-6 animate-fade-in">
      {/* 頁面標題 */}
      <div className="flex flex-col gap-1">
        <h1 className={`text-3xl font-extrabold tracking-tight ${theme.styles.primaryText}`}>
          📊 財務分析
        </h1>
        <p className={`text-body-md ${theme.id === 'shiba' ? 'text-amber-900/60 dark:text-zinc-400' : 'text-emerald-900/60 dark:text-zinc-400'}`}>
          看看那些辛苦賺來的罐罐與肉乾都花到哪去囉！
        </p>

        {/* 時間範圍切換項 */}
        <div className={`rounded-2xl p-1.5 mt-2 w-full shadow-xs border flex ${
          theme.id === 'shiba' ? 'bg-amber-105/50 border-amber-955/5 dark:bg-zinc-800' : 'bg-emerald-100/50 border-emerald-955/5 dark:bg-zinc-800'
        }`}>
          {['week', 'month', 'year', 'custom'].map((range) => (
            <motion.button 
              whileTap={{ scale: 0.96 }}
              key={range}
              type="button"
              onClick={() => setTimeRange(range as any)}
              className={`flex-1 font-bold text-xs sm:text-sm py-2.5 rounded-xl text-center transition-all cursor-pointer ${
                timeRange === range 
                  ? theme.styles.tabActive 
                  : theme.styles.tabInactive
              }`}
            >
              {range === 'week' ? '本週' : range === 'month' ? '本月' : range === 'year' ? '年度' : '📅 自訂區間'}
            </motion.button>
          ))}
        </div>

        {/* 自訂日期區段 DatePickers */}
        <AnimatePresence>
          {timeRange === 'custom' && (
            <motion.div 
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.25 }}
              className={`overflow-hidden mt-3 border rounded-2xl p-4 flex flex-col sm:flex-row gap-3 items-center justify-between ${
                theme.id === 'shiba' ? 'bg-amber-50/50 dark:bg-zinc-900 border-amber-900/10' : 'bg-emerald-50/50 dark:bg-zinc-900 border-emerald-900/10'
              }`}
            >
              <div className="flex items-center gap-2 w-full sm:w-auto">
                <span className={`text-xs font-bold whitespace-nowrap ${theme.styles.inputLabel}`}>起始：</span>
                <input
                  type="date"
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                  className="w-full sm:w-40 bg-white dark:bg-zinc-800 text-xs font-bold p-2.5 rounded-xl border border-stone-200 text-stone-800 dark:text-zinc-200"
                />
              </div>
              <div className="flex items-center gap-2 w-full sm:w-auto">
                <span className={`text-xs font-bold whitespace-nowrap ${theme.styles.inputLabel}`}>結束：</span>
                <input
                  type="date"
                  value={endDate}
                  onChange={(e) => setEndDate(e.target.value)}
                  className="w-full sm:w-40 bg-white dark:bg-zinc-800 text-xs font-bold p-2.5 rounded-xl border border-stone-200 text-stone-800 dark:text-zinc-200"
                />
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* 雙總計統計卡牌 */}
      <div className="grid grid-cols-2 gap-4">
        {/* 總支出 */}
        <div className={`bg-white dark:bg-zinc-900 border rounded-2xl p-5 shadow-sm flex flex-col justify-center relative overflow-hidden ${
          theme.id === 'shiba' ? 'border-amber-955/10' : 'border-emerald-955/10'
        }`}>
          <span className="text-[10px] font-bold text-red-600/70 uppercase tracking-widest mb-1 flex items-center gap-1">
            <ArrowDownRight className="w-3.5 h-3.5" /> 區間總支出
          </span>
          <span className="text-xl sm:text-2xl font-extrabold text-red-600 dark:text-red-400">
            NT$ {totalSpent.toLocaleString()}
          </span>
        </div>

        {/* 總收入 */}
        <div className={`bg-white dark:bg-zinc-900 border rounded-2xl p-5 shadow-sm flex flex-col justify-center relative overflow-hidden ${
          theme.id === 'shiba' ? 'border-amber-955/10' : 'border-emerald-955/10'
        }`}>
          <span className="text-[10px] font-bold text-emerald-600/70 uppercase tracking-widest mb-1 flex items-center gap-1">
            <ArrowUpRight className="w-3.5 h-3.5" /> 區間總收入
          </span>
          <span className="text-xl sm:text-2xl font-extrabold text-emerald-600 dark:text-emerald-450">
            NT$ {totalIncome.toLocaleString()}
          </span>
        </div>
      </div>

      {/* 雙圖表展示 */}
      <div className="grid grid-cols-1 gap-6">
        {chartError ? (
          <div className={`bg-white dark:bg-zinc-900 border-2 border-dashed rounded-3xl p-8 text-center flex flex-col items-center justify-center ${
            theme.id === 'shiba' ? 'border-amber-205 text-amber-900/60 dark:text-zinc-400' : 'border-emerald-205 text-emerald-905/60 dark:text-zinc-400'
          }`}>
            <span className="text-4xl mb-2 animate-pulse">🐾</span>
            <h4 className={`font-bold text-base ${theme.styles.primaryText}`}>
              {theme.dogName}正在尋找圖表資料...（圖表載入失敗）
            </h4>
            <p className="text-xs text-zinc-500 mt-1 max-w-xs leading-relaxed">
              請確認目前已有足夠的記帳紀錄，且您的瀏覽器已支援 HTML5 Canvas 圖表繪製汪！
            </p>
          </div>
        ) : (
          <>
            {/* 1. 圓餅分析圖 */}
            <div className={`bg-white dark:bg-zinc-900 rounded-2xl p-5 border shadow-sm flex flex-col ${
              theme.id === 'shiba' ? 'border-amber-955/10' : 'border-emerald-955/10'
            }`}>
              <h3 className={`text-headline-md font-headline-md mb-4 flex items-center gap-1.5 ${theme.styles.primaryText}`}>
                <span>🍕</span> 支出分類占比
              </h3>
              <div className="h-60 relative w-full flex items-center justify-center">
                <canvas ref={pieCanvasRef}></canvas>
              </div>
              <div className={`text-center text-xs mt-2 flex items-center justify-center gap-1 ${theme.styles.quotesBottom}`}>
                <AlertCircle className="w-3.5 h-3.5" />
                點擊下方色塊分類，可動態篩選隱藏單項數據
              </div>
            </div>

            {/* 2. 折線趨勢圖 */}
            <div className={`bg-white dark:bg-zinc-900 rounded-2xl p-5 border shadow-sm flex flex-col ${
              theme.id === 'shiba' ? 'border-amber-955/10' : 'border-emerald-955/10'
            }`}>
              <h3 className={`text-headline-md font-headline-md mb-4 flex items-center gap-1.5 ${theme.styles.primaryText}`}>
                <span>📈</span> 每日消費趨勢起伏 (NT$)
              </h3>
              <div className="h-60 relative w-full flex items-center justify-center">
                <canvas ref={lineCanvasRef}></canvas>
              </div>
            </div>
          </>
        )}
      </div>

      {/* 寵物新窩基金進度 */}
      <div className={`rounded-2xl p-5 shadow-sm flex flex-col gap-4 border ${
        theme.id === 'shiba' ? 'bg-amber-50/50 border-amber-200/30' : 'bg-emerald-50/50 border-emerald-200/30'
      }`}>
        <div>
          <h3 className={`text-headline-md font-headline-md flex items-center gap-2 ${theme.styles.primaryText}`}>
            <span>🏠</span> {theme.dogName}新窩購置準備基金進度
          </h3>
          <p className={`text-sm mt-1 ${theme.id === 'shiba' ? 'text-amber-900/60 dark:text-zinc-400' : 'text-emerald-900/60 dark:text-zinc-400'}`}>
            為了讓{theme.dogName}每天有舒服的懶骨頭，一起來完成這個成就吧！
          </p>
        </div>

        <div className="w-full relative mt-4">
          <div className={`h-4 rounded-full overflow-hidden shadow-inner border ${
            theme.id === 'shiba' ? 'bg-amber-100 dark:bg-zinc-850 border-amber-200/20' : 'bg-emerald-100 dark:bg-zinc-850 border-emerald-200/20'
          }`}>
            <div 
              className={`h-full rounded-full transition-all duration-700 bg-gradient-to-r ${theme.styles.progressBar}`}
              style={{ width: `${dogHousePercent}%` }}
            ></div>
          </div>
          <div 
            className={`absolute -top-6 rounded-full border-2 bg-white dark:bg-zinc-800 p-1 text-center flex items-center justify-center shadow-lg transition-all duration-700 ${
              theme.id === 'shiba' ? 'border-amber-400' : 'border-emerald-400'
            }`}
            style={{ left: `calc(${dogHousePercent}% - 14px)` }}
          >
            <span className="text-xs">{theme.id === 'shiba' ? '🦴' : '🍖'}</span>
          </div>

          <div className={`flex justify-between mt-2 text-label-md font-label-md ${theme.styles.inputLabel}`}>
            <span>目前: NT$ {dogHouseCurrent.toLocaleString()} ({dogHousePercent}%)</span>
            <span>目標: NT$ {dogHouseGoal.toLocaleString()}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
