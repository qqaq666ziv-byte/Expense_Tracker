export interface MoneyInputOptions {
  allowDecimal?: boolean;
  allowNegative?: boolean;
}

/**
 * Converts pasted or typed presentation text into the canonical string passed
 * to the existing safe-money parser. It deliberately ignores number-input
 * syntax such as e and +, keeps at most one decimal point and two decimal
 * places, and never performs floating-point arithmetic.
 */
export function sanitizeMoneyInput(
  value: string,
  options: MoneyInputOptions = {},
): string {
  const negative = options.allowNegative && value.trimStart().startsWith("-");
  let whole = "";
  let fraction = "";
  let afterDecimal = false;

  for (const character of value) {
    if (/\d/.test(character)) {
      if (afterDecimal) {
        if (fraction.length < 2) fraction += character;
      } else {
        whole += character;
      }
      continue;
    }
    if (character === "." && options.allowDecimal && !afterDecimal) {
      afterDecimal = true;
    }
  }

  const unsigned = `${whole}${afterDecimal ? `.${fraction}` : ""}`;
  return negative && unsigned && unsigned !== "0" ? `-${unsigned}` : unsigned;
}

/** Add grouping while preserving an unfinished sign, decimal point or zeroes. */
export function formatMoneyInput(value: string): string {
  if (!value) return "";
  const negative = value.startsWith("-");
  const unsigned = negative ? value.slice(1) : value;
  const [whole = "", fraction] = unsigned.split(".");
  const grouped = whole
    ? whole.replace(/^0+(?=\d)/, "").replace(/\B(?=(\d{3})+(?!\d))/g, ",")
    : "";
  return `${negative ? "-" : ""}${grouped}${fraction !== undefined ? `.${fraction}` : ""}`;
}
