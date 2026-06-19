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

export async function hasLoginForm(page) {
  try {
    return (await page.locator(sel('common', 'loggedOutMarker')).count()) > 0;
  } catch {
    return false;
  }
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
    await page.fill(sel('login', 'username'), creds.id);
    await page.fill(sel('login', 'password'), creds.pw);
    const navP = page
      .waitForNavigation({ waitUntil: 'domcontentloaded', timeout: LOGIN_TIMEOUT })
      .catch(() => null);
    await page.click(sel('login', 'submit'));
    await navP;
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

// goto with transparent one-shot re-login on expiry.
export async function gotoGuarded(page, region, fullUrl, state) {
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
