// report.mjs — 보고 게시판 (서울 전용; 부산 멘토링도 서울 보드에 작성).
// list/view via HTTP; draft (mento 자동채움) + create (browser) with evidence + dedup.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { httpGet } from '../http.mjs';
import { url, sel } from '../maps.mjs';
import { STATE_DIR } from '../env.mjs';
import { withSession, gotoGuarded, regionUrl } from '../session.mjs';
import { parse, findTable, rowsOf, qparam, strongPairs, bodyText, clean } from '../parse.mjs';
import { evalJson } from '../dom.mjs';
import { fillReportForm, artifact } from '../widgets.mjs';
import { viewById as mentoViewById } from './mento.mjs';
import { AsmError, log } from '../io.mjs';

const REPORT_REGION = 'seoul'; // 보고 게시판은 항상 서울

function ledgerPath() { return join(STATE_DIR, 'reported.json'); }
function loadLedger() { try { return JSON.parse(readFileSync(ledgerPath(), 'utf8')); } catch { return {}; } }
function saveLedger(l) { mkdirSync(STATE_DIR, { recursive: true }); writeFileSync(ledgerPath(), JSON.stringify(l, null, 2)); }

export async function list(ctx) {
  const { state, flags } = ctx;
  let rel = url('report', 'list');
  if (flags.year) rel += `&searchYear=${encodeURIComponent(flags.year)}`;
  if (flags.view === 'approved') rel += '&searchType=approved'; // 승인내역; exact param confirmed via recon if needed
  if (flags.page) rel += `&pageIndex=${encodeURIComponent(flags.page)}`;
  if (flags.search) rel += `&searchCnd=${encodeURIComponent(flags.searchType || '1')}&searchWrd=${encodeURIComponent(flags.search)}`;
  const { body } = await httpGet(REPORT_REGION, rel, { state });
  const root = parse(body);
  const table = findTable(root, ['진행']) || findTable(root, ['제목']) || root.querySelector('.board_list table, table.tstyle1');
  const items = rowsOf(table).map((r) => {
    const link = r.links.find((l) => qparam(l.href, 'reportId') || qparam(l.onclick, 'reportId'));
    return { reportId: link ? (qparam(link.href, 'reportId') || qparam(link.onclick, 'reportId')) : null, cells: r.cells };
  }).filter((i) => i.reportId);
  return { count: items.length, items };
}

export async function view(ctx) {
  const { state, flags } = ctx;
  const id = flags.id || flags.reportId;
  if (!id) throw new AsmError('VALIDATION', 'report-view requires --id <reportId>');
  const rel = `${url('report', 'view')}&reportId=${encodeURIComponent(id)}`;
  const { body } = await httpGet(REPORT_REGION, rel, { state });
  const root = parse(body);
  const p = strongPairs(root);
  return {
    reportId: id, fields: p,
    acceptTime: p['인정시간'] || null, payPrice: p['지급액'] || null, status: p['상태'] || null,
    officeOpinion: p['사무국의견'] || p['사무국 의견'] || null,
    body: bodyText(root),
  };
}

// Build a report model from a mentoring (자동채움).
export async function draft(ctx) {
  const { state, flags } = ctx;
  const qustnrSn = flags.qustnrSn || flags.id;
  const mentoRegion = flags.mentoRegion || ctx.region || 'seoul';
  if (!qustnrSn) throw new AsmError('VALIDATION', 'report-draft requires --qustnrSn <id> [--mentoRegion seoul|busan]');
  const m = await mentoViewById(mentoRegion, qustnrSn, state);
  const model = buildModel(m, mentoRegion);
  return { source: { qustnrSn, mentoRegion, title: m.title }, model, provenance: provenanceOf(model) };
}

function buildModel(m, mentoRegion) {
  return {
    menteeTarget: mentoRegion === 'busan' ? '부산 연수생' : '서울 연수생',
    category: m.category || '자유 멘토링', // 정규멘토링은 멘토링에서 도출 불가 -> 수동
    date: m.date,
    teamName: null,
    place: m.place,
    attendees: m.attendeeNames || [],
    startTime: m.startTime,
    endTime: m.endTime,
    excludeStart: null, excludeEnd: null, excludeReason: null,
    subject: m.title,                 // 주제 <- 모집명
    progress: (m.body || '').slice(0, 480), // 추진내용 <- 멘토링 본문
    mentorOpinion: '',
    etc: '',
    absentees: [],
  };
}

function provenanceOf(model) {
  const p = {};
  for (const k of Object.keys(model)) p[k] = (model[k] == null || (Array.isArray(model[k]) && !model[k].length) || model[k] === '') ? 'manual' : 'auto';
  p.attendeeCount = 'derived';
  return p;
}

// Live fuzzy dedup against existing reports.
async function findDuplicate(model, state) {
  const fp = (s) => (s || '').replace(/[.\-/\s]/g, '');
  const target = fp(model.date) + '|' + (model.category || '') + '|' + fp(model.place || '');
  try {
    const { items } = await list({ state, flags: { year: (model.date || '').slice(0, 4) } });
    for (const it of items) {
      const joined = it.cells.join(' ');
      if (model.date && joined.includes(model.date.replace(/-/g, '.')) || (model.date && joined.includes(model.date))) {
        if (!model.place || joined.includes(model.place)) return { reportId: it.reportId, cells: it.cells };
      }
    }
  } catch { /* best-effort */ }
  return null;
}

export async function create(ctx) {
  const { state, flags, payload, preview, force, files } = ctx;
  if (!payload) throw new AsmError('VALIDATION', 'report-create requires --json (a report model, or {qustnrSn, mentoRegion, overrides, autoScreenshot})');

  // 1. resolve model
  let model, qustnrSn = payload.qustnrSn, mentoRegion = payload.mentoRegion || 'seoul';
  let autoScreenshot = payload.autoScreenshot !== false;
  if (qustnrSn) {
    const m = await mentoViewById(mentoRegion, qustnrSn, state);
    model = { ...buildModel(m, mentoRegion), ...(payload.overrides || {}) };
    model._mentoView = `${regionUrl(mentoRegion, url('mento', 'view'))}&qustnrSn=${qustnrSn}`;
  } else {
    model = { ...payload };
    autoScreenshot = payload.autoScreenshot === true;
  }
  if (model.attendees) model.attendeeCount = model.attendees.length;

  // 2. dedup
  const key = qustnrSn ? `${mentoRegion}:${qustnrSn}` : null;
  const ledger = loadLedger();
  if (key && ledger[key] && !force) {
    throw new AsmError('WRITE_BLOCKED', `이미 보고된 멘토링입니다 (reportId=${ledger[key].reportId}).`, { ledger: ledger[key], hint: '--force 로 재제출' });
  }
  if (!force) {
    const dup = await findDuplicate(model, state);
    if (dup) throw new AsmError('WRITE_BLOCKED', `유사한 보고서가 이미 존재합니다 (reportId=${dup.reportId}).`, { duplicate: dup, hint: '--force 로 강행' });
  }

  // 3. evidence (required): user files + optional auto-screenshot of the mento view
  const evidence = [...(files || []), ...((payload.evidence || []).map((e) => (typeof e === 'string' ? e : e.path)))];
  if (autoScreenshot && qustnrSn) {
    const shotRel = await captureMentoShot(mentoRegion, qustnrSn, state);
    if (shotRel) evidence.push(shotRel);
  }
  if (!evidence.length) {
    throw new AsmError('VALIDATION', '증빙서류가 필요합니다. --files <path> 또는 payload.evidence, 또는 autoScreenshot 를 사용하세요.');
  }

  // 4. fill + submit (always seoul board)
  return withSession(REPORT_REGION, async ({ page }) => {
    await gotoGuarded(page, REPORT_REGION, regionUrl(REPORT_REGION, url('report', 'insert')), state);
    const res = await fillReportForm(page, REPORT_REGION, model, evidence, { preview });
    if (preview) return { preview: true, model, evidence, ...res };
    // record ledger
    if (key) { ledger[key] = { reportId: extractReportId(res.finalUrl), submittedAt: new Date().toISOString() }; saveLedger(ledger); }
    return { created: true, model, evidence, ...res };
  }, { state });
}

function extractReportId(u) { return qparam(u || '', 'reportId'); }

async function captureMentoShot(region, qustnrSn, state) {
  try {
    return await withSession(region, async ({ page }) => {
      await gotoGuarded(page, region, `${regionUrl(region, url('mento', 'view'))}&qustnrSn=${qustnrSn}`, state);
      const shot = artifact(`mento-${region}-${qustnrSn}.png`);
      await page.screenshot({ path: shot, fullPage: true });
      return shot;
    }, { state });
  } catch (e) {
    log(`[report] mento screenshot failed: ${e.message}`);
    return null;
  }
}
