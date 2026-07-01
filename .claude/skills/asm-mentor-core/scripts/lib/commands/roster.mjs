// roster.mjs — Notion 명단(연수생/멘토/Expert) 조회. 공개 Notion 페이지는 JS 렌더링이라
// HTML 파싱이 불가하다. 대신 페이지가 호출하는 비공개 queryCollection API에서 컬렉션 식별자
// (collectionId/viewId/spaceId)를 알아낸 뒤, 정규화된 loader 요청을 큰 limit으로 한 번 보내
// 전체 행을 한 번에 받아온다(스크롤/가상화/페이지네이션 불필요, 갤러리·테이블 등 뷰 종류 무관).
// 결과는 컬럼명이 살아있는 구조화된 rows. "연수생 정보/멘토 정보 조회" 요청 전반에 사용한다.
import { withSession } from '../session.mjs';
import { AsmError } from '../io.mjs';
import { NOTION } from './team.mjs';

const KIND_ALIAS = {
  mentees: 'mentees', mentee: 'mentees', 연수생: 'mentees', trainee: 'mentees', trainees: 'mentees',
  mentors: 'mentors', mentor: 'mentors', 멘토: 'mentors',
  experts: 'experts', expert: 'experts', 전문가: 'experts',
};

// 페이지가 보낸 queryCollection 요청/응답에서 컬렉션 식별자를 추출한다.
async function discoverCollection(page, pageUrl) {
  let reqUrl = null;
  let viewId = null;
  let resp = null;
  let throttled = false;
  const onReq = (r) => {
    if (!/\/api\/v3\/queryCollection/.test(r.url())) return;
    if (!reqUrl) reqUrl = r.url();
    if (!viewId) { try { viewId = JSON.parse(r.postData() || '{}').collectionView?.id || null; } catch { /* */ } }
  };
  const onResp = async (r) => {
    if (!/\/api\/v3\/queryCollection/.test(r.url())) return;
    if (r.status() === 429) { throttled = true; return; }
    if (resp) return;
    try { resp = await r.json(); } catch { /* */ }
  };
  page.on('request', onReq);
  page.on('response', onResp);
  await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  // 컬렉션이 인라인(멘토/Expert 페이지)이면 스크롤로 화면에 들어와야 queryCollection이 발동한다.
  // Notion의 스크롤은 window가 아니라 .notion-scroller/.notion-frame 컨테이너에서 일어난다.
  for (let i = 0; i < 40 && (!resp || !viewId); i++) {
    await page.evaluate(() => {
      try {
        window.scrollTo(0, document.body.scrollHeight);
        document.querySelectorAll('.notion-scroller, .notion-frame').forEach((s) => { s.scrollTop = s.scrollHeight; });
        const last = document.querySelector('.notion-collection-item:last-child, .notion-table-view-row:last-child');
        if (last) last.scrollIntoView({ block: 'end' });
      } catch (e) { /* */ }
    }).catch(() => {});
    await page.waitForTimeout(500);
  }
  page.off('request', onReq);
  page.off('response', onResp);
  if (!resp) {
    // 응답 누락은 명시적 429뿐 아니라 '조용한' 일시 차단(soft-throttle)으로도 자주 발생한다.
    // 짧은 시간에 같은 Notion 페이지를 여러 번 열면 응답을 늦추거나 주지 않는다 → 구조 변경으로 오인 금지.
    const why = throttled
      ? 'Notion 요청이 일시 차단(429)되었습니다 — 잠시 후 다시 시도하세요.'
      : 'Notion queryCollection 응답을 가로채지 못했습니다 — 짧은 시간 내 반복 조회로 인한 일시 차단(throttle)일 가능성이 큽니다. 잠시 후 재시도하거나, 여러 명은 --search "이름1,이름2"로 한 번에 조회하세요.';
    throw new AsmError(throttled ? 'TIMEOUT' : 'NAV_ERROR', why, { url: pageUrl, throttled });
  }

  const rm = resp.recordMap || {};
  const colId = (resp.collectionIds && resp.collectionIds[0]) || Object.keys(rm.collection || {})[0] || null;
  const colRec = colId && rm.collection && rm.collection[colId];
  const colVal = colRec && colRec.value && (colRec.value.value || colRec.value);
  const spaceId = (colVal && colVal.space_id)
    || (colRec && colRec.value && colRec.value.value && colRec.value.value.space_id) || null;
  if (!viewId) viewId = Object.keys(rm.collection_view || {})[0] || null;
  const origin = (() => { try { return new URL(reqUrl || pageUrl).origin; } catch { return new URL(pageUrl).origin; } })();
  if (!colId || !viewId || !spaceId) {
    throw new AsmError('NAV_ERROR', 'Notion 컬렉션 식별자를 찾지 못했습니다.', { url: pageUrl, colId, viewId, spaceId });
  }
  return { origin, colId, viewId, spaceId };
}

// 정규화된 loader 요청을 큰 limit으로 보내 전체 행을 파싱한다 (429면 백오프 재시도).
async function loadAllRows(page, ids) {
  return page.evaluate(async (arg) => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const dec = (s) => String(s).replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
    const seg = (val) => (!Array.isArray(val) ? '' : dec(val.map((s) => (Array.isArray(s)
      ? (s[0] === '‣' && s[1] ? ('@' + ((s[1][0] && s[1][0][1]) || '')) : s[0]) : '')).join('')));
    const unwrap = (rec) => rec && rec.value && (rec.value.value || rec.value);
    const body = {
      source: { type: 'collection', id: arg.colId, spaceId: arg.spaceId },
      collection: { id: arg.colId, spaceId: arg.spaceId },
      collectionView: { id: arg.viewId, spaceId: arg.spaceId },
      loader: {
        type: 'reducer',
        reducers: { collection_group_results: { type: 'results', limit: 100000 } },
        searchQuery: '',
        sort: [],
        userTimeZone: 'Asia/Seoul',
      },
    };
    let j = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const r = await fetch(arg.origin + '/api/v3/queryCollection?src=reducer', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body), credentials: 'include',
        });
        if (r.status === 429) { await sleep(1500 * (attempt + 1)); continue; }
        if (!r.ok) return { error: 'HTTP ' + r.status };
        j = await r.json();
        break;
      } catch (e) { if (attempt === 3) return { error: String((e && e.message) || e) }; await sleep(1000); }
    }
    if (!j) return { error: 'rate-limited (429)' };
    const rm = j.recordMap || {};
    const cgr = j.result && j.result.reducerResults && j.result.reducerResults.collection_group_results;
    const blockIds = (cgr && cgr.blockIds) || [];
    const colId = (j.collectionIds && j.collectionIds[0]) || Object.keys(rm.collection || {})[0];
    const colVal = unwrap(rm.collection && rm.collection[colId]);
    const schema = (colVal && colVal.schema) || {};
    const order = Object.entries(schema).map(([pid, v]) => ({ pid, name: v.name, type: v.type }));
    const titleName = colVal && colVal.name ? colVal.name.map((s) => s[0]).join('') : null;
    const rows = blockIds.map((id) => {
      const b = unwrap(rm.block && rm.block[id]);
      if (!b) return null;
      const props = b.properties || {};
      const obj = {};
      for (const c of order) { const v = seg(props[c.pid]); if (v) obj[c.name] = v; }
      return Object.keys(obj).length ? obj : null;
    }).filter(Boolean);
    return { title: titleName, hasMore: !!(cgr && cgr.hasMore), columns: order.map((o) => o.name), rows };
  }, ids);
}

export async function roster(ctx) {
  const { region, state, flags } = ctx;
  const raw = flags.kind && flags.kind !== true ? String(flags.kind).trim().toLowerCase() : 'mentees';
  const kind = KIND_ALIAS[raw];
  if (!kind) {
    throw new AsmError('VALIDATION', `--kind '${flags.kind}' 미지원. 사용: mentees|mentors|experts (연수생/멘토/전문가)`);
  }
  const pageUrl = NOTION[region] && NOTION[region][kind];
  if (!pageUrl) throw new AsmError('VALIDATION', `roster: ${region}/${kind} Notion URL이 없습니다.`);
  const search = flags.search && flags.search !== true ? String(flags.search) : null;

  const data = await withSession(region, async ({ page }) => {
    let lastErr = null;
    // Notion이 일시 throttle(429)하면 재시도 — 페이지를 다시 열어 식별자를 잡고 전체 행을 받는다.
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const ids = await discoverCollection(page, pageUrl);
        const res = await loadAllRows(page, ids);
        if (res && !res.error && (res.rows || []).length >= 0) return res;
        lastErr = new AsmError('NAV_ERROR', `Notion 컬렉션 조회 실패: ${res && res.error}`, { url: pageUrl });
      } catch (e) {
        lastErr = e;
      }
      // throttle은 가라앉는 데 시간이 걸리므로 지수 백오프 + 지터로 마지막 시도까지 충분히 기다린다.
      const backoff = 6000 * Math.pow(2, attempt) + Math.floor(Math.random() * 2000); // ~6s, ~12s
      await page.waitForTimeout(backoff);
    }
    throw lastErr || new AsmError('NAV_ERROR', 'Notion 명단 조회 실패', { url: pageUrl });
  }, { state });

  const all = data.rows || [];
  let rows = all;
  // --search 는 쉼표로 여러 이름을 받는다(예: "안용수,문재윤,오혜린"). 어떤 행이든 값 하나라도
  // 어떤 검색어 하나라도 포함하면 매칭. 전체 명단을 1회만 받아 한 팀의 여러 명을 한 번에 거르므로
  // 사람 수만큼 브라우저를 띄우다 Notion에 일시 차단(throttle) 당하는 일을 막는다.
  const terms = search ? search.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean) : [];
  if (terms.length) {
    rows = all.filter((r) => {
      const hay = Object.values(r).map((v) => String(v).toLowerCase());
      return terms.some((q) => hay.some((v) => v.includes(q)));
    });
  }
  return {
    region,
    kind,
    sourceUrl: pageUrl,
    collectionTitle: data.title || null,
    columns: data.columns || [],
    search,
    searchTerms: terms.length ? terms : null,
    count: rows.length,
    totalCount: all.length,
    truncated: !!data.hasMore,
    rows,
  };
}
