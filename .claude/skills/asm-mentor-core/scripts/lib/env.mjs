// env.mjs — project-root resolution, .env parsing, region config, path constants.
// Credentials are read here and never written to disk or logs (see io.mjs redactor).
//
// STATE BASE (self-heal / plugin-safe): runtime data (sessions, state/overrides,
// recon, artifacts) lives under a resolved WRITABLE base, not blindly under the
// skill dir — so the suite also works when installed as a read-only plugin.
import { readFileSync, existsSync, mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, sep } from 'node:path';
import { homedir } from 'node:os';

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

// Is PROJECT_ROOT a genuine project (dev repo) rather than a plugin install?
// A plugin lives under a ".../plugins/..." path; a real repo has a .env or a
// .claude dir that is NOT under a plugins/ segment.
function isGenuineProject(root) {
  const underPlugins = root.split(sep).includes('plugins');
  if (underPlugins) return false; // a plugin install is never the dev-repo state base
  if (existsSync(join(root, '.env'))) return true;
  if (existsSync(join(root, '.claude'))) return true;
  return false;
}

// Probe a directory for writability exactly once per candidate (mkdir + write+unlink).
function isWritable(dir) {
  try {
    mkdirSync(dir, { recursive: true });
    const probe = join(dir, `.wprobe-${process.pid}`);
    writeFileSync(probe, 'x');
    unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

let _stateBase = null;
// Resolve the writable runtime base. Precedence:
//   1) ASM_STATE_DIR                              (explicit; cron/headless/sandbox)
//   2) PROJECT_ROOT/.agentdocs/asm                (dev repo, when genuine + writable)
//   3) ${XDG_STATE_HOME:-~/.local/state}/asm-mentor   (guaranteed-writable home fallback)
export function resolveStateBase() {
  if (_stateBase) return _stateBase;
  const candidates = [];
  if (process.env.ASM_STATE_DIR) candidates.push(resolve(process.env.ASM_STATE_DIR));
  if (isGenuineProject(PROJECT_ROOT)) candidates.push(join(PROJECT_ROOT, '.agentdocs', 'asm'));
  const xdg = process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state');
  candidates.push(join(xdg, 'asm-mentor'));
  for (const c of candidates) {
    if (isWritable(c)) { _stateBase = c; return _stateBase; }
  }
  // last resort: the first candidate even if the probe failed (callers handle EACCES)
  _stateBase = candidates[0];
  return _stateBase;
}

const STATE_BASE = resolveStateBase();
export const SESSIONS_DIR = join(STATE_BASE, 'sessions');
export const STATE_DIR = join(STATE_BASE, 'state');
export const RECON_DIR = join(STATE_BASE, 'recon');
export const ARTIFACTS_DIR = join(STATE_BASE, 'artifacts');
// Heal store lives under STATE_DIR (already gitignored in the dev repo).
export const HEAL_DIR = join(STATE_DIR, 'heal');

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

function readEnvFile(path) {
  return existsSync(path) ? parseEnv(readFileSync(path, 'utf8')) : {};
}

// Layer the relevant ASM_* config from (lowest) ~/.config/asm-mentor/.env -> repo .env
// -> (highest) process.env. Plugin/cron deployments can supply creds purely via
// real environment variables, with no repo .env present.
function layeredEnv() {
  const userCfg = readEnvFile(join(homedir(), '.config', 'asm-mentor', '.env'));
  const repo = readEnvFile(join(PROJECT_ROOT, '.env'));
  const KEYS = [
    'ASM_HOMEPAGE_ID', 'ASM_HOMEPAGE_PW', 'ASM_SEOUL_HOMEPAGE_URL', 'ASM_BUSAN_HOMEPAGE_URL',
    'ASM_BUSAN_STAY_BOOKIN_PW',
  ];
  const out = { ...userCfg, ...repo };
  for (const k of KEYS) {
    if (process.env[k] != null && process.env[k] !== '') out[k] = process.env[k];
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
  const env = layeredEnv();
  const origin = normalizeOrigin(env.ASM_SEOUL_HOMEPAGE_URL, 'https://www.swmaestro.ai');
  _cfg = {
    projectRoot: PROJECT_ROOT,
    stateBase: STATE_BASE,
    creds: {
      id: env.ASM_HOMEPAGE_ID || '',
      pw: env.ASM_HOMEPAGE_PW || '',
      // Separate password for the Busan 숙박예약(booking) site — distinct login, distinct
      // credential from the main-site ASM_HOMEPAGE_PW. See lib/commands/stay.mjs.
      stayPw: env.ASM_BUSAN_STAY_BOOKIN_PW || '',
    },
    regions: {
      seoul: { origin, prefix: '/sw' },
      busan: { origin, prefix: '/busan/sw' },
      // Busan 숙박예약(accommodation booking) — separate app under the same host, own login.
      'busan-stay': { origin, prefix: '/booking' },
    },
  };
  return _cfg;
}

// Secret strings to scrub from every log / output (see io.redact).
export function secretValues() {
  const { creds } = loadConfig();
  return [creds.id, creds.pw, creds.stayPw].filter(Boolean);
}
