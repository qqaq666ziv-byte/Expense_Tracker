import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { IconPicker } from './FinanceIcon';

describe('IconPicker Unicode emoji input', () => {
  it('keeps a long single ZWJ emoji within the user input limit', () => {
    const emoji = '🧑🏽‍❤️‍💋‍🧑🏼';

    const html = renderToStaticMarkup(
      <IconPicker value={{ type: 'emoji', value: emoji }} onChange={() => undefined} />,
    );

    expect(emoji.length).toBe(15);
    expect(html).toContain(`value="${emoji}"`);
    expect(html).toContain('maxLength="64"');
  });
});
