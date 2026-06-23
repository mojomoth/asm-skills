// heal/store.mjs — persistence for the self-heal subsystem. Browser-free and
// dependency-light so it can be unit-tested in isolation.
//
// Files (under HEAL_DIR = STATE_DIR/heal, gitignored runtime cache):
//   overrides.json     — the healed selector/url/endpoint values merged over references/
//   heal-log.jsonl     — append-only provenance trail (one JSON object per line)
//   heal-attempts.json — cross-invocation ledger {region:area:key -> {attempts,lastTs,cooldownUntil}}
//
// Writes are atomic (temp file + rename) and guarded by a best-effort O_EXCL lockfile,
// because Claude may invoke `asm` in parallel. On lock contention or an unwritable
// state dir the write is SKIPPED (returns false) — the caller keeps the healed value
// in memory for the current op and escalates persistence to Tier-2 rather than racing.
import {
  mkdirSync, readFileSync, writeFileSync, appendFileSync, renameSync,
  existsSync, openSync, closeSync, unlinkSync, statSync,
} from 'node:fs';
import { join } from 'node:path';
import { HEAL_DIR } from '../env.mjs';
import { log } from '../io.mjs';

const F_OVERRIDES = () => join(HEAL_DIR, 'overrides.json');
const F_LOG = () => join(HEAL_DIR, 'heal-log.jsonl');
const F_LEDGER = () => join(HEAL_DIR, 'heal-attempts.json');
const F_LOCK = () => join(HEAL_DIR, '.lock');

const LOCK_STALE_MS = 10_000;
const KINDS = ['selectors', 'urls', 'endpoints'];

function isObj(x) { return x != null && typeof x === 'object' && !Array.isArray(x); }

function ensureDir() {
  try { mkdirSync(HEAL_DIR, { recursive: true }); return true; } catch { return false; }
}

export function canPersist() { return ensureDir(); }

function readJson(path, fallback) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; }
}

function atomicWrite(path, obj) {
  const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  writeFileSync(tmp, JSON.stringify(obj, null, 2));
  renameSync(tmp, path);
}

// Bounded synchronous lock acquire; steals a stale lock; returns false if it can't.
function acquireLock() {
  if (!ensureDir()) return false;
  const lp = F_LOCK();
  for (let i = 0; i < 40; i++) {
    try {
      const fd = openSync(lp, 'wx');
      try { writeFileSync(fd, `${process.pid}`); } catch {}
      closeSync(fd);
      return true;
    } catch {
      try {
        const st = statSync(lp);
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) { unlinkSync(lp); continue; }
      } catch { /* lock vanished — retry */ }
      const until = Date.now() + 25;
      while (Date.now() < until) { /* brief spin */ }
    }
  }
  return false;
}

function releaseLock() { try { unlinkSync(F_LOCK()); } catch {} }

// ---- overrides -------------------------------------------------------------
export function loadOverrides() {
  const o = readJson(F_OVERRIDES(), {});
  return { selectors: o.selectors || {}, urls: o.urls || {}, endpoints: o.endpoints || {} };
}

// Persist one healed value at overrides[kind].<...path> and append provenance.
// Returns true if written to disk, false if skipped (unwritable / lock contention).
export function persistOverride({ kind, path, value, prov = {} }) {
  if (!KINDS.includes(kind) || !Array.isArray(path) || !path.length) return false;
  if (!acquireLock()) {
    log(`[heal] persist skipped (state dir unwritable or locked): ${kind} ${path.join('.')}`);
    return false;
  }
  try {
    const o = readJson(F_OVERRIDES(), {});
    if (!isObj(o[kind])) o[kind] = {};
    let node = o[kind];
    for (let i = 0; i < path.length - 1; i++) {
      const k = path[i];
      if (!isObj(node[k])) node[k] = {};
      node = node[k];
    }
    node[path[path.length - 1]] = value;
    atomicWrite(F_OVERRIDES(), o);
  } finally {
    releaseLock();
  }
  appendLog({ kind, path, value, ...prov });
  return true;
}

// ---- provenance log --------------------------------------------------------
export function appendLog(entry) {
  try {
    ensureDir();
    appendFileSync(F_LOG(), JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n');
  } catch { /* logging is best-effort */ }
}

export function readLog({ limit } = {}) {
  if (!existsSync(F_LOG())) return [];
  const lines = readFileSync(F_LOG(), 'utf8').split('\n').filter(Boolean);
  const slice = limit ? lines.slice(-limit) : lines;
  return slice.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

// ---- attempts ledger (cap + cooldown across one-shot processes) ------------
const ledgerKey = (region, area, key) => `${region || '-'}:${area}:${key}`;

export function ledgerGet(region, area, key) {
  const l = readJson(F_LEDGER(), {});
  return l[ledgerKey(region, area, key)] || { attempts: 0, lastTs: null, cooldownUntil: 0 };
}

// Within cooldown and over the lifetime cap? (heal should not run)
export function ledgerBlocked(region, area, key, { cap = 3 } = {}) {
  const e = ledgerGet(region, area, key);
  if (Date.now() < (e.cooldownUntil || 0)) return { blocked: true, reason: 'cooldown', entry: e };
  if ((e.attempts || 0) >= cap) return { blocked: true, reason: 'cap', entry: e };
  return { blocked: false, entry: e };
}

export function ledgerBump(region, area, key, { cooldownMs = 6 * 60 * 60 * 1000 } = {}) {
  if (!acquireLock()) return null;
  try {
    const l = readJson(F_LEDGER(), {});
    const id = ledgerKey(region, area, key);
    const cur = l[id] || { attempts: 0 };
    cur.attempts = (cur.attempts || 0) + 1;
    cur.lastTs = new Date().toISOString();
    cur.cooldownUntil = Date.now() + cooldownMs;
    l[id] = cur;
    atomicWrite(F_LEDGER(), l);
    return cur;
  } finally {
    releaseLock();
  }
}

export function ledgerClear(region, area, key) {
  if (!acquireLock()) return false;
  try {
    const l = readJson(F_LEDGER(), {});
    if (region == null && area == null && key == null) { atomicWrite(F_LEDGER(), {}); return true; }
    delete l[ledgerKey(region, area, key)];
    atomicWrite(F_LEDGER(), l);
    return true;
  } finally {
    releaseLock();
  }
}

// ---- revert / list ---------------------------------------------------------
// Layer-aware revert. all -> wipe; area only -> drop the whole area; area+key ->
// drop the leaf (a region restricts the layer; otherwise all layers + url leaf).
export function revert({ area, key, region, all } = {}) {
  if (!acquireLock()) return { ok: false, reason: 'locked' };
  try {
    let o = readJson(F_OVERRIDES(), {});
    const removed = [];
    if (all) {
      o = {};
    } else if (area && !key) {
      for (const kind of KINDS) if (isObj(o[kind]) && area in o[kind]) { delete o[kind][area]; removed.push(`${kind}.${area}`); }
    } else if (area && key) {
      const sel = o.selectors?.[area];
      if (isObj(sel)) {
        const layers = region ? [region] : Object.keys(sel);
        for (const L of layers) if (isObj(sel[L]) && key in sel[L]) { delete sel[L][key]; removed.push(`selectors.${area}.${L}.${key}`); }
      }
      if (isObj(o.urls?.[area]) && key in o.urls[area]) { delete o.urls[area][key]; removed.push(`urls.${area}.${key}`); }
      if (isObj(o.endpoints?.[area]) && key in o.endpoints[area]) { delete o.endpoints[area][key]; removed.push(`endpoints.${area}.${key}`); }
    }
    atomicWrite(F_OVERRIDES(), o);
    appendLog({ event: 'revert', area: area || null, key: key || null, region: region || null, all: !!all, removed });
    return { ok: true, removed: all ? 'all' : removed };
  } finally {
    releaseLock();
  }
}

export function listHeals() {
  return { dir: HEAL_DIR, overrides: loadOverrides(), provenance: readLog(), ledger: readJson(F_LEDGER(), {}) };
}

export function healPaths() {
  return { dir: HEAL_DIR, overrides: F_OVERRIDES(), log: F_LOG(), ledger: F_LEDGER() };
}
