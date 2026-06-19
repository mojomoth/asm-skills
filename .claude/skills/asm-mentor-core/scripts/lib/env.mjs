// env.mjs — project-root resolution, .env parsing, region config, path constants.
// Credentials are read here and never written to disk or logs (see io.mjs redactor).
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

export function findProjectRoot(startDir) {
  let dir = startDir || dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, '.env')) || existsSync(join(dir, '.claude'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // fallback: lib -> scripts -> asm-mentor-core -> skills -> .claude -> ROOT
  return resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
}

export const PROJECT_ROOT = findProjectRoot();
export const SESSIONS_DIR = join(PROJECT_ROOT, '.agentdocs/asm/sessions');
export const STATE_DIR = join(PROJECT_ROOT, '.agentdocs/asm/state');
export const RECON_DIR = join(PROJECT_ROOT, '.agentdocs/asm/recon');
export const ARTIFACTS_DIR = join(PROJECT_ROOT, '.agentdocs/asm/artifacts');

function parseEnv(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[k] = v;
  }
  return out;
}

// Canonicalize the homepage origin: force https + www host (the site redirects
// http -> https and swmaestro.ai -> www.swmaestro.ai).
function normalizeOrigin(rawUrl, fallback) {
  if (!rawUrl) return fallback;
  try {
    const u = new URL(rawUrl.includes('://') ? rawUrl : `https://${rawUrl}`);
    let host = u.hostname;
    if (host === 'swmaestro.ai') host = 'www.swmaestro.ai';
    return `https://${host}`;
  } catch {
    return fallback;
  }
}

let _cfg = null;
export function loadConfig() {
  if (_cfg) return _cfg;
  const envPath = join(PROJECT_ROOT, '.env');
  const env = existsSync(envPath) ? parseEnv(readFileSync(envPath, 'utf8')) : {};
  const origin = normalizeOrigin(env.ASM_SEOUL_HOMEPAGE_URL, 'https://www.swmaestro.ai');
  _cfg = {
    projectRoot: PROJECT_ROOT,
    creds: { id: env.ASM_HOMEPAGE_ID || '', pw: env.ASM_HOMEPAGE_PW || '' },
    regions: {
      seoul: { origin, prefix: '/sw' },
      busan: { origin, prefix: '/busan/sw' },
    },
  };
  return _cfg;
}

// Secret strings to scrub from every log / output (see io.redact).
export function secretValues() {
  const { creds } = loadConfig();
  return [creds.id, creds.pw].filter(Boolean);
}
