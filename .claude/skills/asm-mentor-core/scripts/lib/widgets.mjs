// widgets.mjs — shared browser form helpers for the write flows (mento + report).
// Room slot selection lives in commands/room.mjs.
import { resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import { ARTIFACTS_DIR, PROJECT_ROOT } from './env.mjs';
import { sel } from './maps.mjs';
import { evalJson } from './dom.mjs';
import { AsmError, log } from './io.mjs';

export function artifact(name) {
  mkdirSync(ARTIFACTS_DIR, { recursive: true });
  return resolve(ARTIFACTS_DIR, name);
}

// Set a (often readonly datepicker) text field reliably.
export async function setDateField(page, selector, value) {
  if (value == null) return;
  await evalJson(page, (a) => {
    const el = document.querySelector(a.selector);
    if (!el) return false;
    el.removeAttribute('readonly');
    el.value = a.value;
    for (const ev of ['input', 'change', 'keyup', 'blur']) el.dispatchEvent(new Event(ev, { bubbles: true }));
    return true;
  }, { selector, value: String(value) });
}

export async function selectValue(page, selector, value) {
  try {
    await page.selectOption(selector, String(value), { timeout: 5000 });
    return true;
  } catch {
    // fallback: match by option value OR visible label (case/space-insensitive), then dispatch change.
    // Covers cascading selects whose options arrive late, and label/value mismatches
    // (e.g. report 진행장소 options are code values like CD_25 with label "온라인(Webex)").
    return evalJson(page, (a) => {
      const el = document.querySelector(a.selector);
      if (!el) return false;
      const norm = (s) => String(s == null ? '' : s).trim().toLowerCase().replace(/\s+/g, '');
      const want = norm(a.value);
      const opt = [...el.options].find((o) => norm(o.value) === want || norm(o.text) === want)
        || [...el.options].find((o) => norm(o.text).includes(want) && want.length > 1);
      el.value = opt ? opt.value : a.value;
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return opt ? el.value === opt.value : el.value === a.value;
    }, { selector, value: String(value) });
  }
}

export async function setText(page, selector, value) {
  if (value == null) return;
  const loc = page.locator(selector).first();
  if ((await loc.count()) === 0) return;
  await loc.fill(String(value)).catch(async () => {
    await evalJson(page, (a) => {
      const el = document.querySelector(a.selector);
      if (el) { el.value = a.value; el.dispatchEvent(new Event('input', { bubbles: true })); }
      return true;
    }, { selector, value: String(value) });
  });
}

// Click the nearest "추가" button to an input (team / attendee / absentee / evidence rows).
export async function clickAddNear(page, inputSelector) {
  return evalJson(page, (inputSel) => {
    const inp = document.querySelector(inputSel);
    if (!inp) return false;
    let scope = inp.closest('li,td,div,p,dd,span') || inp.parentElement;
    for (let i = 0; i < 4 && scope; i++) {
      const btn = [...scope.querySelectorAll('a,button,input[type=button],input[type=submit]')]
        .find((b) => /추가/.test((b.textContent || b.value || '')));
      if (btn) { btn.click(); return true; }
      scope = scope.parentElement;
    }
    return false;
  }, inputSelector);
}

// DEXT5 editor content (mento body). Best-effort across API variants + iframe fallback.
export async function setEditorBody(page, id, html) {
  if (html == null) return;
  await evalJson(page, (a) => {
    try { if (window.DEXT5 && DEXT5.setBodyValue) { DEXT5.setBodyValue(a.html, a.id); return 'api'; } } catch (e) {}
    try { if (window.DEXT5 && DEXT5.SetBodyValue) { DEXT5.SetBodyValue(a.html, a.id); return 'api'; } } catch (e) {}
    const ta = document.querySelector('#' + a.id);
    if (ta) { ta.value = a.html; ta.dispatchEvent(new Event('change', { bubbles: true })); }
    const ifr = document.querySelector('#dext_frame_' + a.id);
    try { if (ifr && ifr.contentDocument && ifr.contentDocument.body) ifr.contentDocument.body.innerHTML = a.html; } catch (e) {}
    return 'fallback';
  }, { id, html });
}

function absFiles(files) {
  return (files || []).map((f) => resolve(PROJECT_ROOT, f));
}

// Attach N files into incrementally-added file rows (#file_1_1, #file_1_2, ...).
export async function attachFiles(page, region, files, { nameInputPrefix } = {}) {
  const list = absFiles(files);
  for (let i = 0; i < list.length; i++) {
    const fileSel = `#file_1_${i + 1}`;
    if (i > 0) {
      // add a new evidence/file row, then wait for the input
      const anchor = nameInputPrefix ? `#${nameInputPrefix}_${i}` : `#file_1_${i}`;
      await clickAddNear(page, anchor).catch(() => {});
      await page.waitForTimeout(300);
    }
    const loc = page.locator(fileSel);
    if ((await loc.count()) === 0) {
      throw new AsmError('UPLOAD_FAILED', `파일 입력란 ${fileSel} 을 찾지 못했습니다.`, { hint: '증빙/첨부 행 추가 버튼 동작을 recon 으로 재확인하세요.' });
    }
    await loc.setInputFiles(list[i]);
    await page.waitForTimeout(200);
  }
}

// Check a radio/checkbox robustly. The board uses custom-styled radios that Playwright
// considers "not visible", so .check() times out — fall back to a JS click that also
// fires the inline onclick/onchange handlers (e.g. 멘토링대상 -> 진행장소 옵션 로딩).
export async function checkRadio(page, selector) {
  const loc = page.locator(selector).first();
  if ((await loc.count()) === 0) return false;
  try {
    await loc.check({ force: true, timeout: 4000 });
  } catch {
    await evalJson(page, (s) => {
      const el = document.querySelector(s);
      if (!el) return false;
      el.checked = true;
      try { el.click(); } catch (e) {}
      el.checked = true;
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }, selector);
  }
  return true;
}

// Click a submit button, auto-accepting confirm/alert dialogs. Returns the dialog
// messages seen so callers can detect a success alert ("등록 되었습니다") even when the
// post-submit navigation is an AJAX redirect that leaves the URL on the insert page.
async function clickSubmit(page, selector) {
  const dialogs = [];
  const onDialog = (d) => { dialogs.push(d.message()); d.accept().catch(() => {}); };
  page.on('dialog', onDialog);
  const nav = page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => null);
  await page.locator(selector).first().click();
  await nav;
  await page.waitForTimeout(500);
  page.off('dialog', onDialog);
  return { dialogs };
}

// A submit succeeded if it navigated off the insert form OR a confirmation alert fired.
function submitSucceeded(finalUrl, dialogs) {
  if (/list\.do|report\.do/.test(finalUrl) || !/forInsert|insert\.do/.test(finalUrl)) return true;
  return (dialogs || []).some((m) => /등록|수정|저장|완료|되었습니다|성공/.test(String(m)) && !/하시겠습니까|필수|반드시|입력/.test(String(m)));
}

// ---- MENTO registration form ----
// payload: { category:'자유멘토링'|'멘토특강', method?:'온라인'|'오프라인'(busan),
//   title, receiptType:'before'|'direct', bgnDate,bgnTime, endDate?,endTime?,
//   eventDate, startTime, endTime, capacity, place, body? }
export async function fillMentoForm(page, region, payload, files, { preview, update } = {}) {
  const S = (k) => sel('mento', k, region);
  // 1. 강의구분
  if (payload.category) {
    const isLecture = /특강/.test(payload.category);
    await page.locator(isLecture ? S('catLecture') : S('catFree')).first().check().catch(() => {});
  }
  // 2. (부산) 진행방식 -> place 옵션 재로딩
  if (region === 'busan' && payload.method) {
    const online = /온라인/.test(payload.method);
    await page.locator(online ? S('methodOnline') : S('methodOffline')).first().check().catch(() => {});
    await page.waitForTimeout(600);
  }
  // 3. 모집명
  await setText(page, S('title'), payload.title);
  // 4. 접수기간
  if (payload.receiptType === 'direct') {
    await page.locator(S('receiptDirect')).first().check().catch(() => {});
    await setDateField(page, S('bgnDate'), payload.bgnDate);
    if (payload.bgnTime) await selectValue(page, S('bgnTime'), payload.bgnTime);
    await setDateField(page, S('endDate'), payload.endDate);
    if (payload.endTime) await selectValue(page, S('endTime'), payload.endTime);
  } else {
    await page.locator(S('receiptBefore')).first().check().catch(() => {});
    if (payload.bgnDate) await setDateField(page, S('bgnDate'), payload.bgnDate);
    if (payload.bgnTime) await selectValue(page, S('bgnTime'), payload.bgnTime);
  }
  // 5. 강의날짜
  await setDateField(page, S('eventDate'), payload.eventDate);
  if (payload.startTime) await selectValue(page, S('eventStime'), payload.startTime);
  if (payload.endTime) await selectValue(page, S('eventEtime'), payload.endTime);
  // 6. 수강인원
  if (payload.capacity != null) {
    await selectValue(page, S('applySelect1'), String(payload.capacity)).catch(() => {});
    await selectValue(page, S('applySelect2'), String(payload.capacity)).catch(() => {});
    await evalJson(page, (a) => { const el = document.querySelector(a.selq); if (el) { el.value = a.v; el.dispatchEvent(new Event('change', { bubbles: true })); } return true; }, { selq: S('applyCnt'), v: String(payload.capacity) });
  }
  // 7. 진행장소
  if (payload.place) await selectValue(page, S('place'), payload.place);
  // 8. 첨부
  if (files && files.length) await attachFiles(page, region, files);
  // 9. 본문
  if (payload.body) await setEditorBody(page, 'qestnarCn', payload.body);

  if (preview) {
    const shot = artifact(`mento-${region}-preview.png`);
    await page.screenshot({ path: shot, fullPage: true });
    return { filled: true, screenshot: shot, finalUrl: page.url() };
  }
  const { dialogs } = await clickSubmit(page, S('submitBtn'));
  const finalUrl = page.url();
  if (!submitSucceeded(finalUrl, dialogs)) {
    const shot = artifact(`mento-${region}-error.png`);
    await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
    throw new AsmError('WRITE_BLOCKED', '멘토링 등록 제출이 확인되지 않았습니다(검증 실패 가능).', { screenshot: shot, finalUrl, dialogs });
  }
  return { submitted: true, finalUrl };
}

// ---- REPORT form ----
// model: { menteeTarget, category, date, teamName?, place, attendees[], startTime, endTime,
//   excludeStart?, excludeEnd?, excludeReason?, subject, progress, mentorOpinion?, etc?, absentees[] }
export async function fillReportForm(page, region, m, evidenceFiles, { preview } = {}) {
  const S = (k) => sel('report', k);
  // 1. 멘토링 대상 -> progressPlace 옵션 로딩
  const busanMentee = /부산/.test(m.menteeTarget || '');
  await checkRadio(page, busanMentee ? S('regionBusan') : S('regionSeoul'));
  await page.waitForTimeout(700);
  // 2. 구분
  const cat = m.category || '';
  const gubunSel = /정규/.test(cat) ? S('gubunRegular') : /특강/.test(cat) ? S('gubunLecture') : S('gubunFree');
  await checkRadio(page, gubunSel);
  await page.waitForTimeout(200);
  // 3. 진행 날짜
  await setDateField(page, S('progressDate'), m.date);
  // 4. 팀명 (정규멘토링)
  if (/정규/.test(cat) && m.teamName) {
    await setText(page, S('teamInput'), m.teamName);
    await clickAddNear(page, S('teamInput'));
    await page.waitForTimeout(200);
  }
  // 5. 진행 장소
  if (m.place) await selectValue(page, S('place'), m.place);
  // 6. 참여 연수생 이름 (수는 자동)
  for (const name of m.attendees || []) {
    await setText(page, S('attendanceInput'), name);
    await clickAddNear(page, S('attendanceInput'));
    await page.waitForTimeout(200);
  }
  // 7. 진행 시간 (hour -> min cascade)
  const [sh, sm] = (m.startTime || '').split(':');
  const [eh, em] = (m.endTime || '').split(':');
  if (sh) { await selectValue(page, S('startHour'), sh); await page.waitForTimeout(200); await selectValue(page, S('startMin'), sm || '00'); }
  if (eh) { await selectValue(page, S('endHour'), eh); await page.waitForTimeout(200); await selectValue(page, S('endMin'), em || '00'); }
  // 8. 제외 시간 (optional)
  if (m.excludeStart) {
    const [xsh, xsm] = m.excludeStart.split(':'); const [xeh, xem] = (m.excludeEnd || '').split(':');
    await selectValue(page, S('exStartHour'), xsh); await page.waitForTimeout(150); await selectValue(page, S('exStartMin'), xsm || '00');
    if (xeh) { await selectValue(page, S('exEndHour'), xeh); await page.waitForTimeout(150); await selectValue(page, S('exEndMin'), xem || '00'); }
    if (m.excludeReason) await setText(page, S('exReason'), m.excludeReason);
  }
  // 9. 개요
  await setText(page, S('subject'), m.subject);
  await setText(page, S('nttCn'), m.progress);
  if (m.mentorOpinion) await setText(page, S('mentoOpn'), m.mentorOpinion);
  if (m.etc) await setText(page, S('etc'), m.etc);
  // 10. 무단불참자
  for (const name of m.absentees || []) {
    await setText(page, S('nonAttendanceInput'), name);
    await clickAddNear(page, S('nonAttendanceInput'));
    await page.waitForTimeout(150);
  }
  // 11. 증빙서류 (필수)
  if (!evidenceFiles || evidenceFiles.length === 0) {
    throw new AsmError('VALIDATION', '증빙서류가 필요합니다 (evidence 파일 1개 이상).');
  }
  await attachFiles(page, region, evidenceFiles, { nameInputPrefix: 'upload-name_file_1' });

  if (preview) {
    const shot = artifact('report-preview.png');
    await page.screenshot({ path: shot, fullPage: true });
    return { filled: true, screenshot: shot, finalUrl: page.url() };
  }
  const { dialogs } = await clickSubmit(page, S('submitBtn'));
  const finalUrl = page.url();
  if (!submitSucceeded(finalUrl, dialogs)) {
    const shot = artifact('report-error.png');
    await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
    throw new AsmError('WRITE_BLOCKED', '보고서 제출이 확인되지 않았습니다(검증 실패 가능).', { screenshot: shot, finalUrl, dialogs });
  }
  return { submitted: true, finalUrl };
}
