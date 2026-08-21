import { describe, expect, it } from 'vitest';
import { isBrowserSafeSupabaseKey } from './supabaseClient';

function jwt(role: string): string {
  const encode = (value: object) => btoa(JSON.stringify(value)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  return `${encode({ alg: 'HS256' })}.${encode({ role })}.signature`;
}

describe('Supabase browser configuration', () => {
  it('rejects secret and service-role credentials while accepting public formats', () => {
    expect(isBrowserSafeSupabaseKey('sb_secret_do-not-bundle')).toBe(false);
    expect(isBrowserSafeSupabaseKey(jwt('service_role'))).toBe(false);
    expect(isBrowserSafeSupabaseKey(jwt('anon'))).toBe(true);
    expect(isBrowserSafeSupabaseKey('sb_publishable_public')).toBe(true);
  });
});
