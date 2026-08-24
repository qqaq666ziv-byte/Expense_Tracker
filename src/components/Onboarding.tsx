import { useState } from 'react';
import { ArrowLeft, ArrowRight, BarChart3, Cloud, PieChart, WalletCards, X } from 'lucide-react';
import { BrandMark } from './BrandMark';

const STEPS = [
  { icon: WalletCards, kicker: '歡迎回家', title: '記帳，應該像回想剛剛發生的事', body: '輸入金額、選分類、選錢從哪裡進出，就完成。時間與備註需要時再補。' },
  { icon: PieChart, kicker: '錢放在哪裡', title: '資產帳戶和分類，各做一件事', body: '「街口支付」是錢的位置；「餐飲」是花錢的原因。日常使用只要照直覺選，不必背名詞。' },
  { icon: BarChart3, kicker: '看懂生活', title: '從今天花多少，一路看到長期趨勢', body: '洞察裡可以切換今日、本週、本月、本年或自訂區間，再點分類查看每一筆。' },
  { icon: Cloud, kicker: '資料安心', title: '訪客可離線，登入後可跨裝置同步', body: '沒有登入時資料只留在這台裝置；Google 登入後才會同步。正常時安靜顯示，真的需要處理才會提醒你。' },
] as const;

export function Onboarding({ onClose }: { onClose(): void }) {
  const [step, setStep] = useState(0);
  const item = STEPS[step];
  const Icon = item.icon;
  return <div className="modal-backdrop onboarding-backdrop"><section className="onboarding" role="dialog" aria-modal="true" aria-labelledby="onboarding-title"><button className="sheet-close" type="button" aria-label="跳過新手導覽" onClick={onClose}><X /></button><BrandMark className="h-14 w-14" /><div className="onboarding-art"><Icon /></div><p className="section-kicker">{item.kicker}</p><h2 id="onboarding-title">{item.title}</h2><p>{item.body}</p><div className="onboarding-dots" aria-label={`第 ${step + 1} 步，共 ${STEPS.length} 步`}>{STEPS.map((_, index) => <i className={index === step ? 'active' : ''} key={index} />)}</div><div className="onboarding-actions">{step > 0 ? <button className="secondary-button" type="button" onClick={() => setStep((value) => value - 1)}><ArrowLeft className="h-4 w-4" />上一步</button> : <button className="text-button" type="button" onClick={onClose}>先跳過</button>}<button className="primary-button" type="button" onClick={() => step === STEPS.length - 1 ? onClose() : setStep((value) => value + 1)}>{step === STEPS.length - 1 ? '開始記帳' : '下一步'}{step < STEPS.length - 1 && <ArrowRight className="h-4 w-4" />}</button></div></section></div>;
}
