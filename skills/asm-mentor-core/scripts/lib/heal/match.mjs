// heal/match.mjs — PURE selector re-location scorer. Given a recon DOM dump and a
// semantic descriptor, rank the dump's elements by how confidently each is the element
// the descriptor refers to. No I/O, no browser — fully unit-testable on JSON fixtures.
//
// Philosophy: ids are the VOLATILE thing that breaks; names (eGov server params),
// Korean labels, option sets, button text and radio values are STABLE. Hard gates
// prevent category errors (never match a radio to a text box); weighted signals score
// the rest; a dual confidence+margin threshold decides auto-heal vs escalate-to-Claude.

export const AUTO_CONF = 0.78;   // top candidate must clear this absolute confidence
export const AUTO_MARGIN = 0.20; // ...AND beat the runner-up by this much

const FIELD_TAGS = new Set(['input', 'select', 'textarea']);
const CATEGORY_TYPES = new Set(['radio', 'checkbox', 'file', 'hidden']);

const W = {
  name: 0.55,        // HTML name attr = eGov server param: the most stable, authoritative signal
  labelExact: 0.30,
  labelPartial: 0.15,
  optionSet: 0.30,
  btnText: 0.50,
  onclick: 0.30,
  radioValue: 0.30,  // decisive disambiguator within a same-name radio/checkbox group
  idStem: 0.10,
  form: 0.15,        // scoping form id separates main form from the shared team/calendar widgets
  nearText: 0.10,
  type: 0.10,
  required: 0.05,
};

export function normLabel(s) {
  if (!s) return '';
  let t = String(s).normalize('NFC');
  t = t.replace(/[*✱]+/g, '');                 // required markers
  t = t.replace(/[([（][^)）\]]*[)）\]]/g, '');   // parentheticals/brackets
  t = t.replace(/[:：]/g, '');                  // colons
  t = t.replace(/\s+/g, '');                    // ALL whitespace — Korean labels are space-insensitive
  return t.toLowerCase();                        // latin lowercased; Korean unaffected
}

const norm = (s) => String(s == null ? '' : s).trim().toLowerCase().replace(/\s+/g, '');

// type category — radio/checkbox/file/hidden are category-changing (hard gate);
// everything else (text/email/number/tel/password/null/...) collapses to 'text'.
function category(type) {
  const t = (type || '').toLowerCase();
  return CATEGORY_TYPES.has(t) ? t : 'text';
}

// id "stem": strip trailing digits/index suffixes so qustnrSj / qustnrSj2 compare equal-ish.
function idStem(id) {
  return norm((id || '').replace(/[_-]?\d+$/, ''));
}

function optionOverlap(descSet, options) {
  if (!Array.isArray(descSet) || !descSet.length || !Array.isArray(options) || !options.length) return 0;
  const have = new Set();
  for (const o of options) { have.add(norm(o.value)); have.add(norm(o.text)); }
  let hit = 0;
  for (const want of descSet) if (have.has(norm(want))) hit++;
  return hit / descSet.length;
}

// Score a single field candidate against a field descriptor. Returns {score, signals}
// or null if a hard gate rejects it.
function scoreField(cand, desc) {
  // HARD GATE 1: tag
  if (desc.tag && cand.tag !== desc.tag) return null;
  // HARD GATE 2: type category (never cross radio<->text, etc.)
  if (desc.type && category(desc.type) !== category(cand.type)) return null;

  const signals = {};
  let score = 0;
  if (desc.name && cand.name && norm(desc.name) === norm(cand.name)) { score += W.name; signals.name = W.name; }

  if (desc.label) {
    const dl = normLabel(desc.label);
    const cl = normLabel(cand.label);
    if (dl && cl && dl === cl) { score += W.labelExact; signals.label = W.labelExact; }
    else if (dl && cl && (cl.includes(dl) || dl.includes(cl))) { score += W.labelPartial; signals.label = W.labelPartial; }
  }

  if (desc.optionSet) {
    const f = optionOverlap(desc.optionSet, cand.options);
    if (f > 0) { const s = +(W.optionSet * f).toFixed(4); score += s; signals.optionSet = s; }
  }

  if (desc.value != null && cand.value != null && norm(desc.value) === norm(cand.value)) { score += W.radioValue; signals.value = W.radioValue; }

  // id===name on eGov is common; reward a stem match to either name or old descriptor hint.
  if (cand.id && desc.name && idStem(cand.id) === idStem(desc.name)) { score += W.idStem; signals.idStem = W.idStem; }

  if (desc.form && cand.form && norm(desc.form) === norm(cand.form)) { score += W.form; signals.form = W.form; }

  if (desc.nearText && cand.label && normLabel(cand.label).includes(normLabel(desc.nearText))) { score += W.nearText; signals.nearText = W.nearText; }

  if (desc.type && (desc.type || '').toLowerCase() === (cand.type || '').toLowerCase()) { score += W.type; signals.type = W.type; }

  if (desc.required && cand.required) { score += W.required; signals.required = W.required; }

  return { score, signals }; // RAW (unclamped) so margins between strong matches survive
}

// Score a button/anchor candidate against a button descriptor (tag is NOT hard-gated —
// the same action can be an <a> or <button>; text + onclick carry the signal).
function scoreButton(cand, desc) {
  const signals = {};
  let score = 0;
  if (desc.btnText) {
    const want = normLabel(desc.btnText);
    const have = normLabel(cand.text);
    if (want && have && have === want) { score += W.btnText; signals.btnText = W.btnText; }
    else if (want && have && have.includes(want)) { const inc = +(W.btnText * 0.6).toFixed(4); score += inc; signals.btnText = inc; }
  }
  if (desc.onclick && cand.onclick && norm(cand.onclick).includes(norm(desc.onclick))) { score += W.onclick; signals.onclick = W.onclick; }
  if (desc.tag && cand.tag === desc.tag) { score += 0.05; signals.tag = 0.05; }
  return score > 0 ? { score, signals } : null;
}

// Rank all candidate elements in the dump for this descriptor (descending score).
export function rankCandidates(dump, desc) {
  if (!dump || !desc) return [];
  const isField = !desc.tag || FIELD_TAGS.has(desc.tag);
  const pool = isField ? (dump.fields || []) : (dump.buttons || []);
  const scorer = isField ? scoreField : scoreButton;
  const ranked = [];
  for (const cand of pool) {
    const r = scorer(cand, desc);
    if (r) ranked.push({ field: cand, score: +r.score.toFixed(4), signals: r.signals });
  }
  ranked.sort((a, b) => b.score - a.score);
  return ranked;
}

// Decide whether the ranking is confident enough to auto-persist or must escalate.
// confidence is clamped to [0,1]; margin uses RAW scores so a decisive winner isn't
// flattened by the clamp.
export function decide(ranked, { autoConf = AUTO_CONF, autoMargin = AUTO_MARGIN } = {}) {
  const top = ranked[0] || null;
  const second = ranked[1] || null;
  const raw = top ? top.score : 0;
  const confidence = Math.min(1, raw);
  const margin = top ? raw - (second ? second.score : 0) : 0;
  const action = top && confidence >= autoConf && margin >= autoMargin ? 'auto' : 'escalate';
  return { action, top, second, confidence: +confidence.toFixed(4), margin: +margin.toFixed(4) };
}
