import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  console.warn('⚠️ 警告：缺少 VITE_SUPABASE_URL 或 VITE_SUPABASE_ANON_KEY 環境變數，請確認根目錄的 .env 設定汪！');
}

export const supabase = createClient(supabaseUrl || '', supabaseAnonKey || '');
