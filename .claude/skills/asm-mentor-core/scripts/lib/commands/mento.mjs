// mento.mjs — 멘토링/특강 게시판. Read (list/view) via HTTP; write (create/update/delete)
// via the browser (DEXT5 editor, file upload, cascading place select).
import { httpGet } from '../http.mjs';
import { url, sel } from '../maps.mjs';
import { withSession, gotoGuarded, regionUrl } from '../session.mjs';
import { parse, findTable, rowsOf, qparam, strongPairs, bodyText, clean, parseDateTimeRange } from '../parse.mjs';
import { getMyName } from './member.mjs';
import { fillMentoForm } from '../widgets.mjs';
import { AsmError } from '../io.mjs';

function buildListUrl(region, flags, myName) {
  let rel = url('mento', 'list');
  const add = (k, v) => { rel += `&${k}=${encodeURIComponent(v)}`; };
  if (flags.page) add('pageIndex', flags.page);
  if (flags.month) add('setDate', flags.month);
  if (flags.mine && myName) { add('searchCnd', '2'); add('searchWrd', myName); }
  else if (flags.search) { add('searchCnd', flags.searchType || '1'); add('searchWrd', flags.search); }
  if (flags.status) add('searchStatMentolec', flags.status);
  return rel;
}

function parseListRows(root) {
  const table = findTable(root, ['제목', '진행날짜']) || findTable(root, ['제목', '작성자']);
  return rowsOf(table)
    .map((r) => {
      const link = r.links.find((l) => qparam(l.href, 'qustnrSn') || qparam(l.onclick, 'qustnrSn'));
      const qustnrSn = link ? (qparam(link.href, 'qustnrSn') || qparam(link.onclick, 'qustnrSn')) : null;
      const c = r.cells;
      const dt = parseDateTimeRange(c[3] || '');
      return {
        qustnrSn, title: c[1] || (link && clean(link.text)) || null,
        receiptPeriod: c[2] || null, eventDateRaw: c[3] || null,
        date: dt.date, start: dt.start, end: dt.end,
        capacity: c[4] || null, approved: c[5] || null, status: c[6] || null,
        author: c[7] || null, regDate: c[8] || null,
      };
    })
    .filter((i) => i.qustnrSn);
}

export async function list(ctx) {
  const { region, state, flags } = ctx;
  const myName = flags.mine ? await getMyName(region, state) : null;
  const { body } = await httpGet(region, buildListUrl(region, flags, myName), { state });
  const items = parseListRows(parse(body));
  return { region, mine: !!flags.mine, myName, count: items.length, items };
}

export async function view(ctx) {
  const { region, state, flags } = ctx;
  const id = flags.id || flags.qustnrSn;
  if (!id) throw new AsmError('VALIDATION', 'mento-view requires --id <qustnrSn>');
  return viewById(region, id, state);
}

export async function viewById(region, id, state) {
  const rel = `${url('mento', 'view')}&qustnrSn=${encodeURIComponent(id)}`;
  const { body } = await httpGet(region, rel, { state });
  const root = parse(body);
  const p = strongPairs(root);
  const dt = parseDateTimeRange(p['강의날짜'] || '');
  // applicant/participant table (연수생 / 상태)
  const appTable = findTable(root, ['연수생']);
  const applicants = rowsOf(appTable).map((r) => ({
    name: (r.cells[1] || '').replace(/\(.*\)/, '').trim() || r.cells[1] || null,
    raw: r.cells[1] || null, applyDate: r.cells[2] || null, cancelDate: r.cells[3] || null, status: r.cells[4] || null,
  })).filter((a) => a.name);
  const attendees = applicants.filter((a) => /신청완료|참여|완료/.test(a.status || '') && !/취소/.test(a.status || ''));
  return {
    region, qustnrSn: id,
    title: p['모집명'] || null, category: /특강/.test(p['모집명'] || '') ? '멘토 특강' : '자유 멘토링',
    status: p['상태'] || null, approved: p['개설승인'] || null,
    receiptPeriod: p['접수기간'] || null,
    date: dt.date, startTime: dt.start, endTime: dt.end,
    place: p['장소'] || null, capacity: p['모집인원'] || null,
    author: p['작성자'] || null, regDate: p['등록일'] || null,
    applicants, attendees, attendeeNames: attendees.map((a) => a.name),
    body: bodyText(root), fields: p,
  };
}

// All of MY mentorings in a month for a region (used for conflict detection / report linking).
export async function myMentorings(region, { month, state }) {
  const myName = await getMyName(region, state);
  let rel = url('mento', 'list');
  rel += `&searchCnd=2&searchWrd=${encodeURIComponent(myName || '')}`;
  if (month) rel += `&setDate=${encodeURIComponent(month)}`;
  const { body } = await httpGet(region, rel, { state });
  return parseListRows(parse(body)).filter((i) => !myName || i.author === myName);
}

function overlaps(d1, s1, e1, d2, s2, e2) {
  if (!d1 || !d2 || d1 !== d2 || !s1 || !e1 || !s2 || !e2) return false;
  return s1 < e2 && s2 < e1;
}

// Check a candidate slot against MY existing mentorings in BOTH regions.
export async function conflictsFor({ date, start, end, state }) {
  const month = (date || '').slice(0, 7);
  const out = [];
  for (const region of ['seoul', 'busan']) {
    let mine = [];
    try { mine = await myMentorings(region, { month, state }); } catch { /* region may be down */ }
    for (const m of mine) {
      if (overlaps(date, start, end, m.date, m.start, m.end)) {
        out.push({ region, qustnrSn: m.qustnrSn, title: m.title, date: m.date, start: m.start, end: m.end, status: m.status });
      }
    }
  }
  return out;
}

// ---- writes (browser) ----

export async function create(ctx) {
  const { region, state, flags, payload, preview, force, files } = ctx;
  if (!payload) throw new AsmError('VALIDATION', 'mento-create requires --json \'{...}\' (see SKILL for schema)');
  // conflict check across both regions unless forced
  let conflicts = [];
  if (payload.eventDate && payload.startTime && payload.endTime) {
    conflicts = await conflictsFor({ date: payload.eventDate, start: payload.startTime, end: payload.endTime, state });
  }
  if (conflicts.length && !force) {
    throw new AsmError('WRITE_BLOCKED', `시간이 겹치는 내 멘토링이 ${conflicts.length}건 있습니다.`, { conflicts, hint: '시간 변경 또는 --force 로 강행' });
  }
  return withSession(region, async ({ page }) => {
    await gotoGuarded(page, region, regionUrl(region, url('mento', 'insert')), state);
    const res = await fillMentoForm(page, region, payload, files, { preview });
    if (preview) return { preview: true, region, conflicts, ...res };
    return { created: true, region, conflicts, ...res };
  }, { state });
}

export async function update(ctx) {
  const { region, state, flags, payload, preview, files } = ctx;
  const id = flags.id || flags.qustnrSn || payload?.qustnrSn;
  if (!id) throw new AsmError('VALIDATION', 'mento-update requires --id <qustnrSn>');
  if (!payload) throw new AsmError('VALIDATION', 'mento-update requires --json \'{...}\' with fields to change');
  return withSession(region, async ({ page }) => {
    // open the edit form for this qustnrSn
    await gotoGuarded(page, region, `${regionUrl(region, url('mento', 'view'))}&qustnrSn=${encodeURIComponent(id)}`, state);
    const editSel = sel('mento', 'editBtn', region);
    if (await page.locator(editSel).count()) await page.locator(editSel).first().click().catch(() => {});
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    const res = await fillMentoForm(page, region, payload, files, { preview, update: true });
    if (preview) return { preview: true, region, qustnrSn: id, ...res };
    return { updated: true, region, qustnrSn: id, ...res };
  }, { state });
}

export async function remove(ctx) {
  const { region, state, flags, preview } = ctx;
  const id = flags.id || flags.qustnrSn;
  if (!id) throw new AsmError('VALIDATION', 'mento-delete requires --id <qustnrSn>');
  return withSession(region, async ({ page }) => {
    await gotoGuarded(page, region, `${regionUrl(region, url('mento', 'view'))}&qustnrSn=${encodeURIComponent(id)}`, state);
    const delSel = sel('mento', 'deleteBtn', region);
    if ((await page.locator(delSel).count()) === 0) {
      throw new AsmError('SELECTOR_NOT_FOUND', '삭제 버튼을 찾지 못했습니다 (본인 글이 아닐 수 있음).', { hint: 'recon mento-view' });
    }
    if (preview) {
      const shot = '.agentdocs/asm/artifacts/mento-delete-preview.png';
      await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
      return { preview: true, region, qustnrSn: id, screenshot: shot };
    }
    page.on('dialog', (d) => d.accept().catch(() => {}));
    await page.locator(delSel).first().click();
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    return { deleted: true, region, qustnrSn: id };
  }, { state });
}
