// Reformat a 부산 멘토 특강 body for readability (line spacing / indent / bold),
// preserving the already-uploaded inline image. Usage: node format-mento-body.mjs <qustnrSn> [--submit]
import { withSession, gotoGuarded, regionUrl } from './lib/session.mjs';
import { setEditorBody } from './lib/widgets.mjs';

const region = 'busan';
const id = process.argv[2];
const doSubmit = process.argv.includes('--submit');
if (!id) { console.error('need <qustnrSn>'); process.exit(1); }

const P = 'font-size:12pt;font-family:굴림,Gulim,sans-serif;line-height:1.75;';
const para = (html, mb = 14) => `<p style="${P}margin:0 0 ${mb}px 0;">${html}</p>`;

function buildBody(imgTag) {
  const quote = `<div style="${P}margin:6px 0 16px 0;padding:12px 18px;border-left:4px solid #2f6df6;background:#f4f7ff;color:#444;">`
    + ['&ldquo;왜 자꾸 딴 길로 가지?&rdquo;',
       '&ldquo;왜 처음엔 잘하다가 뒤로 갈수록 망가지지?&rdquo;',
       '&ldquo;왜 내가 계속 감시하고 고쳐줘야 하지?&rdquo;',
       '&ldquo;이 정도면 내가 AI를 쓰는 건지, AI를 돌보는 건지 모르겠는데?&rdquo;'].join('<br>')
    + '</div>';
  const bullets = `<ul style="${P}margin:6px 0 16px 0;padding-left:26px;">`
    + ['커스텀 하네스를 구성하는 <strong>기본 구조</strong>',
       '<strong>컨텍스트, 스킬, 에이전트, 루프, 가드레일</strong>의 역할',
       'Claude Code / Codex 같은 도구에서 하네스를 적용하는 방식',
       '범용 하네스의 구조 분석과 커스텀 하네스로 구성',
       '직접 시연으로 하네스를 구성'].map((t) => `<li style="margin:0 0 6px 0;">${t}</li>`).join('')
    + '</ul>';

  return [
    `<p style="${P}margin:0 0 16px 0;text-align:center;">${imgTag}</p>`,
    para('요즘 다들 <strong>Claude Code, Codex, ChatGPT, Gemini</strong> 같은 AI 에이전트를 씁니다.'),
    para('그런데 막상 써보면 이런 순간이 옵니다.', 6),
    quote,
    para('그래서 필요한 것이 <strong>하네스(harness)</strong>입니다.<br>AI 에이전트가 일을 잘하도록 잡아주는 <strong>작업 구조 · 규칙 · 컨텍스트 · 검증 루프 · 가드레일 · 실행 환경</strong>입니다.'),
    para('범용 하네스도 많이 있습니다. <span style="color:#888;">(OmO, OmX, Ouroboros 같은..)</span><br>하지만 여러분의 작업은 항상 같지 않습니다.'),
    para('범용 하네스가 AI 에이전트의 \'스테로이드\'로 성능을 <strong>50%</strong> 향상시켰다면,<br>여러분이 직접 구성한 하네스, 즉 <strong>하네스를 깎으면 성능을 90% 이상</strong> 끌어올릴 수 있습니다.'),
    para('이번 특강에서는 <strong>하네스를 어떻게 구성하는지 직접 시연</strong>합니다. 이런 내용을 다룹니다.', 6),
    bullets,
    para('AI에게 일을 맡기려면, <strong>AI가 일할 수 있는 구조를 먼저 만들어야 합니다.</strong><br>AI 에이전트를 \'계속 일하게 만드는 사람\'으로 넘어가고 싶은 분들을 위한 특강입니다.'),
    `<p style="${P}margin:18px 0 0 0;font-size:13pt;"><strong>AI 에이전트, 이제 그냥 굴리지 말고 하네스를 깎아봅시다.</strong></p>`,
  ].join('');
}

await withSession(region, async ({ page }) => {
  await gotoGuarded(page, region, regionUrl(region, `/mypage/mentoLec/forUpdate.do?menuNo=200046&qustnrSn=${id}&pageIndex=1`), {});
  await page.waitForTimeout(2500);

  const cur = await page.evaluate(() => { try { return window.DEXT5 && DEXT5.getBodyValue ? DEXT5.getBodyValue('qestnarCn') : ''; } catch (e) { return ''; } });
  const m = (cur || '').match(/<img[^>]*dext5editordata[^>]*>/i);
  if (!m) { console.log('CUR BODY:', (cur || '').slice(0, 400)); throw new Error('existing uploaded image not found'); }
  console.log('preserved img:', m[0].slice(0, 120));

  await setEditorBody(page, 'qestnarCn', buildBody(m[0]));
  await page.waitForTimeout(800);

  if (!doSubmit) {
    const shot = `.agentdocs/asm/artifacts/mento-body-${id}-preview.png`;
    await page.screenshot({ path: shot, fullPage: true });
    console.log(JSON.stringify({ preview: true, id, screenshot: shot }));
    return;
  }
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
