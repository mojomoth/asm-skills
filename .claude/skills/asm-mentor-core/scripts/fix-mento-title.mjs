// Minimal title-only edit on a 부산 멘토 특강 (avoids touching body/image/place).
// Usage: node fix-mento-title.mjs <qustnrSn> <newTitle>
import { withSession, gotoGuarded, regionUrl } from './lib/session.mjs';
import { setText } from './lib/widgets.mjs';

const region = 'busan';
const id = process.argv[2];
const newTitle = process.argv[3];
if (!id || !newTitle) { console.error('need <qustnrSn> <newTitle>'); process.exit(1); }

await withSession(region, async ({ page }) => {
  await gotoGuarded(page, region, regionUrl(region, `/mypage/mentoLec/forUpdate.do?menuNo=200046&qustnrSn=${id}&pageIndex=1`), {});
  await page.waitForTimeout(2000);
  const before = await page.locator('#qustnrSj').inputValue().catch(() => '');
  await setText(page, '#qustnrSj', newTitle);
  const after = await page.locator('#qustnrSj').inputValue().catch(() => '');
  console.log('title before:', before);
  console.log('title after :', after);

  const dialogs = [];
  page.on('dialog', (d) => { dialogs.push(d.message()); d.accept().catch(() => {}); });
  const nav = page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => null);
  await page.locator("button:has-text('수정'), a:has-text('수정')").first().click();
  await nav;
  await page.waitForTimeout(1500);
  const finalUrl = page.url();
  const ok = /list\.do|view\.do/.test(finalUrl) || dialogs.some((x) => /수정|완료|되었습니다/.test(x) && !/하시겠습니까/.test(x));
  console.log(JSON.stringify({ ok, id, finalUrl, dialogs }));
}, { state: {} });
