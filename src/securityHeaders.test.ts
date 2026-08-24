import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

interface HeaderEntry {
  key: string;
  value: string;
}

interface VercelConfig {
  headers?: Array<{
    source: string;
    headers: HeaderEntry[];
  }>;
}

describe('browser security headers', () => {
  it('protects every deployed route without blocking Supabase API or PWA workers', () => {
    const config = JSON.parse(
      readFileSync(resolve(process.cwd(), 'vercel.json'), 'utf8'),
    ) as VercelConfig;
    const allRoutes = config.headers?.find(({ source }) => source === '/(.*)');
    const headers = new Map(allRoutes?.headers.map(({ key, value }) => [key, value]));

    expect(headers.get('Content-Security-Policy')).toContain("default-src 'self'");
    expect(headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'");
    expect(headers.get('Content-Security-Policy')).toContain('https://rarkcgtgfvwymjuxgfkx.supabase.co');
    expect(headers.get('Content-Security-Policy')).toContain('wss://rarkcgtgfvwymjuxgfkx.supabase.co');
    expect(headers.get('Content-Security-Policy')).not.toContain('*.supabase.co');
    expect(headers.get('Content-Security-Policy')).not.toContain('vercel.live');
    expect(headers.get('Content-Security-Policy')).toContain("script-src 'self'");
    expect(headers.get('Content-Security-Policy')).toContain("worker-src 'self'");
    expect(headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
    expect(headers.get('Permissions-Policy')).toContain('camera=()');
    expect(headers.get('Permissions-Policy')).toContain('microphone=()');
    expect(headers.get('X-Frame-Options')).toBe('DENY');
  });
});
