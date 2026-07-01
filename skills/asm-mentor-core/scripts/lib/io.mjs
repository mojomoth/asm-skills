// io.mjs — JSON output envelope, structured errors, stderr logging, secret redaction.
import { secretValues } from './env.mjs';

export class AsmError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.code = code;
    this.extra = extra; // { hint, screenshot, ... }
  }
}

export function redact(input) {
  let s = typeof input === 'string' ? input : safeStringify(input);
  for (const sec of secretValues()) {
    if (sec) s = s.split(sec).join('***');
  }
  s = s.replace(/(JSESSIONID=)[^;\s"']+/gi, '$1***');
  s = s.replace(/(csrf[_a-z]*["'\s:=>]+)[A-Za-z0-9\-_=/+]{6,}/gi, '$1***');
  return s;
}

function safeStringify(v) {
  try { return JSON.stringify(v); } catch { return String(v); }
}

// Diagnostics go to stderr so stdout stays a single clean JSON object.
export function log(...args) {
  const msg = args.map((a) => (typeof a === 'string' ? a : safeStringify(a))).join(' ');
  process.stderr.write(redact(msg) + '\n');
}

export function ok(command, region, data, meta = {}) {
  return { ok: true, command, region: region || null, data, meta };
}

export function fail(command, region, err, meta = {}) {
  const code = err instanceof AsmError ? err.code : 'UNKNOWN';
  const extra = err instanceof AsmError ? err.extra : {};
  const message = redact(err?.message || String(err));
  return {
    ok: false,
    command,
    region: region || null,
    error: { code, message, ...redactObj(extra) },
    meta,
  };
}

function redactObj(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    out[k] = typeof v === 'string' ? redact(v) : v;
  }
  return out;
}

export function emit(obj) {
  // Deep-redact the whole envelope as a final safety net, then print once.
  const json = JSON.stringify(obj, null, 2);
  process.stdout.write(redact(json) + '\n');
}
