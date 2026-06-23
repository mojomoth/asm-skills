// heal/urlheal.mjs — URL re-discovery via the stable ?menuNo key.
//
// eGov paths can change (mentoLec/list.do -> board/mentoLec.do) but the menuNo query
// param is the durable identity of a MY PAGE menu. When a mapped URL drifts, we crawl
// the left-nav anchors of ANY working authenticated mypage page, find the anchor whose
// href carries the SAME menuNo, convert it to a region-relative path, validate it loads
// (200, not login, menuNo present), and persist it to the override layer.
import { url, urlDesc, setOverride } from '../maps.mjs';
import { regionBase, regionUrl, isLoginPage, gotoGuarded } from '../session.mjs';
import { parse, qparam } from '../parse.mjs';
import { evalJson } from '../dom.mjs';
import { AsmError, log } from '../io.mjs';

const AUTO_URL_CONF = 0.8;
// bootstrap pages to read the nav from — try in order until one loads authenticated.
const BOOTSTRAP = [['probe', null], ['notices', 'list'], ['schedule', null], ['member', null]];

function menuNoOf(s) { return qparam(s, 'menuNo'); }
function doFileOf(path) {
  const m = String(path || '').split('?')[0].match(/([^/]+\.do)$/i);
  return m ? m[1].toLowerCase() : null;
}

function originOf(region) { try { return new URL(regionBase(region)).origin; } catch { return ''; } }
function prefixOf(region) { try { return new URL(regionBase(region)).pathname.replace(/\/$/, ''); } catch { return ''; } }

// Absolute or root-relative href -> region-relative path (strip origin + region prefix).
function toRelative(region, href) {
  if (!href) return null;
  try {
    const abs = new URL(href, originOf(region) + '/');
    let path = abs.pathname + abs.search;
    const prefix = prefixOf(region);
    if (prefix && path.startsWith(prefix + '/')) path = path.slice(prefix.length);
    else if (prefix && path === prefix) path = '/';
    return path || null;
  } catch { return null; }
}

function anchorsFromHtml(html) {
  const root = parse(html);
  const out = [];
  for (const a of root.querySelectorAll('a')) {
    const href = a.getAttribute('href') || '';
    const onclick = a.getAttribute('onclick') || '';
    const m = menuNoOf(href) || menuNoOf(onclick);
    if (m) out.push({ menuNo: m, href: href || onclick, text: (a.text || '').trim().slice(0, 40) });
  }
  return out;
}

async function anchorsFromPage(page) {
  return (await evalJson(page, () => {
    const out = [];
    for (const a of document.querySelectorAll('a')) {
      const href = a.getAttribute('href') || '';
      const onclick = a.getAttribute('onclick') || '';
      const m = (href + ' ' + onclick).match(/[?&]menuNo=(\d+)/);
      if (m) out.push({ menuNo: m[1], href: href || onclick, text: (a.innerText || a.textContent || '').trim().slice(0, 40) });
    }
    return out;
  })) || [];
}

// Pick the best candidate path for the expected menuNo among crawled anchors.
function pickCandidate(region, anchors, expectMenuNo, expectDoFile) {
  const matches = anchors.filter((a) => a.menuNo === String(expectMenuNo));
  const paths = [...new Set(matches.map((a) => toRelative(region, a.href)).filter(Boolean))];
  if (!paths.length) return null;
  if (paths.length === 1) return { path: paths[0], confidence: 0.9 };
  // multiple distinct paths share this menuNo -> tie-break by the old .do filename
  if (expectDoFile) {
    const byDo = paths.find((p) => doFileOf(p) === expectDoFile);
    if (byDo) return { path: byDo, confidence: 0.85 };
  }
  return { path: paths[0], confidence: 0.7 }; // ambiguous -> below auto threshold
}

// Validate the discovered path actually loads as an authenticated, correct page.
async function validatePath(region, path, expectMenuNo, { page, state }) {
  if (page) {
    try {
      await gotoGuarded(page, region, regionUrl(region, path), state);
      const u = page.url();
      if (isLoginPage(u)) return false;
      const reflected = menuNoOf(u);
      return reflected == null || reflected === String(expectMenuNo);
    } catch { return false; }
  }
  // fetch surface (reads): import lazily to avoid import cycles; no area/key so no recursive drift detection.
  const { httpGet } = await import('../http.mjs');
  try {
    const r = await httpGet(region, path, { state });
    if (r.status >= 400) return false;
    if (isLoginPage(r.url) || /id=["']login_form["']|name=["']username["']/.test(r.body)) return false;
    return true;
  } catch { return false; }
}

async function readNavAnchors(region, { page, state }) {
  // browser: try bootstraps via the live page; fetch: GET bootstrap HTML.
  for (const [area, key] of BOOTSTRAP) {
    let rel;
    try { rel = url(area, key); } catch { continue; }
    if (page) {
      try {
        await gotoGuarded(page, region, regionUrl(region, rel), state);
        if (isLoginPage(page.url())) continue;
        const anchors = await anchorsFromPage(page);
        if (anchors.length) return anchors;
      } catch { /* try next bootstrap */ }
    } else {
      try {
        const { httpGet } = await import('../http.mjs');
        const r = await httpGet(region, rel, { state });
        if (r.status >= 400 || isLoginPage(r.url)) continue;
        const anchors = anchorsFromHtml(r.body);
        if (anchors.length) return anchors;
      } catch { /* try next bootstrap */ }
    }
  }
  return [];
}

// Re-discover and persist the region-relative path for area.key. Returns
// { path, confidence, old } on success; throws HEAL_NEEDED when it can't be done confidently.
export async function healUrl({ region, area, key, page, state = {} }) {
  const old = (() => { try { return url(area, key); } catch { return null; } })();
  const dsc = urlDesc(area, key) || {};
  const expectMenuNo = dsc.menuNo || menuNoOf(old);
  const expectDoFile = dsc.doFile || doFileOf(old);
  if (!expectMenuNo) {
    throw new AsmError('HEAL_NEEDED', `URL drift for ${area}.${key || ''} but no stable menuNo to re-discover it`, {
      area, key: key || null, region, kind: 'url', old, hint: 'add {path,menuNo,doFile} to references/urls.json, or asm heal --apply --url',
    });
  }

  const anchors = await readNavAnchors(region, { page, state });
  if (!anchors.length) {
    throw new AsmError('HEAL_NEEDED', `URL drift for ${area}.${key || ''}: could not read MY PAGE nav to re-discover menuNo ${expectMenuNo}`, {
      area, key: key || null, region, kind: 'url', old, expectMenuNo,
    });
  }

  const cand = pickCandidate(region, anchors, expectMenuNo, expectDoFile);
  if (!cand || cand.confidence < AUTO_URL_CONF) {
    throw new AsmError('HEAL_NEEDED', `URL drift for ${area}.${key || ''}: menuNo ${expectMenuNo} not confidently re-located`, {
      area, key: key || null, region, kind: 'url', old, expectMenuNo,
      candidates: anchors.filter((a) => a.menuNo === String(expectMenuNo)).map((a) => toRelative(region, a.href)).filter(Boolean),
    });
  }

  const okLoad = await validatePath(region, cand.path, expectMenuNo, { page, state });
  if (!okLoad) {
    throw new AsmError('HEAL_NEEDED', `URL candidate for ${area}.${key || ''} (${cand.path}) failed validation`, {
      area, key: key || null, region, kind: 'url', old, candidate: cand.path,
    });
  }

  const persisted = setOverride({
    kind: 'urls', area, key: key || null, value: cand.path,
    prov: { confidence: cand.confidence, expectMenuNo, doFile: expectDoFile, source: 'tier1-auto', reconRef: null },
  });
  log(`[heal] url ${area}.${key || ''}: ${old} -> ${cand.path} (conf ${cand.confidence}, persisted=${persisted})`);
  return { path: cand.path, confidence: cand.confidence, old, persisted };
}
