// heal/index.mjs — the self-heal orchestrator for SELECTOR breakage.
// Flow: session-guard (caller-confirmed) -> anti-loop (in-process Set + cross-process
// ledger) -> live DOM inventory -> match -> validate on the consume surface -> persist
// + return the new css, OR throw a Tier-2 HEAL_NEEDED carrying PII-scrubbed evidence.
// URL heal lives in ./urlheal.mjs; this module is selectors only.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RECON_DIR } from '../env.mjs';
import { desc, selOpt, selLayer, setOverride } from '../maps.mjs';
import { isLoginPage } from '../session.mjs';
import { AsmError, log } from '../io.mjs';
import { rankCandidates, decide } from './match.mjs';
import { synthesizeSelector, validateUnique } from './validate.mjs';
import { ledgerBlocked, ledgerBump, appendLog } from './store.mjs';

// In-process guard: each `asm` invocation is a fresh process, so this Set caps a key
// to ONE heal attempt per process (a second detection re-throws rather than looping).
const healedThisProcess = new Set();

const trunc = (s, n) => (s == null ? null : String(s).slice(0, n));

function scrubField(f) {
  return { tag: f.tag, type: f.type || null, name: f.name || null, id: f.id || null, form: f.form || null, required: f.required || null, label: trunc(f.label, 40) };
}
function scrubButton(b) {
  return { tag: b.tag, text: trunc(b.text, 30), onclick: trunc(b.onclick, 60) };
}
// Emitted candidate list: structural facets only (drop option text/labels that could carry mentee PII).
function scrubCandidates(ranked, isField, n = 4) {
  return ranked.slice(0, n).map((r) => ({ ...(isField ? scrubField(r.field) : scrubButton(r.field)), score: r.score, signals: r.signals }));
}

// Persist the FULL dump locally (not emitted) for Claude/operator inspection in Tier-2.
function saveDumpArtifact(region, area, key, dump) {
  try {
    const dir = join(RECON_DIR, region || 'seoul');
    mkdirSync(dir, { recursive: true });
    const p = join(dir, `heal-${(area || 'x')}-${(key || 'x')}.json`.replace(/[^a-z0-9.\-_]/gi, '_'));
    writeFileSync(p, JSON.stringify(dump, null, 2));
    return p;
  } catch { return null; }
}

// Build a node-html-parser root into a match-compatible dump (read surface). Reads
// rarely use selectors.json, so this is a best-effort fallback for Tier-2 evidence.
function dumpFromRoot(root) {
  const fields = [];
  const buttons = [];
  if (!root) return { fields, buttons };
  const labelFor = (el) => {
    const id = el.getAttribute('id');
    if (id) { const l = root.querySelector(`label[for="${id}"]`); if (l) return (l.text || '').trim().slice(0, 80); }
    return null;
  };
  for (const el of root.querySelectorAll('input,select,textarea')) {
    const tag = el.tagName.toLowerCase();
    const f = { tag, type: el.getAttribute('type') || (tag === 'select' ? 'select-one' : null), name: el.getAttribute('name') || null, id: el.getAttribute('id') || null, label: labelFor(el), form: null, value: el.getAttribute('value') || null };
    if (tag === 'select') f.options = el.querySelectorAll('option').map((o) => ({ value: o.getAttribute('value') || '', text: (o.text || '').trim() })).slice(0, 80);
    fields.push(f);
  }
  for (const el of root.querySelectorAll('a,button')) {
    buttons.push({ tag: el.tagName.toLowerCase(), text: (el.text || '').trim().slice(0, 60), onclick: el.getAttribute('onclick') || null, href: el.getAttribute('href') || null });
  }
  return { fields, buttons };
}

function buildHealNeeded({ area, key, region, dsc, oldCss, ranked, isField, reason, decision, reconRef }) {
  const candidates = ranked ? scrubCandidates(ranked, isField) : [];
  // Record the escalation so `asm heal --report` can replay it for Claude/operator.
  appendLog({ event: 'heal-needed', kind: 'selector', area, key, region: region || null, reason, candidates, reconRef: reconRef || null });
  return new AsmError('HEAL_NEEDED', `selector ${area}.${key}${region ? ' [' + region + ']' : ''} appears broken (${reason}); needs review`, {
    kind: 'selector', area, key, region: region || null, reason,
    old: oldCss || null,
    descriptor: dsc || null,
    confidence: decision ? decision.confidence : 0,
    margin: decision ? decision.margin : 0,
    candidates,
    reconRef: reconRef || null,
    hint: `inspect reconRef, then: asm heal --apply --region ${region || 'seoul'} --area ${area} --json '{"${key}":"<new-css>"}'`,
  });
}

// Heal one selector key. Returns the new css string on a confident, validated, persisted
// (or in-memory) heal; throws AsmError('HEAL_NEEDED') to escalate to Claude/Tier-2.
export async function healSelector(ctx, { area, key, region, page, root }) {
  const id = `${region || '-'}:${area}:${key}`;
  const oldCss = selOpt(area, key, region);
  const dsc = desc(area, key, region);

  // Defensive session guard — a login page must never enter the matcher.
  if (page && isLoginPage(page.url())) {
    throw new AsmError('SESSION_EXPIRED', 'on login page during heal; re-login first', { area, key });
  }
  // No descriptor -> cannot autonomously heal; escalate.
  if (!dsc) {
    throw buildHealNeeded({ area, key, region, dsc: null, oldCss, reason: 'no-descriptor' });
  }
  // In-process: one heal attempt per key per process.
  if (healedThisProcess.has(id)) {
    throw buildHealNeeded({ area, key, region, dsc, oldCss, reason: 'already-attempted' });
  }
  // Cross-invocation ledger: cap + cooldown gate a flapping site (skip the expensive dump).
  const blocked = ctx.force ? { blocked: false } : ledgerBlocked(region, area, key);
  if (blocked.blocked) {
    throw buildHealNeeded({ area, key, region, dsc, oldCss, reason: blocked.reason });
  }
  healedThisProcess.add(id);

  const isField = !dsc.tag || ['input', 'select', 'textarea'].includes(dsc.tag);
  let dump;
  if (page) {
    const { dumpArea } = await import('../recon.mjs');
    dump = await dumpArea(page);
  } else {
    dump = dumpFromRoot(root);
  }
  const ranked = rankCandidates(dump, dsc);
  const decision = decide(ranked);
  const reconRef = saveDumpArtifact(region, area, key, dump);

  const css = decision.top ? synthesizeSelector(decision.top.field, dsc) : null;
  const autoHeal = ctx.autoHeal !== false;
  const critical = dsc.criticality === 'high';

  if (autoHeal && !critical && decision.action === 'auto' && css) {
    const ok = await validateUnique(css, { page, root, consume: dsc.consume || 'both', desc: dsc });
    if (ok) {
      const layer = selLayer(area, key, region);
      const persisted = setOverride({
        kind: 'selectors', area, layer, key, value: css,
        prov: { confidence: decision.confidence, margin: decision.margin, evidence: decision.top.signals, source: 'tier1-auto', reconRef },
      });
      log(`[heal] selector ${id}: ${oldCss} -> ${css} (conf ${decision.confidence}, margin ${decision.margin}, persisted=${persisted})`);
      return { css, confidence: decision.confidence, margin: decision.margin, old: oldCss, persisted, layer };
    }
  }

  // Escalate: criticality, low confidence/margin, validation failure, or auto-heal off.
  // Count the attempt ONLY on escalation (cap+cooldown throttle a key that keeps FAILING —
  // a successful heal persists an override and never re-triggers, so it must not be counted).
  ledgerBump(region, area, key);
  const reason = !autoHeal ? 'auto-heal-off' : critical ? 'criticality-high' : decision.action !== 'auto' ? 'low-confidence' : 'validation-failed';
  throw buildHealNeeded({ area, key, region, dsc, oldCss, ranked, isField, reason, decision, reconRef });
}

// Test/diagnostic helper.
export { dumpFromRoot, scrubCandidates };
