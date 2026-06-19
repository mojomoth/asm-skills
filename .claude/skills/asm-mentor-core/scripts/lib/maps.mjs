// maps.mjs — loads the editable data maps (urls / selectors / endpoints) from
// references/. These are DATA, not code: when the site changes, re-run `recon`
// and edit the JSON — no source edits needed.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { AsmError } from './io.mjs';

const REF_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'references');

function load(name, optional = false) {
  try {
    return JSON.parse(readFileSync(join(REF_DIR, name), 'utf8'));
  } catch (e) {
    if (optional) return {};
    throw new AsmError('UNKNOWN', `failed to load references/${name}: ${e.message}`);
  }
}

const urls = load('urls.json');
const selectors = load('selectors.json');
const endpoints = load('endpoints.json', true);

// url('mento','list') -> "/mypage/mentoLec/list.do?menuNo=200046"
export function url(area, key) {
  const a = urls[area];
  const v = key == null ? a : a?.[key];
  if (v == null) throw new AsmError('VALIDATION', `url not found: ${area}${key ? '.' + key : ''}`);
  return v;
}

// sel('mento','form.title','busan') -> region override if present, else _default.
export function sel(area, key, region) {
  const a = selectors[area] || {};
  const regionLayer = region ? a[region] : null;
  const def = a._default || a;
  let v;
  if (regionLayer && regionLayer[key] != null) v = regionLayer[key];
  else if (def && def[key] != null) v = def[key];
  else if (a[key] != null) v = a[key];
  if (v == null) {
    throw new AsmError('SELECTOR_NOT_FOUND', `selector not found: ${area}.${key}${region ? ' [' + region + ']' : ''}`, {
      hint: `run: asm recon --region ${region || 'seoul'} --area ${area} ; then add the selector to references/selectors.json`,
    });
  }
  return v;
}

// optional lookups that return null instead of throwing (for "may not exist" selectors)
export function selOpt(area, key, region) {
  try { return sel(area, key, region); } catch { return null; }
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
