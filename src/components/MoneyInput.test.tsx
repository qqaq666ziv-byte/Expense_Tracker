import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MoneyInput } from "./MoneyInput";

describe("MoneyInput", () => {
  it("uses mobile integer-keyboard semantics and formats digits for reading", () => {
    const html = renderToStaticMarkup(
      <MoneyInput aria-label="金額" value="3307" onValueChange={() => {}} />,
    );

    expect(html).toContain('type="text"');
    expect(html).toContain('inputMode="numeric"');
    expect(html).toContain('pattern="[0-9,]*"');
    expect(html).toContain('value="3,307"');
    expect(html).toContain("NT$");
    expect(html).not.toContain('type="number"');
  });

  it("keeps decimal and negative entry behind explicit accessible actions", () => {
    const html = renderToStaticMarkup(
      <MoneyInput
        aria-label="實際餘額"
        value=""
        allowDecimal
        allowNegative
        onValueChange={() => {}}
      />,
    );

    expect(html).toContain('aria-label="輸入小數"');
    expect(html).toContain('aria-label="切換為負數"');
  });
});
