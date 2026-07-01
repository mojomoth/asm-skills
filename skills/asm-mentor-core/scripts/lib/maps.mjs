// maps.mjs — loads the editable data maps (urls / selectors / endpoints) from
// references/ (the immutable, committed BASE) and deep-merges a writable, gitignored
// OVERRIDE layer (heal store) on top. These are DATA, not code.
//
// Self-heal: when the site changes, the healer writes the discovered value into the
// override layer via setOverride(), which mutates the in-memory merged map IN PLACE
// (so an in-process heal+retry sees it without re-import) AND persists it to disk.
// The bundled references/*.json — including selector descriptors — are never modified.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { AsmError } from './io.mjs';
import { loadOverrides, persistOverride } from './heal/store.mjs';

const REF_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'references');

function load(name, optional = false) {
  try {
    return JSON.parse(readFileSync(join(REF_DIR, name), 'utf8'));
  } catch (e) {
    if (optional) return {};
    throw new AsmError('UNKNOWN', `failed to load references/${name}: ${e.message}`);
  }
}

function isObj(x) { return x != null && typeof x === 'object' && !Array.isArray(x); }

function clone(x) { return x == null ? x : JSON.parse(JSON.stringify(x)); }

// Deep-merge override onto a FULLY-OWNED deep clone of base, producing an independent
// object tree. Cloning is essential: sel()-resolution and setOverride() mutate the
// merged map in place, and we must never leak those mutations back into the immutable
// bundled base. Non-object override values (and arrays) replace the base wholesale.
function deepMerge(base, ov) {
  const cloned = clone(base);
  if (!isObj(cloned) || !isObj(ov)) return ov === undefined ? cloned : clone(ov);
  for (const k of Object.keys(ov)) {
    cloned[k] = isObj(cloned[k]) && isObj(ov[k]) ? deepMerge(cloned[k], ov[k]) : clone(ov[k]);
  }
  return cloned;
}

const selectorsBase = load('selectors.json');
const urlsBase = load('urls.json');
const endpointsBase = load('endpoints.json', true);

// Mutable merged maps (declared with `let` so reloadMerged can swap them and every
// sel()/url() closure observes the new map; setOverride mutates in place).
let selectors = deepMerge(selectorsBase, _ovr('selectors'));
let urls = deepMerge(urlsBase, _ovr('urls'));
let endpoints = deepMerge(endpointsBase, _ovr('endpoints'));

function _ovr(kind) {
  try { return loadOverrides()[kind] || {}; } catch { return {}; }
}

// Re-read the override layer and rebuild the merged maps (used by tests and after an
// out-of-process `asm heal --apply`).
export function reloadMerged() {
  selectors = deepMerge(selectorsBase, _ovr('selectors'));
  urls = deepMerge(urlsBase, _ovr('urls'));
  endpoints = deepMerge(endpointsBase, _ovr('endpoints'));
}

// ---- selector resolution ---------------------------------------------------
function cssOf(v) { return isObj(v) ? v.css : v; }

// Raw resolved value (string | {css,desc} | null) without throwing — shared by
// sel()/desc()/selLayer() so they agree on precedence.
function rawSel(area, key, region) {
  const a = selectors[area] || {};
  const regionLayer = region ? a[region] : null;
  const def = a._default || a;
  if (regionLayer && regionLayer[key] != null) return regionLayer[key];
  if (def && def[key] != null) return def[key];
  if (a[key] != null) return a[key];
  return null;
}

// sel('mento','form.title','busan') -> region override if present, else _default.
export function sel(area, key, region) {
  const v = rawSel(area, key, region);
  if (v == null) {
    throw new AsmError('SELECTOR_NOT_FOUND', `selector not found: ${area}.${key}${region ? ' [' + region + ']' : ''}`, {
      hint: `run: asm heal --auto --region ${region || 'seoul'} --area ${area} (or asm recon then asm heal --apply)`,
      area, key, region: region || null,
    });
  }
  return cssOf(v);
}

// optional lookups that return null instead of throwing (for "may not exist" selectors)
export function selOpt(area, key, region) {
  const v = rawSel(area, key, region);
  return v == null ? null : cssOf(v);
}

// The semantic descriptor for a selector key (used by the healer), or null.
export function desc(area, key, region) {
  const v = rawSel(area, key, region);
  return isObj(v) ? v.desc || null : null;
}

// Which layer currently provides (or should receive) area.key: 'seoul'|'busan'|'_default'|null(bare).
export function selLayer(area, key, region) {
  const a = selectors[area] || {};
  if (region && a[region] && a[region][key] != null) return region;
  if (a._default && a._default[key] != null) return '_default';
  if (a[key] != null && !('_default' in a)) return null; // bare/legacy area
  return region && a[region] ? region : '_default';
}

// ---- url resolution --------------------------------------------------------
function pathOf(v) { return isObj(v) ? v.path : v; }

function rawUrl(area, key) {
  const a = urls[area];
  return key == null ? a : a?.[key];
}

// url('mento','list') -> "/mypage/mentoLec/list.do?menuNo=200046"
export function url(area, key) {
  const v = rawUrl(area, key);
  if (v == null) throw new AsmError('VALIDATION', `url not found: ${area}${key ? '.' + key : ''}`, { area, key: key || null });
  return pathOf(v);
}

// The url descriptor {menuNo, doFile} for re-discovery, or null.
export function urlDesc(area, key) {
  const v = rawUrl(area, key);
  if (!isObj(v)) return null;
  const { path, ...rest } = v;
  return Object.keys(rest).length ? rest : null;
}

export function endpoint(area, key) {
  const a = endpoints[area];
  const v = key == null ? a : a?.[key];
  if (v == null) {
    throw new AsmError('ENDPOINT_NOT_FOUND', `endpoint not mapped: ${area}${key ? '.' + key : ''}`, {
      hint: 'run recon (captures HAR) and add the endpoint to references/endpoints.json, or pass --via browser',
    });
  }
  return v;
}

export function hasEndpoint(area, key) {
  const a = endpoints[area];
  return (key == null ? a : a?.[key]) != null;
}

// ---- override writes (healer) ----------------------------------------------
// Persist a healed value into the override layer AND mutate the merged map in place.
//   kind: 'selectors' | 'urls' | 'endpoints'
//   area: top-level area key
//   layer: 'seoul'|'busan'|'_default' for selectors; null for urls/endpoints
//   key:  leaf key, or null for a flat entry (e.g. url('login'))
//   value: the new css string (selectors) or path string (urls)
//   prov: provenance object {confidence, margin, old, evidence, reconRef, source, ...}
export function setOverride({ kind, area, layer, key, value, prov = {} }) {
  let diskValue = value;
  let mergedValue = value;
  if (kind === 'selectors') {
    const L = layer || '_default';
    if (!isObj(selectors[area])) selectors[area] = {};
    if (!isObj(selectors[area][L])) selectors[area][L] = {};
    const existing = selectors[area][L][key];
    if (isObj(existing) && 'desc' in existing) {
      mergedValue = { ...existing, css: value };
      diskValue = { css: value }; // descriptor stays bundled; override carries css only
    }
    selectors[area][L][key] = mergedValue;
    return persistOverride({ kind, path: [area, L, key], value: diskValue, prov: { ...prov, layer: L, old: cssOf(existing) ?? null } });
  }
  // urls / endpoints
  const root = kind === 'endpoints' ? endpoints : urls;
  if (key == null) {
    const existing = root[area];
    if (isObj(existing) && 'path' in existing) { mergedValue = { ...existing, path: value }; diskValue = { path: value }; }
    root[area] = mergedValue;
    return persistOverride({ kind, path: [area], value: diskValue, prov: { ...prov, old: pathOf(existing) ?? null } });
  }
  if (!isObj(root[area])) root[area] = {};
  const existing = root[area][key];
  if (isObj(existing) && 'path' in existing) { mergedValue = { ...existing, path: value }; diskValue = { path: value }; }
  root[area][key] = mergedValue;
  return persistOverride({ kind, path: [area, key], value: diskValue, prov: { ...prov, old: pathOf(existing) ?? null } });
}

// Enumerate descriptor-annotated selector keys for an area (across _default + region
// layers). Used by `asm heal --probe/--auto` to know which keys are healable.
export function descriptorKeys(area) {
  const a = selectors[area] || {};
  const out = [];
  for (const layer of Object.keys(a)) {
    const layerObj = a[layer];
    if (!isObj(layerObj)) continue;
    for (const k of Object.keys(layerObj)) {
      const v = layerObj[k];
      if (isObj(v) && v.desc) out.push({ layer, key: k, desc: v.desc });
    }
  }
  return out;
}

// Areas that carry selector descriptors (for probe/auto sweeps).
export function annotatedAreas() {
  return Object.keys(selectors).filter((area) => descriptorKeys(area).length > 0);
}

// Editable config maps (cost-config.json / travel-allowance.json). Missing -> {}.
export function config(name) {
  return load(name, true);
}
