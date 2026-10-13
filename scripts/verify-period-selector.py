"""Local-only UI smoke. Requires Python Playwright and a running Vite dev server.

No app dependencies, credentials or real financial data are used. Example:
  VITE_SUPABASE_URL= VITE_SUPABASE_ANON_KEY= npm run dev
  python scripts/verify-period-selector.py
"""

import argparse
from datetime import datetime
from pathlib import Path
import re
from urllib.parse import urlparse
from zoneinfo import ZoneInfo

from playwright.sync_api import expect, sync_playwright


SEED = """async () => {
  const { createInitialState, storageKey } = await import('/src/app/state.ts');
  const state = createInitialState('guest');
  const data = state.data;
  const account = data.accounts[0];
  data.accounts.push({ ...account, id: 'synthetic-bank', name: '銀行', sortOrder: 1 });
  const food = data.categories.find(item => item.kind === 'expense');
  const income = data.categories.find(item => item.kind === 'income');
  const stamp = { ownerId: 'guest', version: 1,
    updatedAt: '2026-10-13T04:00:00.000Z', lastOperationId: 'synthetic-ui' };
  data.transactions = [
    ['2024-01-31 23:59:59.999', 31, '上月資料'],
    ['2024-02-01 00:00', 29, '月初餐費'],
    ['2024-02-29 23:59:59.999', 261, '閏日餐費'],
    ['2024-03-01 00:00', 999, '月外資料'],
    ['2024-12-29 23:59:59.999', 21, '週外資料'],
    ['2024-12-30 00:00', 70, '週一餐費'],
    ['2025-01-05 23:59:59.999', 140, '週日餐費'],
    ['2025-01-06 00:00', 500, '次週餐費'],
    ['2026-10-13 12:00', 13, '今日餐費'],
  ].map(([occurredAt, amount, note], index) => ({
    ...stamp, id: `synthetic-ui-${index}`, occurredAt, amount, note, type: 'expense',
    categoryId: food.id, categoryName: food.name, accountId: account.id, accountName: account.name,
  }));
  data.transactions.push({ ...stamp, id: 'synthetic-ui-income', type: 'income', amount: 1000,
    categoryId: income.id, categoryName: income.name, accountId: account.id, accountName: account.name,
    occurredAt: '2024-02-29 12:00', note: '合成收入' });
  data.transfers = [{ ...stamp, id: 'synthetic-ui-fee', amount: 1000, fee: 15,
    sourceAccountId: account.id, sourceAccountName: account.name,
    destinationAccountId: 'synthetic-bank', destinationAccountName: '銀行', occurredAt: '2025-01-05 20:00' }];
  data.budgets = [{ ...stamp, id: 'synthetic-ui-budget', scope: 'overall',
    period: 'monthly', amount: 1000, isActive: true }];
  localStorage.setItem(storageKey('guest'), JSON.stringify(state));
  localStorage.setItem('shiba-finance:onboarding:v1', 'synthetic-ui-completed');
  localStorage.setItem('shiba-finance:context-hint:v1:insights', 'dismissed');
  return { foodName: food.name, data: JSON.stringify(data) };
}"""


def verify(page, screenshot_dir, capture):
    page.get_by_role('button', name='洞察', exact=True).click()
    summary = page.get_by_role('region', name='這段時間的收支')
    expense = summary.locator('.insight-metric.expense strong')
    month = page.get_by_label('選擇月份', exact=True)
    expect(month).to_have_value('2026-10')
    month.fill('2024-02')
    expect(summary).to_contain_text('2024/2/1 — 2024/2/29')
    expect(expense).to_have_text('NT$290')
    expect(summary.locator('.insight-metric').nth(3).locator('strong')).to_have_text('NT$10')
    expect(summary.locator('.insight-metric.income strong')).to_have_text('NT$1,000')
    expect(summary.locator('.metric-delta').first).to_contain_text('259')
    expect(page.get_by_role('region', name='我今天花了多少？').locator('.today-answer strong')).to_have_text('NT$13')
    expect(page.get_by_role('region', name='預算進度')).to_contain_text('已用 NT$13')
    trend = page.get_by_role('img', name='支出趨勢折線圖')
    expect(trend.locator('circle')).to_have_count(2)
    expect(trend).to_contain_text('2024-02-29：NT$261')
    if capture:
        page.evaluate('window.scrollTo(0, 0)')
        page.screenshot(path=str(screenshot_dir / 'select-month-iphone.png'), full_page=True)

    page.get_by_role('button', name='週', exact=True).click()
    week = page.get_by_label('選擇週內日期')
    week.fill('2025-01-05')
    expect(page.locator('#selected-period-range')).to_have_text('2024/12/30 — 2025/1/5週一至週日')
    expect(expense).to_have_text('NT$225')
    expect(trend.locator('circle')).to_have_count(2)
    expect(trend).to_contain_text('2025-01-05：NT$155')
    if capture:
        page.evaluate('window.scrollTo(0, 0)')
        page.screenshot(path=str(screenshot_dir / 'select-week-iphone.png'), full_page=True)
    page.get_by_role('button', name=re.compile('手續費')).click()
    expect(page.get_by_role('heading', name='手續費明細')).to_be_visible()
    expect(page.locator('.drilldown article')).to_contain_text('轉帳手續費：現金 → 銀行')
    page.get_by_role('button', name='下一週', exact=True).click()
    expect(week).to_have_value('2025-01-06')
    expect(expense).to_have_text('NT$500')
    expect(page.get_by_role('heading', name='手續費明細')).to_have_count(0)
    page.get_by_role('button', name='上一週', exact=True).click()
    expect(expense).to_have_text('NT$225')
    week.fill('2025-04-01')
    expect(expense).to_have_text('NT$0')
    expect(page.get_by_text('這段時間沒有支出', exact=True)).to_be_visible()
    expect(page.get_by_text('還沒有趨勢資料', exact=True)).to_be_visible()
    # Midnight DST transition in Santiago still accepts Sunday as an anchor.
    week.fill('2026-09-06')
    expect(page.locator('#selected-period-range')).to_contain_text('2026/8/31 — 2026/9/6')
    week.fill('2025-04-01')
    for _ in range(3):
        page.get_by_role('button', name='月', exact=True).click()
        expect(month).to_have_value('2024-02')
        page.get_by_role('button', name='週', exact=True).click()
        expect(week).to_have_value('2025-04-01')
    week.fill('')
    expect(page.get_by_role('alert')).to_contain_text('請選擇有效的週內日期')
    expect(page.get_by_role('button', name='下一週', exact=True)).to_be_disabled()
    page.get_by_role('button', name='回本週', exact=True).click()
    expect(page.locator('#selected-period-range')).to_contain_text('2026/10/12 — 2026/10/18')
    page.get_by_role('button', name='月', exact=True).click()
    page.get_by_role('button', name='下一月', exact=True).click()
    expect(month).to_have_value('2024-03')
    page.get_by_role('button', name='上一月', exact=True).click()
    expect(month).to_have_value('2024-02')
    month.fill('')
    expect(page.get_by_role('alert')).to_contain_text('請選擇有效的月份')
    page.get_by_role('button', name='回本月', exact=True).click()
    expect(month).to_have_value('2026-10')

    # Native input, arrows and reset remain within the viewport and >=44px tall.
    page.locator('.calendar-period-picker').scroll_into_view_if_needed()
    dimensions = page.locator('.calendar-period-picker').evaluate("""el => ({
      viewport: innerWidth, page: document.documentElement.scrollWidth,
      controls: [...el.querySelectorAll('button, input')].map(x => {
        const r = x.getBoundingClientRect();
        return { left: r.left, right: r.right, width: r.width, height: r.height };
      })
    })""")
    assert dimensions['page'] <= dimensions['viewport'], dimensions
    for control in dimensions['controls']:
        assert control['height'] >= 44 and control['width'] >= 44, control
        assert control['left'] >= 0 and control['right'] <= dimensions['viewport'], control

    # Existing day/year/custom flows and ledger link continue to operate.
    page.get_by_role('button', name='今日', exact=True).click()
    expect(expense).to_have_text('NT$13')
    page.get_by_role('button', name='本年', exact=True).click()
    expect(summary).to_contain_text('2026/1/1 — 2026/12/31')
    page.get_by_role('button', name='自訂', exact=True).click()
    page.get_by_label('自訂開始日').fill('2024-12-30')
    page.get_by_label('自訂結束日').fill('2025-01-05')
    expect(expense).to_have_text('NT$225')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--url', default='http://127.0.0.1:8888')
    parser.add_argument('--browser', choices=['chromium', 'webkit'], default='chromium')
    parser.add_argument('--chromium-path', default='/usr/bin/chromium')
    parser.add_argument('--screenshots', default='docs/screenshots')
    args = parser.parse_args()
    parsed = urlparse(args.url)
    if parsed.scheme != 'http' or parsed.hostname not in ('127.0.0.1', 'localhost'):
        raise ValueError('Use a local HTTP dev server; this smoke must not touch production.')
    screenshots = Path(args.screenshots)
    screenshots.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        launch_options = {'headless': True}
        if args.browser == 'chromium':
            launch_options['executable_path'] = args.chromium_path
        browser = getattr(p, args.browser).launch(**launch_options)
        for width, height in [(390, 844), (375, 667), (320, 568), (1280, 900)]:
            for tz in ['Asia/Taipei', 'America/Los_Angeles', 'UTC', 'America/Santiago']:
                context = browser.new_context(viewport={'width': width, 'height': height},
                    is_mobile=width < 600, has_touch=width < 600, timezone_id=tz)
                # Abort every non-local request, even if a future app change adds one.
                external = []
                def route_local(route):
                    if urlparse(route.request.url).netloc != parsed.netloc:
                        external.append(route.request.url)
                        route.abort()
                    else:
                        route.continue_()
                context.route('**/*', route_local)
                page = context.new_page()
                page.add_init_script("""localStorage.setItem('shiba-finance:onboarding:v2:guest',
                  JSON.stringify({ version: 2, chapter: 'full', status: 'completed', step: 'complete' }));""")
                errors = []
                page.on('pageerror', lambda error: errors.append(str(error)))
                # Noon in each local timezone, independent of the executor timezone.
                page.clock.install(time=datetime(2026, 10, 13, 12, tzinfo=ZoneInfo(tz)))
                page.goto(args.url)
                fixture = page.evaluate(SEED)
                page.reload()
                verify(page, screenshots, capture=width == 390 and tz == 'Asia/Taipei')
                persisted = page.evaluate("JSON.stringify(JSON.parse(localStorage.getItem('shiba-finance:v3:guest')).data)")
                assert persisted == fixture['data'], 'Browsing periods mutated financial data'
                assert not errors, errors
                assert not external, 'App attempted an external request'
                print(f'[pass] {args.browser} {width}x{height} {tz}: dates, totals, charts, drilldown, switching, empty/error, touch targets, data unchanged')
                context.close()
        browser.close()


if __name__ == '__main__':
    main()
