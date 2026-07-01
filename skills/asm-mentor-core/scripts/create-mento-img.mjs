// Create a 부산 멘토 특강 with a REAL inline image uploaded through the DEXT5 editor.
// Usage: node create-mento-img.mjs <eventDate YYYY-MM-DD> <imagePath> [--submit]
// Without --submit it stops after filling+uploading and screenshots (preview).
import { withSession, gotoGuarded, regionUrl } from './lib/session.mjs';
import { url, sel } from './lib/maps.mjs';
import { setText, setDateField, selectValue, checkRadio, setEditorBody } from './lib/widgets.mjs';
import { evalJson } from './lib/dom.mjs';

const region = 'busan';
const eventDate = process.argv[2];
const imagePath = process.argv[3];
const doSubmit = process.argv.includes('--submit');
if (!eventDate || !imagePath) { console.error('need <eventDate> <imagePath>'); process.exit(1); }

const TITLE = '[멘토 특강] AI 에이전트를 그냥 쓰지 말고, 하네스를 깎으세요';
const paras = [
  '요즘 다들 Claude Code, Codex, ChatGPT, Gemini 같은 AI 에이전트를 씁니다.',
  '그런데 막상 써보면 이런 순간이 옵니다.',
  '&ldquo;왜 자꾸 딴 길로 가지?&rdquo; &ldquo;왜 처음엔 잘하다가 뒤로 갈수록 망가지지?&rdquo; &ldquo;왜 내가 계속 감시하고 고쳐줘야 하지?&rdquo; &ldquo;이 정도면 내가 AI를 쓰는 건지, AI를 돌보는 건지 모르겠는데?&rdquo;',
  '그래서 필요한 것이 하네스입니다. AI 에이전트가 일을 잘하도록 잡아주는 작업 구조, 규칙, 컨텍스트, 검증 루프, 가드레일, 실행 환경입니다.',
  '범용 하네스도 많이 있습니다. (OmO, OmX, Ouroboros 같은..)',
  '하지만 여러분의 작업은 항상 같지 않습니다.',
  "범용하네스가 AI에이전트의 '스테로이드'로 성능을 50% 향상 시켰다면 여러분이 직접 구성한 \"하네스\" 즉, 하네스를 깎으면 성능을 90%이상 향상시킬 수 있습니다.",
  '이번 특강에서 하네스를 어떻게 구성하는지 직접 시연합니다. 이런 내용을 다룹니다.',
  '- 커스텀 하네스를 구성하는 기본 구조<br>- 컨텍스트, 스킬, 에이전트, 루프, 가드레일의 역할<br>- Claude Code / Codex 같은 도구에서 하네스를 적용하는 방식<br>- 범용하네스의 구조 분석과 커스텀 하네스로 구성<br>- 직접 시연으로 하네스를 구성',
  'AI에게 일을 맡기려면, AI가 일할 수 있는 구조를 먼저 만들어야 합니다. AI 에이전트가 계속 일하게 만드는 사람으로 넘어가고 싶은 분들을 위한 특강입니다.',
  'AI 에이전트, 이제 그냥 굴리지 말고 하네스를 깎아봅시다.',
];
const textHtml = '<p>&nbsp;</p>' + paras.map((p) => `<p style="margin:0;">${p}</p>`).join('');

const S = (k) => sel('mento', k, region);

await withSession(region, async ({ page }) => {
  await gotoGuarded(page, region, regionUrl(region, url('mento', 'insert')), {});
  await page.waitForTimeout(2000);

  // ---- fields ----
  await checkRadio(page, S('catLecture')); await page.waitForTimeout(300);
  await checkRadio(page, S('methodOffline')); await page.waitForTimeout(700);
  await setText(page, S('title'), TITLE);
  await checkRadio(page, S('receiptBefore'));
  await setDateField(page, S('bgnDate'), '2026-06-22');
  await selectValue(page, S('bgnTime'), '09:00');
  await setDateField(page, S('eventDate'), eventDate);
  await selectValue(page, S('eventStime'), '19:00');
  await selectValue(page, S('eventEtime'), '21:00');
  await selectValue(page, S('applySelect1'), '8').catch(() => {});
  await selectValue(page, S('applySelect2'), '8').catch(() => {});
  await evalJson(page, (a) => { const el = document.querySelector(a.q); if (el) { el.value = a.v; el.dispatchEvent(new Event('change', { bubbles: true })); } return true; }, { q: S('applyCnt'), v: '8' });
  await selectValue(page, S('place'), 'SPACE M1');
  console.log('fields filled');

  // ---- image upload via DEXT5 dialog ----
  let edFrame;
  for (let i = 0; i < 20 && !edFrame; i++) { edFrame = page.frames().find((f) => /editor_release/.test(f.url())); if (!edFrame) await page.waitForTimeout(500); }
  if (!edFrame) throw new Error('editor frame not ready');
  await edFrame.locator('#ue_qestnarCnimage_create').click({ timeout: 10000 });
  let imgFrame;
  for (let i = 0; i < 24 && !imgFrame; i++) { await page.waitForTimeout(500); imgFrame = page.frames().find((f) => /editor_image/.test(f.url())); }
  if (!imgFrame) throw new Error('image dialog frame not found');
  await imgFrame.locator('#Filedata').setInputFiles(imagePath);
  await page.waitForTimeout(1200);
  await imgFrame.locator('#btn_ok_a').click({ timeout: 8000 });
  console.log('image dialog confirmed; waiting for upload+insert...');

  // poll editor body until the uploaded image (dext5editordata) appears
  let body = '';
  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(1000);
    body = await page.evaluate(() => { try { return window.DEXT5 && DEXT5.getBodyValue ? DEXT5.getBodyValue('qestnarCn') : ''; } catch (e) { return ''; } });
    if (/dext5editordata/i.test(body) && /<img/i.test(body)) break;
    if (i % 5 === 0) console.log(' poll', i, 'bodyLen', (body || '').length);
  }
  const m = (body || '').match(/<img[^>]*dext5editordata[^>]*>/i);
  if (!m) { console.log('BODY DUMP:', (body || '').slice(0, 500)); throw new Error('uploaded image not found in editor body'); }
  console.log('uploaded img tag:', m[0].slice(0, 160));

  // ---- combine image + text and write back ----
  const finalBody = m[0] + textHtml;
  await setEditorBody(page, 'qestnarCn', finalBody);
  await page.waitForTimeout(800);

  if (!doSubmit) {
    const shot = '.agentdocs/asm/artifacts/mento-img-preview.png';
    await page.screenshot({ path: shot, fullPage: true });
    console.log(JSON.stringify({ preview: true, eventDate, screenshot: shot }));
    return;
  }

  // ---- submit ----
  const dialogs = [];
  page.on('dialog', (d) => { dialogs.push(d.message()); d.accept().catch(() => {}); });
  const nav = page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => null);
  await page.locator(S('submitBtn')).first().click();
  await nav;
  await page.waitForTimeout(1500);
  const finalUrl = page.url();
  const ok = /list\.do/.test(finalUrl) || dialogs.some((x) => /등록|완료|되었습니다/.test(x) && !/하시겠습니까/.test(x));
  const shot = '.agentdocs/asm/artifacts/mento-img-submit.png';
  await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
  console.log(JSON.stringify({ submitted: ok, eventDate, finalUrl, dialogs, screenshot: shot }));
}, { state: {} });
