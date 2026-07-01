// stay.mjs — 부산 숙박예약 (swmaestro.ai/booking). A separate app from the main MY PAGE:
// own login form, own credentials, own session. Reuses the region abstraction
// (origin+prefix+storageState) via region key 'busan-stay', but does NOT reuse the
// shared session.mjs `login()`/`gotoGuarded()` — those are hardcoded to the main
// site's login-detection markers (`sel('common','loggedOutMarker')`,
// `/member/user/(loginForward|forLogin)\.do/`) and to a single global password, and
// they're the tested, high-criticality path for seoul/busan. Booking gets its own thin
// equivalents below instead of risking that shared code.
import { existsSync, mkdirSync, chmodSync } from 'node:fs';
import { loadConfig, SESSIONS_DIR } from '../env.mjs';
import { sel, url } from '../maps.mjs';
import { resolveSel } from '../resolve.mjs';
import { regionUrl, sessionFile } from '../session.mjs';
import { launchBrowser, newContext } from '../browser.mjs';
import { evalJson } from '../dom.mjs';
import { artifact } from '../widgets.mjs';
import { AsmError, log } from '../io.mjs';

const REGION = 'busan-stay';
const LOGIN_TIMEOUT = 45000;

function isStayLoginUrl(urlStr) {
  return /\/booking\/login\b/.test(urlStr || '');
}

// Heuristic for the one-time "비밀번호 생성" page shown right after first login. Exact
// copy/markup is unconfirmed pre-recon; matched broadly on the Korean phrasing the user
// described, refined once the live page has been inspected (see references/site-notes.md).
async function isPasswordCreatePage(page) {
  return evalJson(page, () => /비밀번호\s*(생성|변경|설정)/.test(document.body ? document.body.innerText : ''));
}

// Perform a real form login into the booking site in the given (existing) context, then
// persist storageState. Mirrors session.mjs `login()`'s shape/safety properties
// (Tier-2-only on selector breakage, no auto-heal for login/password-creation fields —
// wrong guesses here risk locking the real account) but is self-contained for `busan-stay`.
export async function stayLogin(context, state) {
  const { creds } = loadConfig();
  if (!creds.id) throw new AsmError('LOGIN_FAILED', 'missing ASM_HOMEPAGE_ID in .env');
  const page = await context.newPage();
  let alertText = null;
  page.on('dialog', async (d) => { alertText = d.message(); await d.dismiss().catch(() => {}); });
  try {
    const loginUrl = regionUrl(REGION, url('stay', 'login'));
    await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: LOGIN_TIMEOUT });

    // Password to try: explicit ASM_BUSAN_STAY_BOOKIN_PW override, else derive the
    // one-time temp password from the registered phone number's last 4 digits.
    let pw = creds.stayPw;
    if (!pw) {
      const { info } = await import('./member.mjs');
      const { profile } = await info({ region: 'busan', state: { path: null, reLoggedIn: false, autoHeal: state?.autoHeal !== false, healed: [] } });
      const digits = (profile.phone || '').replace(/\D/g, '');
      if (digits.length < 4) {
        throw new AsmError('VALIDATION', '최초 로그인 임시 비밀번호(연락처 뒤 4자리)를 확인하지 못했습니다.', {
          hint: '회원정보에 연락처가 등록되어 있는지 확인하거나 .env의 ASM_BUSAN_STAY_BOOKIN_PW 를 직접 설정하세요.',
        });
      }
      pw = digits.slice(-4);
    }

    try {
      await page.fill(sel('stay', 'username'), creds.id);
      await page.fill(sel('stay', 'password'), pw);
      const navP = page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: LOGIN_TIMEOUT }).catch(() => null);
      await page.click(sel('stay', 'submit'));
      await navP;
    } catch (e) {
      if (/timeout|waiting for|locator|no element|not find|strict mode|exceeded/i.test(e?.message || '')) {
        throw new AsmError('HEAL_NEEDED', '숙박예약 로그인 폼 셀렉터가 변경된 것으로 보입니다(수동 검토 필요).', {
          kind: 'login', region: REGION,
          hint: `asm recon --region ${REGION} --url "${url('stay', 'login')}" 로 확인 후 asm heal --apply --region ${REGION} --area stay (로그인은 자동 치유 안 함)`,
        });
      }
      throw e;
    }
    await page.waitForTimeout(400);

    // First-time login -> forced password creation. Per confirmed policy: the NEW
    // permanent password is exactly ASM_BUSAN_STAY_BOOKIN_PW — never invented/auto-
    // generated, since a wrong guess here is a real, hard-to-reverse account change.
    if (await isPasswordCreatePage(page)) {
      if (!creds.stayPw) {
        throw new AsmError('VALIDATION', '숙박예약 최초 비밀번호 생성이 필요하지만 ASM_BUSAN_STAY_BOOKIN_PW 가 비어 있습니다.', {
          hint: '.env 의 ASM_BUSAN_STAY_BOOKIN_PW 에 원하는 영구 비밀번호를 설정한 뒤 다시 시도하세요. 비밀번호를 임의로 만들거나 .env를 대신 수정하지 않습니다.',
        });
      }
      await page.fill(sel('stay', 'newPassword'), creds.stayPw);
      await page.fill(sel('stay', 'newPasswordConfirm'), creds.stayPw);
      const navP2 = page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: LOGIN_TIMEOUT }).catch(() => null);
      await page.click(sel('stay', 'newPasswordSubmit'));
      await navP2;
      await page.waitForTimeout(400);
    }

    if (isStayLoginUrl(page.url())) {
      throw new AsmError('LOGIN_FAILED', `숙박예약 로그인 실패${alertText ? ': ' + alertText : ''}`, {
        hint: 'ASM_HOMEPAGE_ID / ASM_BUSAN_STAY_BOOKIN_PW(또는 연락처 뒤4자리)를 확인하세요.',
      });
    }
    mkdirSync(SESSIONS_DIR, { recursive: true });
    await context.storageState({ path: sessionFile(REGION) });
    try { chmodSync(sessionFile(REGION), 0o600); } catch {}
    if (state) state.reLoggedIn = true;
    log(`[session] logged in: ${REGION}`);
  } finally {
    await page.close().catch(() => {});
  }
}

// goto with a one-shot re-login on expiry (booking-specific: detection is by URL shape,
// not the main site's menuNo/loggedOutMarker machinery, so this does not reuse
// session.mjs `gotoGuarded()`).
export async function gotoStay(page, relPath, state) {
  await page.goto(regionUrl(REGION, relPath), { waitUntil: 'domcontentloaded' });
  if (isStayLoginUrl(page.url())) {
    await stayLogin(page.context(), state);
    await page.goto(regionUrl(REGION, relPath), { waitUntil: 'domcontentloaded' });
    if (isStayLoginUrl(page.url())) {
      throw new AsmError('SESSION_EXPIRED', '부산 숙박예약 재로그인에 실패했습니다.', {
        hint: 'ASM_BUSAN_STAY_BOOKIN_PW 값을 확인하세요.',
      });
    }
  }
  return page;
}

// Run a browser task within a freshly-prepared, session-loaded 'busan-stay' context.
// Mirrors session.mjs `withSession()` but logs in via `stayLogin` when no session exists.
async function withStaySession(fn, { state = {} } = {}) {
  state.path = 'browser';
  const browser = await launchBrowser();
  try {
    const ctx = await newContext(browser, sessionFile(REGION));
    if (!existsSync(sessionFile(REGION))) {
      await stayLogin(ctx, state);
    }
    const page = await ctx.newPage();
    const result = await fn({ browser, ctx, page, state });
    await ctx.storageState({ path: sessionFile(REGION) }).catch(() => {});
    return result;
  } finally {
    await browser.close().catch(() => {});
  }
}

export async function login(ctx) {
  const { state } = ctx;
  const browser = await launchBrowser();
  try {
    const context = await newContext(browser, sessionFile(REGION));
    await stayLogin(context, state);
  } finally {
    await browser.close().catch(() => {});
  }
  return { loggedIn: true, region: REGION };
}

// ---- DOM scrapers (structural, hardcoded CSS — mirrors room.mjs's discoverRooms/readSlots
// pattern: grid/list scraping isn't a single load-bearing element, so it isn't routed
// through selectors.json/resolveSel; a site redesign here needs a fresh recon + code
// update rather than self-heal). All confirmed against the live site 2026-07-01.

// select[name=branchId] options, shared by both the apply page and the reservations page.
async function scrapeBranches(page) {
  return (await evalJson(page, () => {
    const s = document.querySelector('select[name=branchId]');
    if (!s) return [];
    return [...s.options].filter((o) => o.value).map((o) => ({ id: o.value, name: o.textContent.trim() }));
  })) || [];
}

function resolveBranchId(branches, want) {
  if (!want) return '';
  const hit = branches.find((b) => b.name.includes(want) || want.includes(b.name));
  return hit ? hit.id : want; // fall back to the raw value (caller may already have an id)
}

// One entry per (date, branch) apply card on the "/" apply screen.
async function scrapeAvailability(page) {
  return (await evalJson(page, () => {
    const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const out = [];
    document.querySelectorAll('table.app-table').forEach((table) => {
      const card = table.closest('.card');
      const dateLabel = card ? norm(card.querySelector('.card-header')?.textContent) : null;
      table.querySelectorAll('tbody tr').forEach((tr) => {
        const cells = [...tr.querySelectorAll('td')];
        const form = tr.querySelector('form[id^="apply-"]');
        const btn = tr.querySelector('button.booking-apply-btn');
        const field = (name) => (form ? form.querySelector(`input[name=${name}]`)?.value || null : null);
        out.push({
          dateLabel,
          date: field('reservationDate'),
          branch: norm(cells[0]?.textContent),
          branchId: field('branchId'),
          remaining: norm(cells[1]?.textContent),
          applyable: !!(form && btn),
          formId: form ? form.id : null,
        });
      });
    });
    return out;
  })) || [];
}

// Reservation history rows on "/reservations".
async function scrapeReservations(page) {
  return (await evalJson(page, () => {
    const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const out = [];
    document.querySelectorAll('table').forEach((table) => {
      const headers = [...table.querySelectorAll('thead th')].map((th) => norm(th.textContent));
      if (!headers.includes('숙박 날짜')) return;
      table.querySelectorAll('tbody tr').forEach((tr) => {
        const cells = [...tr.querySelectorAll('td')];
        const cancelBtn = tr.querySelector('button.booking-cancel-btn');
        const form = cancelBtn ? document.getElementById(cancelBtn.getAttribute('data-form-id') || '') : null;
        const hidden = {};
        if (form) form.querySelectorAll('input[type=hidden]').forEach((inp) => {
          if (inp.name && inp.name !== '_csrf') hidden[inp.name] = inp.value;
        });
        out.push({
          date: norm(cells[0]?.textContent),
          branch: norm(cells[1]?.textContent),
          status: norm(cells[2]?.textContent),
          appliedAt: norm(cells[3]?.textContent),
          cancelable: !!cancelBtn,
          cancelFormId: form ? form.id : null,
          ...hidden,
        });
      });
    });
    return out;
  })) || [];
}

async function scrapeProfile(page) {
  return (await evalJson(page, () => {
    const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const dl = document.querySelector('dl.row');
    if (!dl) return {};
    const dts = [...dl.querySelectorAll('dt')];
    const dds = [...dl.querySelectorAll('dd')];
    const out = {};
    dts.forEach((dt, i) => { out[norm(dt.textContent)] = norm(dds[i]?.textContent); });
    return out;
  })) || {};
}

// ---- commands ----

export async function availability(ctx) {
  const { flags, state } = ctx;
  const month = flags.month; // YYYY-MM, defaults to current month shown by the site
  const branchName = flags.branch;
  if (month && !/^\d{4}-\d{2}$/.test(month)) throw new AsmError('VALIDATION', 'stay-availability --month 은 YYYY-MM 형식이어야 합니다.');
  return withStaySession(async ({ page }) => {
    const qs = [];
    if (month) { const [y, m] = month.split('-'); qs.push(`year=${y}`, `month=${Number(m)}`); }
    await gotoStay(page, url('stay', 'home') + (qs.length ? `?${qs.join('&')}` : ''), state);
    if (branchName) {
      const branches = await scrapeBranches(page);
      const branchId = resolveBranchId(branches, branchName);
      if (branchId) await gotoStay(page, `${url('stay', 'home')}?${[...qs, `branchId=${branchId}`].join('&')}`, state);
    }
    const days = await scrapeAvailability(page);
    return { region: REGION, month: month || null, branch: branchName || null, dayCount: days.length, days };
  }, { state });
}

export async function list(ctx) {
  const { flags, state } = ctx;
  const month = flags.month; // YYYY-MM
  const branchName = flags.branch;
  const status = flags.status; // REQUESTED|APPROVED|CANCELED|REJECTED
  return withStaySession(async ({ page }) => {
    await gotoStay(page, url('stay', 'reservations'), state);
    const qs = [];
    if (month) qs.push(`month=${encodeURIComponent(month)}`);
    if (status) qs.push(`status=${encodeURIComponent(status)}`);
    if (branchName) {
      const branches = await scrapeBranches(page);
      const branchId = resolveBranchId(branches, branchName);
      if (branchId) qs.push(`branchId=${encodeURIComponent(branchId)}`);
    }
    if (qs.length) await gotoStay(page, `${url('stay', 'reservations')}?${qs.join('&')}`, state);
    const reservations = await scrapeReservations(page);
    return { region: REGION, month: month || null, branch: branchName || null, status: status || null, count: reservations.length, reservations };
  }, { state });
}

export async function profile(ctx) {
  const { state } = ctx;
  return withStaySession(async ({ page }) => {
    await gotoStay(page, url('stay', 'profile'), state);
    const raw = await scrapeProfile(page);
    return {
      region: REGION,
      profile: {
        type: raw['구분'] || null,
        name: raw['이름'] || null,
        email: raw['이메일'] || null,
        phone: raw['전화번호'] || null,
        agency: raw['소속'] || null,
        workplace: raw['근무지'] || null,
      },
    };
  }, { state });
}

// Click a booking-apply-btn / booking-cancel-btn (both use the same SweetAlert2
// confirmAction() flow: click -> popup -> click .swal2-confirm -> the popup submits the
// button's associated <form>). Scoped to a specific form so the (page-wide) button class
// resolves to the right one; resolveSel still lets the class itself self-heal-detect.
async function clickConfirmAction(page, formId, btnKey, ctx) {
  const btnCss = await resolveSel(page, 'stay', btnKey, undefined, ctx.heal);
  await page.locator(`#${formId}`).locator(btnCss).first().click();
  await page.waitForSelector('.swal2-popup', { timeout: 8000 });
  const confirmCss = await resolveSel(page, 'stay', 'modalConfirmBtn', undefined, ctx.heal);
  const nav = page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => null);
  await page.locator(confirmCss).first().click();
  await nav;
}

export async function reserve(ctx) {
  const { flags, payload, state, preview } = ctx;
  const p = payload || {};
  const date = flags.date || p.date; // YYYY-MM-DD
  const branchName = flags.branch || p.branch;
  if (!date) throw new AsmError('VALIDATION', 'stay-reserve requires --date YYYY-MM-DD');
  if (!branchName) throw new AsmError('VALIDATION', 'stay-reserve requires --branch (예: "부산역1점" 또는 "서면점")');

  return withStaySession(async ({ page }) => {
    const [y, m] = date.split('-');
    await gotoStay(page, `${url('stay', 'home')}?year=${y}&month=${Number(m)}`, state);
    const days = await scrapeAvailability(page);
    const hit = days.find((d) => d.date === date && (d.branch || '').includes(branchName));
    if (!hit) {
      throw new AsmError('VALIDATION', `${date} ${branchName} 예약 카드를 찾지 못했습니다(예약 가능 기간/요일이 아닐 수 있습니다 — 금·토/토·일만 가능).`, {
        available: days.map((d) => ({ date: d.date, branch: d.branch, applyable: d.applyable })),
      });
    }
    if (!hit.applyable) throw new AsmError('WRITE_BLOCKED', `${date} ${hit.branch} 은 신청할 수 없습니다(잔여 없음 등).`, { remaining: hit.remaining });

    if (preview) {
      const shot = artifact('stay-reserve-preview.png');
      await page.screenshot({ path: shot, fullPage: true });
      return { preview: true, region: REGION, date, branch: hit.branch, remaining: hit.remaining, screenshot: shot };
    }

    await clickConfirmAction(page, hit.formId, 'applyBtn', ctx);
    const finalUrl = page.url();
    if (!/\/booking\/reservations/.test(finalUrl)) {
      const shot = artifact('stay-reserve-error.png');
      await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
      throw new AsmError('WRITE_BLOCKED', '숙박 예약 신청이 확인되지 않았습니다.', { screenshot: shot, finalUrl });
    }
    return { applied: true, region: REGION, date, branch: hit.branch, finalUrl };
  }, { state });
}

export async function cancel(ctx) {
  const { flags, state, preview } = ctx;
  const date = flags.date;
  const branchName = flags.branch;
  if (!date || !branchName) throw new AsmError('VALIDATION', 'stay-cancel requires --date YYYY-MM-DD --branch <지점>');

  return withStaySession(async ({ page }) => {
    await gotoStay(page, url('stay', 'reservations'), state);
    const reservations = await scrapeReservations(page);
    const hit = reservations.find((r) => r.date === date && (r.branch || '').includes(branchName) && r.cancelable);
    if (!hit) {
      throw new AsmError('VALIDATION', `취소 가능한 ${date} ${branchName} 예약을 찾지 못했습니다.`, {
        reservations: reservations.map((r) => ({ date: r.date, branch: r.branch, status: r.status, cancelable: r.cancelable })),
      });
    }

    if (preview) {
      const shot = artifact('stay-cancel-preview.png');
      await page.screenshot({ path: shot, fullPage: true });
      return { preview: true, region: REGION, date, branch: hit.branch, status: hit.status, screenshot: shot };
    }

    await clickConfirmAction(page, hit.cancelFormId, 'cancelBtn', ctx);
    return { cancelled: true, region: REGION, date, branch: hit.branch };
  }, { state });
}

export { withStaySession, REGION };
