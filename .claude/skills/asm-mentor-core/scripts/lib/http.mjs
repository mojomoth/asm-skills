// http.mjs — authenticated direct HTTP (the fast "API-first" path). Reuses the
// JSESSIONID cookie from the region's storageState and transparently re-logins via
// the browser when the server signals an expired session.
import { readFileSync, existsSync } from 'node:fs';
import { sessionFile, regionUrl, regionBase, relogin } from './session.mjs';
import { AsmError, log } from './io.mjs';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';
const MAX_REDIRECTS = 6;

function loadCookieHeader(region, targetUrl) {
  const f = sessionFile(region);
  if (!existsSync(f)) return '';
  let ss;
  try { ss = JSON.parse(readFileSync(f, 'utf8')); } catch { return ''; }
  const u = new URL(targetUrl);
  const matches = (ss.cookies || []).filter((c) => {
    const dom = (c.domain || '').replace(/^\./, '');
    const domOk = u.hostname === dom || u.hostname.endsWith('.' + dom) || dom.endsWith(u.hostname);
    const pathOk = u.pathname.startsWith(c.path || '/');
    return domOk && pathOk;
  });
  return matches.map((c) => `${c.name}=${c.value}`).join('; ');
}

function isAuthRedirect(res) {
  if (![301, 302, 303, 307, 308].includes(res.status)) return false;
  const loc = res.headers.get('location') || '';
  return /loginForward|forLogin/.test(loc);
}

function looksLikeLoginHtml(body) {
  return /id=["']login_form["']|name=["']username["']\s|actionLogin\(/.test(body || '');
}

async function rawFetch(region, fullUrl, opts = {}) {
  const cookie = loadCookieHeader(region, fullUrl);
  const headers = {
    'User-Agent': UA,
    'Accept-Language': 'ko-KR,ko;q=0.9',
    Accept: opts.accept || 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
    ...(opts.headers || {}),
  };
  if (cookie) headers['Cookie'] = cookie;
  return fetch(fullUrl, { redirect: 'manual', method: opts.method || 'GET', body: opts.body, headers });
}

// Follow non-auth redirects manually; surface auth redirects to the caller.
async function fetchFollow(region, fullUrl, opts = {}) {
  let current = fullUrl;
  let res = await rawFetch(region, current, opts);
  let hops = 0;
  while ([301, 302, 303, 307, 308].includes(res.status) && hops < MAX_REDIRECTS) {
    if (isAuthRedirect(res)) return { res, current, authRedirect: true };
    const loc = res.headers.get('location');
    if (!loc) break;
    current = new URL(loc, current).toString();
    // a redirect after POST becomes a GET (303/302 convention)
    const followOpts = res.status === 307 || res.status === 308 ? opts : { headers: opts.headers, accept: opts.accept };
    res = await rawFetch(region, current, followOpts);
    hops++;
  }
  return { res, current, authRedirect: false };
}

// Authenticated GET returning { status, url, body, headers }. Re-logins once on expiry.
export async function httpGet(region, relPath, { state = {}, accept } = {}) {
  state.path = 'http';
  const fullUrl = regionUrl(region, relPath);
  let { res, current, authRedirect } = await fetchFollow(region, fullUrl, { accept });
  let body = authRedirect ? '' : await res.text();
  if (authRedirect || looksLikeLoginHtml(body)) {
    log(`[http] session expired for ${region}; re-logging in`);
    await relogin(region, state);
    ({ res, current, authRedirect } = await fetchFollow(region, fullUrl, { accept }));
    if (authRedirect) throw new AsmError('SESSION_EXPIRED', 're-login retry failed (GET)');
    body = await res.text();
    if (looksLikeLoginHtml(body)) throw new AsmError('SESSION_EXPIRED', 're-login retry returned login page (GET)');
  }
  return { status: res.status, url: current, body, headers: res.headers };
}

// Authenticated POST (form-encoded by default). Re-logins once on expiry.
export async function httpPost(region, relPath, params, { state = {}, json = false, headers = {} } = {}) {
  state.path = 'http';
  const fullUrl = regionUrl(region, relPath);
  const body = json ? JSON.stringify(params) : new URLSearchParams(params).toString();
  const ct = json ? 'application/json' : 'application/x-www-form-urlencoded; charset=UTF-8';
  const opts = { method: 'POST', body, headers: { 'Content-Type': ct, 'X-Requested-With': 'XMLHttpRequest', ...headers } };
  let { res, current, authRedirect } = await fetchFollow(region, fullUrl, opts);
  if (authRedirect) {
    await relogin(region, state);
    ({ res, current, authRedirect } = await fetchFollow(region, fullUrl, opts));
    if (authRedirect) throw new AsmError('SESSION_EXPIRED', 're-login retry failed (POST)');
  }
  const text = await res.text();
  return { status: res.status, url: current, body: text, headers: res.headers };
}

// Probe whether the region session is currently valid, without writing anything.
export async function probeSession(region, probePath, { state = {} } = {}) {
  state.path = 'http';
  const fullUrl = regionUrl(region, probePath);
  const { res, authRedirect } = await fetchFollow(region, fullUrl, {});
  if (authRedirect) return { valid: false };
  const body = await res.text();
  return { valid: !looksLikeLoginHtml(body) && res.status < 400 };
}

export { regionBase };
