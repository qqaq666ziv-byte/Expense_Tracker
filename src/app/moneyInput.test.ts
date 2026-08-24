import { describe, expect, it } from "vitest";
import { formatMoneyInput, sanitizeMoneyInput } from "./moneyInput";

describe("money input presentation", () => {
  it("turns plain digits into a grouped NT$ editing value without changing the canonical value", () => {
    expect(sanitizeMoneyInput("3307")).toBe("3307");
    expect(formatMoneyInput("3307")).toBe("3,307");
    expect(sanitizeMoneyInput("NT$ 3,307")).toBe("3307");
  });

  it("keeps optional two-decimal precision without exposing number-input syntax", () => {
    expect(sanitizeMoneyInput("3,307.5", { allowDecimal: true })).toBe(
      "3307.5",
    );
    expect(formatMoneyInput("3307.5")).toBe("3,307.5");
    expect(sanitizeMoneyInput("12e+3.456", { allowDecimal: true })).toBe(
      "123.45",
    );
  });

  it("only preserves a leading sign for fields that explicitly allow negative balances", () => {
    expect(sanitizeMoneyInput("-1200", { allowNegative: false })).toBe("1200");
    expect(sanitizeMoneyInput("-1200", { allowNegative: true })).toBe("-1200");
    expect(formatMoneyInput("-1200")).toBe("-1,200");
  });
});
