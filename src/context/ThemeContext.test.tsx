import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ThemeId } from '../themeConfig';
import { ThemeProvider, useTheme } from './ThemeContext';

function ThemeProbe() {
  const { theme } = useTheme();
  return <span data-theme={theme.id}>{theme.name}</span>;
}

function ThemeSetterProbe({ capture }: { capture: (setter: (themeId: ThemeId) => void) => void }) {
  const { setTheme } = useTheme();
  capture(setTheme);
  return null;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ThemeProvider storage recovery', () => {
  it('mounts with the default theme when localStorage reading is denied', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new DOMException('Access denied', 'SecurityError');
      },
      setItem: () => undefined,
    });

    const html = renderToStaticMarkup(
      <ThemeProvider>
        <ThemeProbe />
      </ThemeProvider>,
    );

    expect(html).toContain('data-theme="shiba"');
    expect(html).toContain('柴犬風格');
  });

  it('keeps the public theme setter usable when localStorage writing is denied', () => {
    const setItem = vi.fn(() => {
      throw new DOMException('Access denied', 'SecurityError');
    });
    vi.stubGlobal('localStorage', {
      getItem: () => 'shiba',
      setItem,
    });
    let setTheme: ((themeId: ThemeId) => void) | undefined;
    renderToStaticMarkup(
      <ThemeProvider>
        <ThemeSetterProbe capture={(setter) => { setTheme = setter; }} />
      </ThemeProvider>,
    );

    expect(setTheme).toBeTypeOf('function');
    expect(() => setTheme?.('mix')).not.toThrow();
    expect(setItem).toHaveBeenCalledWith('pet-theme-id', 'mix');
  });
});
