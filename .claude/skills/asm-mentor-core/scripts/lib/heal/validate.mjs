// heal/validate.mjs — anti-poisoning gate. Turns a matched candidate into a concrete
// CSS selector and PROVES that selector resolves to exactly ONE element that still
// matches the descriptor, ON THE SAME SURFACE it will be consumed on (Playwright
// locator vs in-page querySelector vs node-html-parser root). A candidate that does
// not validate is HARD-REJECTED and never persisted.
import { evalJson } from '../dom.mjs';
import { normLabel } from './match.mjs';

const norm = (s) => String(s == null ? '' : s).trim().toLowerCase().replace(/\s+/g, '');
const CATEGORY_TYPES = new Set(['radio', 'checkbox', 'file', 'hidden']);
const category = (t) => (CATEGORY_TYPES.has((t || '').toLowerCase()) ? (t || '').toLowerCase() : 'text');
const hasTextPseudo = (css) => /:has-text\(|:text\(/i.test(css || '');

function cssAttr(v) { return String(v).replace(/(["\\])/g, '\\$1'); }
function safeIdSel(id) { return /^[A-Za-z_][\w-]*$/.test(id) ? `#${id}` : `[id="${cssAttr(id)}"]`; }
function quoteText(t) { return String(t).replace(/(['\\])/g, '\\$1'); }

// Build the most robust CSS for a candidate. ids are preferred (matches the existing
// selectors.json convention); fall back to form/name(+value) composites, then button
// text / onclick. Returns null when nothing identifying is available.
export function synthesizeSelector(cand, desc = {}) {
  if (!cand) return null;
  const tag = cand.tag || desc.tag || '*';
  if (cand.id) return safeIdSel(cand.id);
  if (cand.name) {
    let s = `${tag}[name="${cssAttr(cand.name)}"]`;
    if ((cand.type === 'radio' || cand.type === 'checkbox') && cand.value != null) s += `[value="${cssAttr(cand.value)}"]`;
    return s;
  }
  if (tag === 'a' || tag === 'button') {
    if (cand.text) return `${tag}:has-text('${quoteText(cand.text)}')`;
    if (cand.onclick) {
      const fn = (String(cand.onclick).match(/([A-Za-z_]\w*)\s*\(/) || [])[1];
      if (fn) return `${tag}[onclick*="${fn}"]`;
    }
  }
  return null;
}

function reMatchFacts(info, desc) {
  if (!info) return false;
  if (!desc) return true;
  if (desc.name && info.name && norm(desc.name) !== norm(info.name)) return false;
  if (desc.type && info.type && category(desc.type) !== category(info.type)) return false;
  if (desc.value != null && info.value != null && norm(desc.value) !== norm(info.value)) return false;
  if (desc.btnText && info.text && !normLabel(info.text).includes(normLabel(desc.btnText))) return false;
  if (desc.onclick && info.onclick && !norm(info.onclick).includes(norm(desc.onclick))) return false;
  return true;
}

// node-html-parser element -> facts
function reMatchNode(el, desc) {
  return reMatchFacts({
    name: el.getAttribute('name') || null,
    type: el.getAttribute('type') || null,
    value: el.getAttribute('value') || null,
    text: (el.text || '').trim(),
    onclick: el.getAttribute('onclick') || null,
  }, desc);
}

// live page (querySelector surface) -> facts (string-in/string-out via evalJson)
async function reMatchPage(page, css, desc) {
  const info = await evalJson(page, (a) => {
    const el = document.querySelector(a.css);
    if (!el) return null;
    return {
      tag: el.tagName.toLowerCase(), type: (el.getAttribute('type') || '').toLowerCase(),
      name: el.getAttribute('name') || null, value: el.value != null ? String(el.value) : (el.getAttribute('value') || null),
      text: (el.innerText || el.textContent || '').trim().slice(0, 120), onclick: el.getAttribute('onclick') || null,
    };
  }, { css });
  return reMatchFacts(info, desc);
}

// live page (locator surface) -> facts via getAttribute/textContent (no evaluate)
async function reMatchLocator(page, css, desc) {
  const loc = page.locator(css).first();
  const info = {
    name: await loc.getAttribute('name').catch(() => null),
    type: await loc.getAttribute('type').catch(() => null),
    value: await loc.getAttribute('value').catch(() => null),
    onclick: await loc.getAttribute('onclick').catch(() => null),
    text: ((await loc.textContent().catch(() => '')) || '').trim(),
  };
  return reMatchFacts(info, desc);
}

// Validate that css resolves to exactly one descriptor-matching element on the surface
// it will be consumed on. consume: 'locator' | 'querySelector' | 'both' (default).
export async function validateUnique(css, { page, root, consume = 'both', desc } = {}) {
  if (!css) return false;
  const textSel = hasTextPseudo(css);

  // READ surface: a parsed-HTML root, no live page.
  if (root && !page) {
    if (textSel) return false; // :has-text cannot be evaluated on node-html-parser
    let els;
    try { els = root.querySelectorAll(css); } catch { return false; }
    if (!els || els.length !== 1) return false;
    return reMatchNode(els[0], desc);
  }

  if (!page) return false;

  // WRITE surface: text pseudo or explicitly locator-consumed -> Playwright locator.
  if (textSel || consume === 'locator') {
    let n;
    try { n = await page.locator(css).count(); } catch { return false; }
    if (n !== 1) return false;
    return reMatchLocator(page, css, desc);
  }

  // querySelector / both -> in-page querySelectorAll count.
  const n = await evalJson(page, (a) => document.querySelectorAll(a.css).length, { css });
  if (n !== 1) return false;
  return reMatchPage(page, css, desc);
}
