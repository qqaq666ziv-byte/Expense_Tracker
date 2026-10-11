// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { useState } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MoneyInput } from './MoneyInput';

afterEach(cleanup);

function ControlledMoneyInput({
  allowDecimal = true,
  allowNegative = false,
  onValueChange,
}: {
  allowDecimal?: boolean;
  allowNegative?: boolean;
  onValueChange(value: string): void;
}) {
  const [value, setValue] = useState('');
  return (
    <MoneyInput
      aria-label="金額"
      value={value}
      allowDecimal={allowDecimal}
      allowNegative={allowNegative}
      onValueChange={(next) => {
        setValue(next);
        onValueChange(next);
      }}
    />
  );
}

describe('MoneyInput entry interactions', () => {
  it('preserves decimals typed before using the decimal keyboard action', async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    render(<ControlledMoneyInput onValueChange={onValueChange} />);
    const input = screen.getByRole('textbox', { name: '金額' });

    expect(input).toHaveAttribute('inputmode', 'numeric');
    await user.type(input, '125.5');

    expect(input).toHaveValue('125.5');
    expect(onValueChange).toHaveBeenLastCalledWith('125.5');
    expect(input).toHaveAttribute('inputmode', 'decimal');
  });

  it.each([
    { pasted: '125.50', canonical: '125.50', displayed: '125.50', allowNegative: false },
    { pasted: 'NT$ 1,234.50', canonical: '1234.50', displayed: '1,234.50', allowNegative: false },
    { pasted: '-125.50', canonical: '-125.50', displayed: '-125.50', allowNegative: true },
  ])('preserves the monetary value of $pasted pasted into an empty field', async ({
    pasted, canonical, displayed, allowNegative,
  }) => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    render(<ControlledMoneyInput allowNegative={allowNegative} onValueChange={onValueChange} />);
    const input = screen.getByRole('textbox', { name: '金額' });

    await user.click(input);
    await user.paste(pasted);

    expect(input).toHaveValue(displayed);
    expect(onValueChange).toHaveBeenLastCalledWith(canonical);
    expect(input).toHaveAttribute('inputmode', 'decimal');
  });

  it('accepts a fresh decimal after clearing a previous value', async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    render(<ControlledMoneyInput onValueChange={onValueChange} />);
    const input = screen.getByRole('textbox', { name: '金額' });
    await user.type(input, '125.5');
    await user.clear(input);

    expect(input).toHaveAttribute('inputmode', 'numeric');
    await user.type(input, '0.05');

    expect(input).toHaveValue('0.05');
    expect(onValueChange).toHaveBeenLastCalledWith('0.05');
  });

  it('keeps integer-only fields numeric and supports grouped integer typing and paste', async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    render(<ControlledMoneyInput allowDecimal={false} onValueChange={onValueChange} />);
    const input = screen.getByRole('textbox', { name: '金額' });
    await user.type(input, '12550');

    expect(input).toHaveValue('12,550');
    expect(onValueChange).toHaveBeenLastCalledWith('12550');
    await user.clear(input);
    await user.paste('NT$ 3,307');

    expect(input).toHaveValue('3,307');
    expect(onValueChange).toHaveBeenLastCalledWith('3307');
    expect(input).toHaveAttribute('inputmode', 'numeric');
    expect(input).toHaveAttribute('pattern', '[0-9,]*');
    expect(screen.queryByRole('button', { name: '輸入小數' })).not.toBeInTheDocument();
  });

  it('retains the explicit decimal keyboard action', async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    render(<ControlledMoneyInput onValueChange={onValueChange} />);
    await user.click(screen.getByRole('button', { name: '輸入小數' }));
    const input = screen.getByRole('textbox', { name: '金額' });
    await user.type(input, '50');

    expect(input).toHaveValue('0.50');
    expect(onValueChange).toHaveBeenLastCalledWith('0.50');
    expect(input).toHaveAttribute('inputmode', 'decimal');
  });
});
