// session.mjs — per-region session lifecycle: login, storageState IO, guarded
// navigation with transparent re-login. Seoul & Busan share the host + JSESSIONID
// path, so each region MUST use its own context + its own storageState file.
import { mkdirSync, existsSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, SESSIONS_DIR } from './env.mjs';
import { launchBrowser, newContext } from './browser.mjs';
import { AsmError, log } from './io.mjs';
import { url, sel } from './maps.mjs';

const LOGIN_TIMEOUT = 45000;

export function sessionFile(region) {
  return join(SESSIONS_DIR, `storageState-${region}.json`);
}

export function regionBase(region) {
  const { regions } = loadConfig();
  const r = regions[region];
  if (!r) throw new AsmError('VALIDATION', `unknown region: ${region} (use seoul|busan)`);
  return r.origin + r.prefix;
}

// Build a full URL from a region-relative path (e.g. "/mypage/...").
export function regionUrl(region, relPath) {
  return regionBase(region) + relPath;
}

export function isLoginPage(urlStr) {
  return /\/member\/user\/(loginForward|forLogin)\.do/.test(urlStr || '');
}

export function menuNoOf(urlStr) {
  const m = String(urlStr || '').match(/[?&]menuNo=(\d+)/);
  return m ? m[1] : null;
}

export async function hasLoginForm(page) {
  try {
    return (await page.locator(sel('common', 'loggedOutMarker')).count()) > 0;
  } catch {
    return false;
  }
}

// Best-effort dump of the login page for Tier-2 review when the login form changed.
// Lazy imports avoid a static cycle (recon.mjs imports this module).
async function dumpLogin(page, region) {
  try {
    const { pageDump } = await import('./recon.mjs');
    const { evalJson } = await import('./dom.mjs');
    const { RECON_DIR } = await import('./env.mjs');
    const { mkdirSync, writeFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const dump = await evalJson(page, pageDump);
    const dir = join(RECON_DIR, region || 'seoul');
    mkdirSync(dir, { recursive: true });
    const p = join(dir, 'heal-login.json');
    writeFileSync(p, JSON.stringify(dump || {}, null, 2));
    return p;
  } catch { return null; }
}

// Perform a real form login in the given context (refreshes the per-load csrfToken),
// then persist storageState. state.reLoggedIn is set so the caller can report it.
export async function login(context, region, state) {
  const { creds } = loadConfig();
  if (!creds.id || !creds.pw) {
    throw new AsmError('LOGIN_FAILED', 'missing ASM_HOMEPAGE_ID / ASM_HOMEPAGE_PW in .env');
  }
  const loginUrl = regionUrl(region, url('login'));
  const page = await context.newPage();
  let alertText = null;
  page.on('dialog', async (d) => {
    alertText = d.message();
    await d.dismiss().catch(() => {});
  });
  try {
    await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: LOGIN_TIMEOUT });
    try {
      await page.fill(sel('login', 'username'), creds.id);
      await page.fill(sel('login', 'password'), creds.pw);
      const navP = page
        .waitForNavigation({ waitUntil: 'domcontentloaded', timeout: LOGIN_TIMEOUT })
        .catch(() => null);
      await page.click(sel('login', 'submit'));
      await navP;
    } catch (e) {
      // A fill/click that can't find its element means the LOGIN FORM selectors changed.
      // This is Tier-2 ONLY (never auto-healed) — a wrong guess here risks account lockout.
      if (/timeout|waiting for|locator|no element|not find|strict mode|exceeded/i.test(e?.message || '')) {
        const reconRef = await dumpLogin(page, region);
        throw new AsmError('HEAL_NEEDED', '로그인 폼 셀렉터가 변경된 것으로 보입니다(수동 검토 필요).', {
          kind: 'login', region, reconRef,
          hint: 'asm recon --area login 으로 확인 후 asm heal --apply --area login (자동 치유 안 함 — 계정 잠금 위험)',
        });
      }
      throw e;
    }
    await page.waitForTimeout(400);
    if (isLoginPage(page.url()) || (await hasLoginForm(page))) {
      throw new AsmError('LOGIN_FAILED', `login rejected${alertText ? ': ' + alertText : ''}`, {
        hint: 'verify ASM_HOMEPAGE_ID / ASM_HOMEPAGE_PW, or the login form may have changed — run recon --area login',
      });
    }
    mkdirSync(SESSIONS_DIR, { recursive: true });
    await context.storageState({ path: sessionFile(region) });
    try { chmodSync(sessionFile(region), 0o600); } catch {}
    if (state) state.reLoggedIn = true;
    log(`[session] logged in: ${region}`);
  } finally {
    await page.close().catch(() => {});
  }
}

// Launch a throwaway browser purely to (re)login and refresh storageState. Used by
// the HTTP layer when it detects an expired session.
export async function relogin(region, state) {
  const browser = await launchBrowser();
  try {
    const ctx = await newContext(browser, sessionFile(region));
    await login(ctx, region, state);
  } finally {
    await browser.close().catch(() => {});
  }
}

// goto with transparent one-shot re-login on expiry, then optional URL self-heal.
// opts: { area, key } — when set, after auth is confirmed, verify we landed on the
// intended page (stable menuNo / HTTP status); on drift, re-discover the URL via menuNo
// and navigate to the healed path. Session-expiry is always handled FIRST so it never
// masquerades as URL breakage. state.autoHeal === false disables URL heal.
export async function gotoGuarded(page, region, fullUrl, state, opts = {}) {
  let resp = await page.goto(fullUrl, { waitUntil: 'domcontentloaded' });
  if (isLoginPage(page.url()) || (await hasLoginForm(page))) {
    await login(page.context(), region, state);
    resp = await page.goto(fullUrl, { waitUntil: 'domcontentloaded' });
    if (isLoginPage(page.url()) || (await hasLoginForm(page))) {
      throw new AsmError('SESSION_EXPIRED', 're-login retry failed after navigation', {
        hint: 'check credentials / site availability',
      });
    }
  }
  // URL drift detection (authenticated). menuNo is the stable identity of a MY PAGE menu.
  if (opts.area && state?.autoHeal !== false) {
    const expect = menuNoOf(fullUrl);
    const landed = menuNoOf(page.url());
    const status = resp ? resp.status() : 200;
    const drifted = status >= 400 || (expect && landed && landed !== expect);
    if (drifted) {
      const { healUrl } = await import('./heal/urlheal.mjs'); // throws HEAL_NEEDED if unresolvable
      const r = await healUrl({ region, area: opts.area, key: opts.key, page, state });
      resp = await page.goto(regionUrl(region, r.path), { waitUntil: 'domcontentloaded' });
      if (Array.isArray(state?.healed)) state.healed.push({ area: opts.area, key: opts.key, kind: 'url', old: r.old, new: r.path, confidence: r.confidence });
    }
  }
  return resp;
}

// Run a browser task within a freshly-prepared, session-loaded context.
// fn receives { browser, ctx, page, region, state }.
export async function withSession(region, fn, { forceLogin = false, state = {}, contextOpts = {} } = {}) {
  if (state.path === undefined) state.path = 'browser';
  state.path = 'browser';
  const browser = await launchBrowser();
  try {
    const ctx = await newContext(browser, sessionFile(region), contextOpts);
    if (forceLogin || !existsSync(sessionFile(region))) {
      await login(ctx, region, state);
    }
    const page = await ctx.newPage();
    const result = await fn({ browser, ctx, page, region, state });
    await ctx.storageState({ path: sessionFile(region) }).catch(() => {});
    return result;
  } finally {
    await browser.close().catch(() => {});
  }
}
