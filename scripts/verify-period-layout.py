"""Synthetic, local-only Chromium period layout regression and text-scale checks.

Text scaling changes the root font size; this is not an iOS Dynamic Type test.
Run alongside the Vite dev server: python scripts/verify-period-layout.py
"""
import argparse
from datetime import datetime
from pathlib import Path
import runpy
from urllib.parse import urlparse
from zoneinfo import ZoneInfo

from playwright.sync_api import expect, sync_playwright

SEED = runpy.run_path(str(Path(__file__).with_name('verify-period-selector.py')))['SEED']
URL = 'http://127.0.0.1:8888'
GEOMETRY = """el => {
  const rect = x => { const r=x.getBoundingClientRect(); return {
    name:x.getAttribute('aria-label') || x.textContent, left:r.left, right:r.right,
    top:r.top, bottom:r.bottom, width:r.width, height:r.height,
    client:x.clientWidth, scroll:x.scrollWidth }; };
  return { viewport:innerWidth, picker:rect(el),
    controls:[...el.querySelectorAll('button,input')].map(rect),
    captions:[...el.querySelectorAll('label,p')].map(rect) };
}"""


def check_layout(page):
    picker = page.locator('.calendar-period-picker')
    picker.scroll_into_view_if_needed()
    data = picker.evaluate(GEOMETRY)
    assert data['picker']['left'] >= 0 and data['picker']['right'] <= data['viewport'], data
    for item in data['controls'] + data['captions']:
        assert item['left'] >= data['picker']['left'], data
        assert item['right'] <= data['picker']['right'], data
        assert item['scroll'] <= item['client'] + 1, data
    for i, item in enumerate(data['controls']):
        assert item['height'] >= 44 and item['width'] >= 44, data
        for other in data['controls'][i+1:]:
            overlap_x = min(item['right'], other['right']) - max(item['left'], other['left'])
            overlap_y = min(item['bottom'], other['bottom']) - max(item['top'], other['top'])
            assert overlap_x <= 0 or overlap_y <= 0, data
    # The native shadow's text can still clip; its complete value is repeated
    # in a wrapping, full-size accessible caption checked above.
    # Date input occupies a separate row above every action, including after rotation.
    assert data['controls'][0]['bottom'] <= min(x['top'] for x in data['controls'][1:]), data


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--widths', nargs='+', type=int, default=[320,375,390,414,430,440])
    args = parser.parse_args()
    shots = Path('docs/screenshots')
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path='/usr/bin/chromium')
        count = 0
        for width, height in [(320,568),(375,667),(390,844),(414,896),(430,932),(440,956)]:
            if width not in args.widths:
                continue
            for scale in [1, 1.5, 2]:
                for empty in [False, True]:
                    context = browser.new_context(viewport={'width':width,'height':height},
                        is_mobile=True, has_touch=True, timezone_id='Asia/Taipei', locale='en-US')
                    external = []
                    def route_local(route):
                        if urlparse(route.request.url).netloc != urlparse(URL).netloc:
                            external.append(route.request.url)
                            route.abort()
                        elif urlparse(route.request.url).path == '/__period_fixture__':
                            route.fulfill(status=200, content_type='text/html', body='<html><body>Local synthetic fixture setup</body></html>')
                        else:
                            route.continue_()
                    context.route('**/*', route_local)
                    page = context.new_page()
                    errors = []
                    page.on('pageerror', lambda error: errors.append(str(error)))
                    page.add_init_script("""localStorage.setItem('shiba-finance:onboarding:v2:guest',
                        JSON.stringify({version:2,chapter:'full',status:'completed',step:'complete'}));""")
                    page.clock.install(time=datetime(2026,10,13,12,tzinfo=ZoneInfo('Asia/Taipei')))
                    # Seed on a same-origin blank page before React/durability mounts.
                    page.goto(URL + '/__period_fixture__')
                    fixture_seed = SEED
                    if empty:
                        fixture_seed = SEED.replace(
                            "  localStorage.setItem(storageKey('guest')",
                            "  data.transactions = []; data.transfers = [];\n  localStorage.setItem(storageKey('guest')")
                    page.evaluate(fixture_seed)
                    persisted = page.evaluate("localStorage.getItem('shiba-finance:v3:guest')")
                    page.goto(URL)
                    page.add_style_tag(content=f'html {{ font-size: {16*scale}px !important; }}')
                    page.get_by_role('button', name='洞察', exact=True).click()
                    summary = page.get_by_role('region', name='這段時間的收支')
                    for w,h in [(width,height),(height,width)]:
                        page.set_viewport_size({'width':w,'height':h})
                        for period,value,total in [('月','2024-02','NT$290'),('週','2025-01-05','NT$225')]:
                            page.get_by_role('button',name=period,exact=True).click()
                            field = page.get_by_label('選擇月份' if period=='月' else '選擇週內日期',exact=True)
                            field.fill(value)
                            expect(summary.locator('.insight-metric.expense strong')).to_have_text('NT$0' if empty else total)
                            expect(page.locator('#selected-period-value')).to_contain_text(value)
                            check_layout(page)
                            if period=='月':
                                # September is a long native en-US month value; the full
                                # caption must remain readable even if native text clips.
                                field.fill('2026-09')
                                expect(page.locator('#selected-period-range')).to_have_text('2026/9/1 — 2026/9/30')
                                expect(page.locator('#selected-period-value')).to_have_text('已選月份：2026-09')
                                check_layout(page)
                                field.fill(value)
                            if w==320 and scale==2 and not empty:
                                page.locator('.calendar-period-picker').screenshot(style='.app-header, .app-header *, .bottom-nav, .bottom-nav * { visibility: hidden !important; }', path=str(shots/f'period-layout-{period}-320-200pct.png'))
                            page.get_by_role('button',name=f'下一{period}',exact=True).click()
                            page.get_by_role('button',name=f'上一{period}',exact=True).click()
                            expect(summary.locator('.insight-metric.expense strong')).to_have_text('NT$0' if empty else total)
                            page.get_by_role('button',name=f'回本{period}',exact=True).click()
                            expect(page.locator('#selected-period-value')).to_contain_text('2026-10' if period=='月' else '2026-10-12')
                            check_layout(page)
                            if period=='週' and empty and w==width and (width,scale) in [(440,1),(320,2)]:
                                page.locator('.calendar-period-picker').screenshot(style='.app-header, .app-header *, .bottom-nav, .bottom-nav * { visibility: hidden !important; }', path=str(shots / (f'period-layout-after-{width}-200pct.png' if scale==2 else f'period-layout-after-{width}.png')))
                        count += 1
                    assert not external and not errors, (external,errors)
                    assert page.evaluate("localStorage.getItem('shiba-finance:v3:guest')") == persisted
                    print(f'[pass] {width}x{height} + rotation, text {scale*100:g}%, {"empty" if empty else "synthetic"}: controls, range, switching, totals, unchanged data')
                    context.close()
        browser.close()
        print(f'{count} viewport/data/text-scale cases passed (week + month each).')


if __name__ == '__main__':
    main()
