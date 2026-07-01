// fund.mjs — 신청/접수 (서울 전용): IT기기/자기주도학습 + 프로젝트 활동비. 조회 + 평가의견.
import { httpGet } from '../http.mjs';
import { url, sel } from '../maps.mjs';
import { withSession, gotoGuarded, regionUrl } from '../session.mjs';
import { parse, findTable, rowsOf, qparam, strongPairs, bodyText, clean } from '../parse.mjs';
import { AsmError } from '../io.mjs';

function ensureSeoul(region) {
  if (region !== 'seoul') throw new AsmError('VALIDATION', '신청/접수는 서울 전용입니다 (--region seoul).');
}

export async function list(ctx) {
  const { region, state, flags } = ctx;
  ensureSeoul(region);
  // kind: 'project' (프로젝트 활동비, menuNo=200054) | 'device' (IT기기/자기주도학습, 200053)
  const kind = flags.kind === 'device' ? 'device' : 'project';
  let rel = url('fund', kind);
  if (flags.search) rel += `&searchWrd=${encodeURIComponent(flags.search)}`;
  if (flags.page) rel += `&pageIndex=${encodeURIComponent(flags.page)}`;
  const { body } = await httpGet(region, rel, { state });
  const root = parse(body);
  // pick the table whose rows carry foundId links (skip the team widget table)
  let items = [];
  for (const t of root.querySelectorAll('table')) {
    const rows = rowsOf(t).map((r) => {
      const link = r.links.find((l) => qparam(l.href, 'foundId') || qparam(l.onclick, 'foundId'));
      const href = link ? (link.href || link.onclick) : null;
      return { foundId: href ? qparam(href, 'foundId') : null, viewHref: href, cells: r.cells };
    }).filter((i) => i.foundId);
    if (rows.length) { items = rows; break; }
  }
  return { kind, count: items.length, items };
}

export async function view(ctx) {
  const { region, state, flags } = ctx;
  ensureSeoul(region);
  const id = flags.id || flags.foundId;
  if (!id) throw new AsmError('VALIDATION', 'fund-view requires --id <foundId>');
  const rel = `${url('fund', 'projectView')}&foundId=${encodeURIComponent(id)}`;
  const { body } = await httpGet(region, rel, { state });
  const root = parse(body);
  // mentor evaluations are typically a list near the bottom
  const evals = [];
  for (const el of root.querySelectorAll('.opinion, .comment, .reply, li')) {
    const t = clean(el.text);
    if (/평가|의견/.test(t) && t.length < 300) evals.push(t);
  }
  return { foundId: id, fields: strongPairs(root), body: bodyText(root), evaluationsRaw: evals.slice(0, 20) };
}

// fund-comment: add/delete a mentor evaluation opinion. Browser path (form on view page).
export async function comment(ctx) {
  const { region, state, flags, preview } = ctx;
  ensureSeoul(region);
  const id = flags.id || flags.foundId;
  const text = flags.text;
  const del = flags.delete;
  if (!id) throw new AsmError('VALIDATION', 'fund-comment requires --id <foundId>');
  if (!del && !text) throw new AsmError('VALIDATION', 'fund-comment requires --text "<의견>" (or --delete <opinionId>)');
  return withSession(region, async ({ page }) => {
    await gotoGuarded(page, region, `${regionUrl(region, url('fund', 'projectView'))}&foundId=${encodeURIComponent(id)}`, state);
    // The exact opinion-input selector must be confirmed via recon of the view page.
    const inputSel = 'textarea[name=opinionCn], textarea#opinionCn, textarea[name=mentoOpn], #opinion';
    const addSel = "button:has-text('등록'), a:has-text('등록'), button:has-text('의견')";
    const input = await page.locator(inputSel).first();
    if ((await input.count()) === 0) {
      throw new AsmError('SELECTOR_NOT_FOUND', '평가의견 입력란을 찾지 못했습니다.', {
        hint: 'asm recon --region seoul --url "/mypage/projectSpt/view.do?menuNo=200054&foundId=' + id + '" 로 폼 구조를 재확인하고 selectors.json[fund]에 추가하세요.',
      });
    }
    await input.fill(text || '');
    if (preview) {
      const shot = `${state.artifactsDir || '.agentdocs/asm/artifacts'}/fund-comment-preview.png`;
      await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
      return { preview: true, foundId: id, text, screenshot: shot };
    }
    await page.locator(addSel).first().click();
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    return { posted: true, foundId: id };
  }, { state });
}
