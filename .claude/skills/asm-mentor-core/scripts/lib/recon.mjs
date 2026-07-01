// recon.mjs — reconnaissance: log in, navigate to a target page, and dump its
// forms / inputs / selects+options / buttons(onclick) / hidden fields + raw HTML +
// full-page screenshot + a HAR of network traffic. Output feeds selectors.json /
// endpoints.json. Re-run whenever the site changes.
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { RECON_DIR } from './env.mjs';
import { launchBrowser, newContext } from './browser.mjs';
import { login, sessionFile, regionUrl, gotoGuarded, isLoginPage } from './session.mjs';
import { url } from './maps.mjs';
import { evalJson } from './dom.mjs';
import { AsmError, log } from './io.mjs';

// area -> region-relative URL (pages that need an id are reached via --url)
function targetFor(area) {
  const map = {
    login: url('login'),
    notices: url('notices', 'list'),
    schedule: url('schedule'),
    team: url('team'),
    'mento-list': url('mento', 'list'),
    'mento-insert': url('mento', 'insert'),
    'report-list': url('report', 'list'),
    'report-insert': url('report', 'insert'),
    'fund-project': url('fund', 'project'),
    'fund-device': url('fund', 'device'),
    'room-list': url('room', 'list'),
    'rent-list': url('room', 'rentList'),
    member: url('member'),
  };
  return map[area];
}

// Runs IN THE BROWSER. Inventories the page DOM for selector/endpoint mapping.
// Exported so the healer can re-run the same inventory on a live page (via evalJson)
// without a separate navigation. MUST stay self-contained (no closure refs).
/* eslint-disable */
export function pageDump() {
  const text = (el) => (el ? (el.innerText || el.textContent || '').trim().slice(0, 150) : null);
  const labelFor = (el) => {
    if (el.id) {
      const l = document.querySelector('label[for="' + (window.CSS && CSS.escape ? CSS.escape(el.id) : el.id) + '"]');
      if (l) return text(l);
    }
    const lab = el.closest('label');
    if (lab) return text(lab);
    const cell = el.closest('th,td,div,li');
    return cell ? text(cell).slice(0, 80) : null;
  };
  const forms = [...document.querySelectorAll('form')].map((f) => ({
    id: f.id || null, name: f.name || null, action: f.getAttribute('action'), method: f.getAttribute('method'),
  }));
  const fields = [...document.querySelectorAll('input,select,textarea')].map((el) => {
    const form = el.closest('form');
    const o = {
      tag: el.tagName.toLowerCase(), type: el.type || null, name: el.name || null, id: el.id || null,
      required: el.required || el.getAttribute('aria-required') === 'true' || null, label: labelFor(el),
      form: (form && (form.id || form.name)) || null,
    };
    if (el.tagName.toLowerCase() === 'select') {
      o.options = [...el.options].map((op) => ({ value: op.value, text: (op.text || '').trim() })).slice(0, 80);
    }
    // radio/checkbox value disambiguates same-name groups (MRC010 vs MRC020, menteeRegionCd_0/_1)
    if (el.type === 'radio' || el.type === 'checkbox') o.value = el.value || null;
    if (el.type === 'hidden') { o.hidden = true; o.value = (el.value || '').slice(0, 40); }
    return o;
  });
  const buttons = [...document.querySelectorAll('button,a.btn,a.button,input[type=button],input[type=submit],a[onclick]')]
    .map((b) => ({ tag: b.tagName.toLowerCase(), text: text(b), onclick: b.getAttribute('onclick'), href: b.getAttribute('href'), cls: b.className || null }))
    .filter((b) => b.text || b.onclick);
  const editors = {
    ckeditor: typeof window.CKEDITOR !== 'undefined',
    tinymce: typeof window.tinymce !== 'undefined',
    smarteditor: typeof window.oEditors !== 'undefined',
    summernote: !!document.querySelector('.note-editor,.summernote'),
    iframes: [...document.querySelectorAll('iframe')].map((f) => ({ id: f.id, name: f.name, title: f.title })),
  };
  const allScript = [...document.querySelectorAll('script')].map((s) => s.textContent || '').join('\n');
  const jsFns = [...new Set(allScript.match(/function\s+(fn_[A-Za-z0-9_]+|action[A-Za-z0-9_]+|go[A-Za-z0-9_]+)/g) || [])].slice(0, 80);
  // tables: capture header + first data row to understand list columns
  const tables = [...document.querySelectorAll('table')].slice(0, 4).map((t) => ({
    headers: [...t.querySelectorAll('thead th, thead td')].map((c) => text(c)),
    firstRow: [...(t.querySelector('tbody tr')?.querySelectorAll('td') || [])].map((c) => text(c)),
    rowCount: t.querySelectorAll('tbody tr').length,
  }));
  return { url: location.href, title: document.title, forms, fields, buttons, editors, jsFns, tables };
}
/* eslint-enable */

// Inventory the CURRENT live page (no navigation) for the healer. String-in/string-out
// via evalJson (the site poisons by-value serialization). Returns a safe empty shape on failure.
export async function dumpArea(page) {
  const dump = await evalJson(page, pageDump);
  return dump || { url: page.url(), title: null, forms: [], fields: [], buttons: [], editors: {}, jsFns: [], tables: [] };
}

export async function recon({ region, area, rawUrl, state = {} }) {
  state.path = 'browser';
  const rel = rawUrl || targetFor(area);
  if (!rel) throw new AsmError('VALIDATION', `unknown recon area: ${area}. Use --url <relpath> or a known --area.`);
  const outDir = join(RECON_DIR, region);
  mkdirSync(outDir, { recursive: true });
  const slug = (area || 'page').replace(/[^a-z0-9-]/gi, '_');
  const harPath = join(outDir, `${slug}.har`);

  const browser = await launchBrowser();
  try {
    const ctx = await newContext(browser, sessionFile(region), { recordHar: { path: harPath, content: 'embed' } });
    if (!existsSync(sessionFile(region))) await login(ctx, region, state);
    const page = await ctx.newPage();
    const xhr = [];
    page.on('requestfinished', async (req) => {
      try {
        const rt = req.resourceType();
        if (rt === 'xhr' || rt === 'fetch') {
          const resp = await req.response();
          xhr.push({ method: req.method(), url: req.url(), post: (req.postData() || '').slice(0, 400), status: resp ? resp.status() : null });
        }
      } catch {}
    });
    const full = regionUrl(region, rel);
    if (area === 'login') await page.goto(full, { waitUntil: 'domcontentloaded' });
    else await gotoGuarded(page, region, full, state);
    await page.waitForTimeout(1200);

    const dump = await evalJson(page, pageDump);
    dump.loggedIn = !isLoginPage(page.url());
    dump.xhr = xhr;

    const htmlPath = join(outDir, `${slug}.html`);
    const shotPath = join(outDir, `${slug}.png`);
    const jsonPath = join(outDir, `${slug}.json`);
    writeFileSync(htmlPath, await page.content(), 'utf8');
    await page.screenshot({ path: shotPath, fullPage: true }).catch(() => {});
    writeFileSync(jsonPath, JSON.stringify(dump, null, 2), 'utf8');
    await ctx.storageState({ path: sessionFile(region) }).catch(() => {});
    await ctx.close().catch(() => {}); // flush HAR

    log(`[recon] ${region}/${slug}: ${dump.forms.length} forms, ${dump.fields.length} fields, ${xhr.length} xhr`);
    return {
      area: area || rel, region, pageUrl: dump.url, title: dump.title, loggedIn: dump.loggedIn,
      forms: dump.forms, fieldCount: dump.fields.length, buttons: dump.buttons, editors: dump.editors,
      jsFns: dump.jsFns, tables: dump.tables, xhr,
      artifacts: { html: htmlPath, screenshot: shotPath, json: jsonPath, har: harPath },
    };
  } finally {
    await browser.close().catch(() => {});
  }
}
