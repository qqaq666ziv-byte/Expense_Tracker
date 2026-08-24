import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type InputHTMLAttributes,
} from "react";
import { formatMoneyInput, sanitizeMoneyInput } from "../app/moneyInput";

interface MoneyInputProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "type" | "inputMode" | "pattern" | "value" | "onChange"
> {
  value: string;
  onValueChange(value: string): void;
  allowDecimal?: boolean;
  allowNegative?: boolean;
  currencyLabel?: string;
}

/**
 * A native text input tuned for mobile money entry. The integer keypad is the
 * default; uncommon decimal and negative values are explicit opt-in actions,
 * while the existing domain parser remains the final validation seam.
 */
export const MoneyInput = forwardRef<HTMLInputElement, MoneyInputProps>(
  function MoneyInput(
    {
      value,
      onValueChange,
      allowDecimal = true,
      allowNegative = false,
      currencyLabel = "NT$",
      className = "",
      "aria-label": ariaLabel,
      ...inputProps
    },
    forwardedRef,
  ) {
    const inputRef = useRef<HTMLInputElement>(null);
    useImperativeHandle(
      forwardedRef,
      () => inputRef.current as HTMLInputElement,
    );
    const [fractionMode, setFractionMode] = useState(value.includes("."));
    const signed = value.startsWith("-");
    const decimalActive = allowDecimal && (fractionMode || value.includes("."));
    const pattern = `${allowNegative ? "-?" : ""}[0-9,]*${decimalActive ? "([.][0-9]{0,2})?" : ""}`;

    const focusInput = () =>
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        const end = inputRef.current?.value.length ?? 0;
        inputRef.current?.setSelectionRange(end, end);
      });

    useEffect(() => {
      setFractionMode(value.includes("."));
    }, [value]);

    return (
      <div className={`money-input ${className}`.trim()}>
        <span className="money-input-currency" aria-hidden="true">
          {currencyLabel}
        </span>
        <input
          {...inputProps}
          ref={inputRef}
          type="text"
          inputMode={decimalActive ? "decimal" : "numeric"}
          pattern={pattern}
          autoComplete="off"
          enterKeyHint={inputProps.enterKeyHint ?? "done"}
          aria-label={ariaLabel}
          value={formatMoneyInput(value)}
          onChange={(event) =>
            onValueChange(
              sanitizeMoneyInput(event.target.value, {
                allowDecimal: decimalActive,
                allowNegative,
              }),
            )
          }
        />
        {(allowDecimal || allowNegative) && (
          <span className="money-input-tools">
            {allowDecimal && !decimalActive && (
              <button
                type="button"
                aria-label="輸入小數"
                title="需要角分時輸入小數"
                onClick={() => {
                  setFractionMode(true);
                  onValueChange(`${value || "0"}.`);
                  focusInput();
                }}
              >
                .00
              </button>
            )}
            {allowNegative && (
              <button
                type="button"
                aria-label={signed ? "切換為正數" : "切換為負數"}
                aria-pressed={signed}
                title="切換正負金額"
                onClick={() => {
                  onValueChange(signed ? value.slice(1) : `-${value || "0"}`);
                  focusInput();
                }}
              >
                ±
              </button>
            )}
          </span>
        )}
      </div>
    );
  },
);
