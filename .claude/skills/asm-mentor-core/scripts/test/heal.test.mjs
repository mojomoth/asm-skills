// heal.test.mjs — unit tests for the self-heal subsystem (browser-free parts).
// Run: node --test  (from scripts/)  — uses an isolated ASM_STATE_DIR so it never
// touches real overrides/sessions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Isolate persistence BEFORE importing modules that resolve the state dir.
process.env.ASM_STATE_DIR = mkdtempSync(join(tmpdir(), 'asm-heal-test-'));

const { rankCandidates, decide, normLabel, AUTO_MARGIN } = await import('../lib/heal/match.mjs');
const { synthesizeSelector } = await import('../lib/heal/validate.mjs');
const { sel, selOpt, url, desc, setOverride, reloadMerged, descriptorKeys } = await import('../lib/maps.mjs');
const { scrubCandidates } = await import('../lib/heal/index.mjs');
const store = await import('../lib/heal/store.mjs');
const { navUrlFrom, anchorsFromHtml, pickCandidate, toRelative } = await import('../lib/heal/urlheal.mjs');

// ---- representative fixtures (trimmed from real recon dumps; new format w/ form+value) ----
const MENTO = {
  fields: [
    { tag: 'input', type: 'radio', name: 'reportCd', id: 'MRC010', value: 'MRC010', label: '자유 멘토링', form: 'board' },
    { tag: 'input', type: 'radio', name: 'reportCd', id: 'MRC020', value: 'MRC020', label: '멘토 특강', form: 'board' },
    { tag: 'input', type: 'text', name: 'qustnrSj', id: 'qustnrSj', label: '', form: 'board' },
    { tag: 'input', type: 'text', name: 'eventDt', id: 'eventDt', label: '', form: 'board' },
    { tag: 'input', type: 'text', name: 'bgndeDate', id: 'bgndeDate', label: '', form: 'board' },
    { tag: 'input', type: 'text', name: 'teamNmsInput', id: 'teamNmsInput', label: '팀명', form: 'teamFrm' },
    { tag: 'select', type: 'select-one', name: 'place', id: 'place', label: '선택 토즈-광화문점 온라인(Webex)', form: 'board', options: [{ value: '', text: '선택' }, { value: '스페이스 A1', text: '스페이스 A1' }] },
  ],
  buttons: [
    { tag: 'a', text: '등록', onclick: 'checkForm();' },
    { tag: 'a', text: '취소', onclick: 'goList();' },
    { tag: 'a', text: '목록', onclick: 'goList();' },
  ],
};
const REPORT = {
  fields: [
    { tag: 'input', type: 'radio', name: 'menteeRegionCd', id: 'menteeRegionCd_0', value: 'S', label: '서울 연수생', form: 'board' },
    { tag: 'input', type: 'radio', name: 'menteeRegionCd', id: 'menteeRegionCd_1', value: 'B', label: '부산 연수생', form: 'board' },
    { tag: 'input', type: 'text', name: 'subject', id: 'subject', label: '', form: 'board' },
    { tag: 'select', type: 'select-one', name: 'progressPlace', id: 'progressPlace', label: '선택', form: 'board', options: [{ value: '', text: '선택' }] },
    { tag: 'select', type: 'select-one', name: 'progressStimeHour', id: 'progressStimeHour', label: '진행 시간', form: 'board' },
    { tag: 'select', type: 'select-one', name: 'progressEtimeHour', id: 'progressEtimeHour', label: '진행 시간', form: 'board' },
  ],
  buttons: [{ tag: 'button', text: '저장', onclick: 'checkForm();' }, { tag: 'a', text: '취소', onclick: 'goList();' }],
};
const clone = (x) => JSON.parse(JSON.stringify(x));

test('normLabel is whitespace/colon/marker insensitive', () => {
  assert.equal(normLabel('자유 멘토링'), normLabel('자유멘토링'));
  assert.equal(normLabel('모집명 *'), '모집명');
  assert.equal(normLabel('진행장소 :'), '진행장소');
  assert.equal(normLabel('진행장소(필수)'), '진행장소');
});

test('backward compat: sel/url return strings for plain entries and css/path for objects', () => {
  assert.equal(sel('mento', 'form'), 'form#board');           // plain string
  assert.equal(sel('mento', 'title'), '#qustnrSj');           // {css,desc} -> css
  assert.equal(url('mento', 'list'), '/mypage/mentoLec/list.do?menuNo=200046');
  assert.equal(url('login'), '/member/user/forLogin.do?menuNo=200025');
  assert.equal(selOpt('mento', 'no-such-key'), null);
  assert.deepEqual(descriptorKeys('mento').map((d) => d.key).sort(), ['catFree', 'catLecture', 'eventDate', 'place', 'submitBtn', 'title'].sort());
});

test('golden HEALTHY: each annotated field re-resolves to its current element with auto confidence', () => {
  const cases = [
    ['mento', 'title', 'qustnrSj'], ['mento', 'eventDate', 'eventDt'], ['mento', 'place', 'place'],
    ['mento', 'catFree', 'MRC010'], ['mento', 'catLecture', 'MRC020'],
    ['report', 'regionSeoul', 'menteeRegionCd_0'], ['report', 'regionBusan', 'menteeRegionCd_1'],
    ['report', 'subject', 'subject'], ['report', 'place', 'progressPlace'],
  ];
  for (const [area, key, expectId] of cases) {
    const dump = area === 'mento' ? MENTO : REPORT;
    const d = decide(rankCandidates(dump, desc(area, key)));
    assert.equal(d.top?.field.id, expectId, `${area}.${key} -> ${d.top?.field.id} (want ${expectId})`);
    assert.equal(d.action, 'auto', `${area}.${key} action=${d.action} conf=${d.confidence} margin=${d.margin}`);
  }
});

test('golden BROKEN: ids mangled -> still found by name/value/form, synthesizes a working selector', () => {
  const broken = clone(MENTO);
  for (const f of broken.fields) if (f.id) f.id = f.id + '_x9'; // simulate an id rename
  for (const [key, expectName] of [['title', 'qustnrSj'], ['eventDate', 'eventDt'], ['place', 'place'], ['catLecture', 'reportCd']]) {
    const d = decide(rankCandidates(broken, desc('mento', key)));
    assert.equal(d.action, 'auto', `${key} broken action=${d.action} conf=${d.confidence} margin=${d.margin}`);
    assert.equal(d.top.field.name, expectName);
    const css = synthesizeSelector(d.top.field, desc('mento', key));
    assert.ok(css && css.includes('_x9'), `synth should use the new id: ${css}`); // new id discovered
  }
});

test('radio value is decisive: catLecture picks MRC020 not MRC010', () => {
  const d = decide(rankCandidates(MENTO, desc('mento', 'catLecture')));
  assert.equal(d.top.field.id, 'MRC020');
  assert.ok(d.margin >= AUTO_MARGIN, `margin ${d.margin} should clear ${AUTO_MARGIN}`);
});

test('AMBIGUITY: two same-label selects with a label-only descriptor -> escalate', () => {
  const ambiguous = { fields: REPORT.fields.filter((f) => /progress.timeHour/.test(f.name || '')), buttons: [] };
  const d = decide(rankCandidates(ambiguous, { tag: 'select', label: '진행 시간' })); // no name -> can't disambiguate
  assert.equal(d.action, 'escalate');
  assert.ok(d.margin < AUTO_MARGIN);
});

test('synthesizeSelector: id > name(+value) > button text', () => {
  assert.equal(synthesizeSelector({ tag: 'input', id: 'foo', name: 'bar' }), '#foo');
  assert.equal(synthesizeSelector({ tag: 'input', name: 'bar', type: 'text' }), 'input[name="bar"]');
  assert.equal(synthesizeSelector({ tag: 'input', name: 'g', type: 'radio', value: 'S' }), 'input[name="g"][value="S"]');
  assert.equal(synthesizeSelector({ tag: 'a', text: '등록' }, { tag: 'a' }), "a:has-text('등록')");
});

test('scrubCandidates strips options and truncates (no PII leak)', () => {
  const ranked = [{ field: { tag: 'select', name: 'place', id: 'place', label: 'x'.repeat(80), options: [{ value: '1', text: '홍길동' }] }, score: 0.9, signals: {} }];
  const out = scrubCandidates(ranked, true);
  assert.equal(out[0].options, undefined, 'options must be dropped');
  assert.ok(!JSON.stringify(out).includes('홍길동'), 'no option text in scrubbed output');
  assert.ok(out[0].label.length <= 40);
});

test('store: setOverride round-trips, mutates in place, leaves bundled base immutable', () => {
  store.revert({ all: true }); reloadMerged();
  assert.equal(sel('mento', 'title'), '#qustnrSj');
  const persisted = setOverride({ kind: 'selectors', area: 'mento', layer: '_default', key: 'title', value: '#newId', prov: { confidence: 0.9 } });
  assert.equal(persisted, true);
  assert.equal(sel('mento', 'title'), '#newId', 'in-place mutation visible immediately');
  reloadMerged();
  assert.equal(sel('mento', 'title'), '#newId', 'persisted to disk');
  store.revert({ area: 'mento', key: 'title' }); reloadMerged();
  assert.equal(sel('mento', 'title'), '#qustnrSj', 'revert restores the bundled base (base never mutated)');
});

test('store: descriptor survives a heal (override carries css only, desc stays bundled)', () => {
  store.revert({ all: true }); reloadMerged();
  setOverride({ kind: 'selectors', area: 'mento', layer: '_default', key: 'title', value: '#healed', prov: {} });
  assert.equal(sel('mento', 'title'), '#healed');
  assert.equal(desc('mento', 'title')?.name, 'qustnrSj', 'descriptor preserved after heal');
  store.revert({ all: true }); reloadMerged();
});

test('store: ledger cap + cooldown gate re-heals', () => {
  store.ledgerClear(null, null, null);
  assert.equal(store.ledgerBlocked('seoul', 'mento', 'title').blocked, false);
  store.ledgerBump('seoul', 'mento', 'title');
  // within cooldown -> blocked
  assert.equal(store.ledgerBlocked('seoul', 'mento', 'title').blocked, true);
  assert.equal(store.ledgerBlocked('seoul', 'mento', 'title').reason, 'cooldown');
  store.ledgerClear('seoul', 'mento', 'title');
  assert.equal(store.ledgerBlocked('seoul', 'mento', 'title').blocked, false);
});

test('urlheal navUrlFrom: extracts the real path from onclick navigation', () => {
  assert.equal(navUrlFrom('', "location.href='/sw/mypage/mentoLec/list.do?menuNo=200046'"), '/sw/mypage/mentoLec/list.do?menuNo=200046');
  assert.equal(navUrlFrom('/real.do?menuNo=1', "x()"), '/real.do?menuNo=1');         // real href wins
  assert.equal(navUrlFrom('#', "fn_go('/x.do?menuNo=2')"), '/x.do?menuNo=2');        // generic .do fallback
  assert.equal(navUrlFrom('#', 'doNothing()'), null);                                // no url -> null
  assert.equal(navUrlFrom('javascript:void(0)', "location.replace('/y.do?menuNo=3')"), '/y.do?menuNo=3');
});

test('urlheal anchorsFromHtml: onclick-only nav anchor yields a clean path, not raw JS', () => {
  const anchors = anchorsFromHtml(`<ul><li><a onclick="location.href='/sw/mypage/mentoLec/list.do?menuNo=200046'">멘토링</a></li>
    <li><a href="/sw/mypage/myNotice/list.do?menuNo=200038">공지</a></li>
    <li><a onclick="alert('x')">none</a></li></ul>`);
  assert.equal(anchors.length, 2);
  const m = anchors.find((a) => a.menuNo === '200046');
  assert.equal(m.href, '/sw/mypage/mentoLec/list.do?menuNo=200046');
  assert.ok(!m.href.includes('location.href'), 'must not store raw onclick JS');
});

test('urlheal pickCandidate: doFile gate applies even to a single candidate (insert must not heal to list)', () => {
  const navListOnly = [{ menuNo: '200046', href: '/sw/mypage/mentoLec/list.do?menuNo=200046' }];
  // healing the INSERT url (forInsert.do) but nav exposes only list.do -> below auto (0.8) -> escalate
  const insert = pickCandidate('seoul', navListOnly, '200046', 'forinsert.do');
  assert.ok(insert.confidence < 0.8, `single non-matching .do must escalate, got ${insert.confidence}`);
  // healing the LIST url -> doFile matches -> auto
  const list = pickCandidate('seoul', navListOnly, '200046', 'list.do');
  assert.equal(list.path, '/mypage/mentoLec/list.do?menuNo=200046');
  assert.ok(list.confidence >= 0.8);
  // no expectDoFile, single path -> auto
  assert.ok(pickCandidate('seoul', navListOnly, '200046', null).confidence >= 0.8);
});

test('urlheal toRelative: strips origin + region prefix (seoul /sw, busan /busan/sw)', () => {
  assert.equal(toRelative('seoul', '/sw/mypage/x.do?menuNo=1'), '/mypage/x.do?menuNo=1');
  assert.equal(toRelative('busan', '/busan/sw/mypage/x.do?menuNo=1'), '/mypage/x.do?menuNo=1');
  assert.equal(toRelative('seoul', 'https://www.swmaestro.ai/sw/mypage/x.do'), '/mypage/x.do');
});

test('urls: menuNo preserved across an override (descriptor merge keeps the rest)', () => {
  store.revert({ all: true }); reloadMerged();
  setOverride({ kind: 'urls', area: 'mento', key: 'list', value: '/new/mentoLec.do?menuNo=200046', prov: {} });
  assert.equal(url('mento', 'list'), '/new/mentoLec.do?menuNo=200046');
  store.revert({ all: true }); reloadMerged();
  assert.equal(url('mento', 'list'), '/mypage/mentoLec/list.do?menuNo=200046');
});
