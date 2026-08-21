import {
  Banknote,
  BadgeDollarSign,
  Bike,
  Briefcase,
  Bus,
  Car,
  Coffee,
  Gamepad2,
  Gift,
  HeartPulse,
  Home,
  Landmark,
  MoreHorizontal,
  Phone,
  PiggyBank,
  ShoppingBag,
  Sparkles,
  Smartphone,
  Tag,
  Utensils,
  WalletCards,
  type LucideIcon,
} from 'lucide-react';
import type { IconRef } from '../domain/model';

const ICONS: Record<string, LucideIcon> = {
  banknote: Banknote,
  bike: Bike,
  bus: Bus,
  car: Car,
  coffee: Coffee,
  game: Gamepad2,
  gift: Gift,
  health: HeartPulse,
  home: Home,
  bank: Landmark,
  more: MoreHorizontal,
  phone: Phone,
  savings: PiggyBank,
  shopping: ShoppingBag,
  wallet: Smartphone,
  food: Utensils,
  cards: WalletCards,
  // Legacy aliases remain renderable after migration.
  utensils: Utensils,
  'shopping-bag': ShoppingBag,
  'wallet-cards': WalletCards,
  sparkles: Sparkles,
  tag: Tag,
  'badge-dollar-sign': BadgeDollarSign,
  briefcase: Briefcase,
};

export const VECTOR_ICON_OPTIONS = [
  'banknote', 'wallet', 'cards', 'bank', 'savings', 'food', 'coffee', 'bus', 'car',
  'bike', 'shopping', 'home', 'phone', 'game', 'gift', 'health', 'more',
];

export function FinanceIcon({ icon, className = 'h-5 w-5' }: { icon: IconRef; className?: string }) {
  if (icon.type === 'emoji') return <span aria-hidden="true" className="text-xl leading-none">{icon.value}</span>;
  const Component = ICONS[icon.value] ?? MoreHorizontal;
  return <Component aria-hidden="true" className={className} />;
}

export function IconPicker({ value, onChange }: { value: IconRef; onChange(icon: IconRef): void }) {
  return (
    <div className="space-y-2">
      <div className="flex gap-2" role="group" aria-label="圖示類型">
        <button type="button" className={`chip ${value.type === 'emoji' ? 'chip-active' : ''}`} onClick={() => onChange({ type: 'emoji', value: value.type === 'emoji' ? value.value : '💰' })}>Emoji</button>
        <button type="button" className={`chip ${value.type === 'vector' ? 'chip-active' : ''}`} onClick={() => onChange({ type: 'vector', value: value.type === 'vector' ? value.value : 'wallet' })}>向量圖示</button>
      </div>
      {value.type === 'emoji' ? (
        <label className="field-label">任意 Emoji
          <input className="field mt-1" aria-label="任意 Emoji" value={value.value} maxLength={12} onChange={(event) => onChange({ type: 'emoji', value: event.target.value || '💰' })} />
        </label>
      ) : (
        <div className="grid grid-cols-9 gap-1" aria-label="向量圖示選擇">
          {VECTOR_ICON_OPTIONS.map((key) => (
            <button type="button" key={key} aria-label={`圖示 ${key}`} className={`icon-choice ${value.value === key ? 'icon-choice-active' : ''}`} onClick={() => onChange({ type: 'vector', value: key })}>
              <FinanceIcon icon={{ type: 'vector', value: key }} />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
