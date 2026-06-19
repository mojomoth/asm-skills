// parse.mjs — HTML parsing helpers for the HTTP (API-first) read path.
import { parse as parseHTML } from 'node-html-parser';

export function parse(html) {
  return parseHTML(html || '', { blockTextElements: { script: false, style: false, pre: true } });
}

export function clean(s) {
  return (s || '').replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
}

export function unent(s) {
  return (s || '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
}

// Pull a query param out of an href/onclick string.
export function qparam(str, name) {
  const m = unent(str || '').match(new RegExp('[?&]' + name + '=([^&\'"\\)\\s]+)'));
  return m ? decodeURIComponent(m[1]) : null;
}

// First <table> whose header cells contain ALL keywords.
export function findTable(root, keywords) {
  for (const t of root.querySelectorAll('table')) {
    const headStr = t.querySelectorAll('th, thead td').map((c) => clean(c.text)).join(' ');
    if (keywords.every((k) => headStr.includes(k))) return t;
  }
  return null;
}

export function rowsOf(table) {
  if (!table) return [];
  const body = table.querySelector('tbody') || table;
  return body.querySelectorAll('tr')
    .map((tr) => ({
      cells: tr.querySelectorAll('td,th').map((td) => clean(td.text)),
      links: tr.querySelectorAll('a').map((a) => ({ text: clean(a.text), href: a.getAttribute('href') || '', onclick: a.getAttribute('onclick') || '' })),
    }))
    .filter((r) => r.cells.length);
}

// View pages render "<strong class="t">label</strong> value" pairs. Returns {label: value}.
export function strongPairs(root) {
  const out = {};
  for (const st of root.querySelectorAll('strong.t')) {
    const label = clean(st.text).replace(/\s+/g, ' ');
    const parent = st.parentNode;
    if (!parent) continue;
    let val = clean(parent.text);
    if (val.startsWith(label)) val = val.slice(label.length).trim();
    out[label.replace(/\s+/g, '')] = val; // key without inner spaces: "모집 명" -> "모집명"
  }
  return out;
}

// The board "view" container used across notice/report/fund detail pages.
export function viewBox(root) {
  return root.querySelector('.bbs-view, .bbs_view, .board_view, .view_cont, .bbsView');
}

// Extract {title, date, author, attachments[], body} from a board view page.
export function viewDetail(root) {
  const box = viewBox(root) || root;
  const titleEl = box.querySelector('.tit, .subject, .view_tit, h3, h4');
  const title = titleEl ? clean(titleEl.text) : null;
  const txt = clean(box.text);
  const dateM = txt.match(/등록일\s*[:：]?\s*([\d.\-]{8,10}(?:\s[\d:]+)?)/);
  const authorM = txt.match(/작성자\s*[:：]?\s*([^\s]+(?:\s?[^\s]+)?)/);
  const attachments = box.querySelectorAll('a')
    .map((a) => ({ name: clean(a.text), href: a.getAttribute('href') || '' }))
    .filter((a) => /\.(hwp|hwpx|xlsx?|docx?|pptx?|pdf|zip|jpg|png|gif)(\?|$)/i.test(a.name) || /download|fileDown|atch/i.test(a.href));
  return { title, date: dateM ? dateM[1] : null, author: authorM ? authorM[1] : null, attachments, body: txt };
}

// Heuristic main content body text (notice/mento/report bodies).
export function bodyText(root) {
  const sels = ['.bbs-view', '.view_cont', '.bbs_cont', '.board_view', '.cont_view', '.view_con', '.editor_view', 'td.cont', '.bbsView', '.view_box'];
  for (const s of sels) {
    const el = root.querySelector(s);
    if (el && clean(el.text).length > 10) return clean(el.text);
  }
  // fallback: longest <div> text under #container/#content
  let best = '';
  for (const d of root.querySelectorAll('#container div, #content div, .sub_content div')) {
    const t = clean(d.text);
    if (t.length > best.length && t.length < 5000) best = t;
  }
  return best;
}

// "2026.06.01 19:00시 ~ 21:00시" -> { date:'2026-06-01', start:'19:00', end:'21:00' }
export function parseDateTimeRange(s) {
  const str = s || '';
  const d = str.match(/(\d{4})[.\-/](\d{1,2})[.\-/](\d{1,2})/);
  const times = [...str.matchAll(/(\d{1,2})\s*[:시]\s*(\d{2})/g)].map((m) => `${m[1].padStart(2, '0')}:${m[2]}`);
  return {
    date: d ? `${d[1]}-${d[2].padStart(2, '0')}-${d[3].padStart(2, '0')}` : null,
    start: times[0] || null,
    end: times[1] || null,
  };
}
