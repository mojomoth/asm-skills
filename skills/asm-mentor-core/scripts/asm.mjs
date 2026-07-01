#!/usr/bin/env node
// asm.mjs — dispatcher CLI for the asm-mentor-* skill suite.
// Usage: node asm.mjs <command> --region seoul|busan [--json '<payload>'|@file] [flags]
// Always prints exactly ONE JSON object to stdout; diagnostics go to stderr.
import { readFileSync } from 'node:fs';
import { ok, fail, emit, log, AsmError } from './lib/io.mjs';

function parseArgs(argv) {
  const flags = {};
  const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const key = a.slice(2);
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
          flags[key] = next;
          i++;
        } else {
          flags[key] = true;
        }
      }
    } else {
      positionals.push(a);
    }
  }
  return { positionals, flags };
}

function readJsonFlag(val) {
  if (val == null || val === true) return null;
  if (typeof val === 'string' && val.startsWith('@')) {
    return JSON.parse(readFileSync(val.slice(1), 'utf8'));
  }
  return JSON.parse(val);
}

function asList(val) {
  if (val == null || val === true) return [];
  if (Array.isArray(val)) return val;
  return String(val).split(',').map((s) => s.trim()).filter(Boolean);
}

async function main() {
  const argv = process.argv.slice(2);
  const { positionals, flags } = parseArgs(argv);
  const command = positionals[0];
  const region = flags.region || 'seoul';
  const state = { reLoggedIn: false, path: null };
  const started = Date.now();

  // Self-heal is ON by default; --no-heal / --auto-heal=false / ASM_AUTO_HEAL=0 disable it.
  const autoHeal = !(flags['no-heal'] === true || flags['no-heal'] === 'true'
    || flags['auto-heal'] === 'false' || flags['auto-heal'] === false
    || process.env.ASM_AUTO_HEAL === '0');
  const healed = [];
  state.autoHeal = autoHeal;
  state.healed = healed; // gotoGuarded/httpGet push URL heals here

  const meta = () => ({
    path: state.path,
    reLoggedIn: state.reLoggedIn,
    ...(healed.length ? { healed } : {}),
    durationMs: Date.now() - started,
    ts: new Date().toISOString(),
  });

  if (!command || command === 'help') {
    emit(ok('help', null, { commands: COMMAND_LIST }, meta()));
    return;
  }

  try {
    const payload = flags.json !== undefined ? readJsonFlag(flags.json) : null;
    const ctx = {
      region, flags, payload, state,
      preview: flags.preview === true || flags.preview === 'true',
      force: flags.force === true || flags.force === 'true',
      via: flags.via || null,
      files: asList(flags.files),
      heal: { autoHeal, force: flags.force === true || flags.force === 'true', healed },
      log,
    };
    const data = await runWithHeal(command, ctx);
    emit(ok(command, region, data, meta()));
  } catch (err) {
    if (!(err instanceof AsmError)) log(`[fatal] ${err?.stack || err}`);
    emit(fail(command, region, err, meta()));
  }
}

// Read/idempotent commands may be transparently re-run once after an autonomous URL heal.
// Write commands NEVER re-run (double-submit guard) — they heal URLs inline in gotoGuarded.
const RETRYABLE = new Set([
  'session-status', 'notices-list', 'notice-view', 'schedule', 'team', 'roster',
  'member-info', 'mento-list', 'mento-view', 'report-list', 'report-view',
  'fund-list', 'fund-view', 'room-availability', 'cost',
]);

// Top-level retry-once envelope: on a read URL drift, re-discover the path by menuNo
// (fetch mode), which mutates the in-memory url map, then re-run the command once.
async function runWithHeal(command, ctx) {
  try {
    return await route(command, ctx);
  } catch (err) {
    const e = err && err.code === 'URL_CHANGED' ? err : null;
    if (e && ctx.heal.autoHeal && RETRYABLE.has(command) && e.extra?.area) {
      const { healUrl } = await import('./lib/heal/urlheal.mjs');
      const r = await healUrl({ region: e.extra.region || ctx.region, area: e.extra.area, key: e.extra.key, state: ctx.state });
      if (Array.isArray(ctx.state.healed)) ctx.state.healed.push({ area: e.extra.area, key: e.extra.key, kind: 'url', old: r.old, new: r.path, confidence: r.confidence });
      return route(command, ctx); // url() now resolves the healed path
    }
    throw err;
  }
}

const COMMAND_LIST = [
  'login', 'session-status', 'recon', 'heal',
  'notices-list', 'notice-view', 'team', 'roster', 'schedule',
  'mento-list', 'mento-view', 'mento-create', 'mento-update', 'mento-delete',
  'report-list', 'report-view', 'report-draft', 'report-create',
  'cost',
  'fund-list', 'fund-view', 'fund-comment',
  'room-availability', 'room-reserve', 'room-cancel',
  'member-info', 'screenshot',
  'stay-login', 'stay-availability', 'stay-reserve', 'stay-cancel', 'stay-list', 'stay-profile',
];

async function route(command, ctx) {
  switch (command) {
    case 'login': {
      const { withSession } = await import('./lib/session.mjs');
      await withSession(ctx.region, async () => ({}), { forceLogin: true, state: ctx.state });
      return { loggedIn: true, region: ctx.region };
    }
    case 'session-status': {
      const { probeSession } = await import('./lib/http.mjs');
      const { url } = await import('./lib/maps.mjs');
      const r = await probeSession(ctx.region, url('probe'), { state: ctx.state });
      return r;
    }
    case 'recon': {
      const { recon } = await import('./lib/recon.mjs');
      return recon({ region: ctx.region, area: ctx.flags.area, rawUrl: ctx.flags.url, state: ctx.state });
    }
    case 'heal': return (await import('./lib/commands/heal.mjs')).run(ctx);
    case 'screenshot': {
      const { screenshot } = await import('./lib/commands/misc.mjs');
      return screenshot(ctx);
    }
    case 'notices-list': return (await import('./lib/commands/notices.mjs')).list(ctx);
    case 'notice-view': return (await import('./lib/commands/notices.mjs')).view(ctx);
    case 'schedule': return (await import('./lib/commands/schedule.mjs')).list(ctx);
    case 'team': return (await import('./lib/commands/team.mjs')).team(ctx);
    case 'roster': return (await import('./lib/commands/roster.mjs')).roster(ctx);
    case 'member-info': return (await import('./lib/commands/member.mjs')).info(ctx);
    case 'mento-list': return (await import('./lib/commands/mento.mjs')).list(ctx);
    case 'mento-view': return (await import('./lib/commands/mento.mjs')).view(ctx);
    case 'mento-create': return (await import('./lib/commands/mento.mjs')).create(ctx);
    case 'mento-update': return (await import('./lib/commands/mento.mjs')).update(ctx);
    case 'mento-delete': return (await import('./lib/commands/mento.mjs')).remove(ctx);
    case 'report-list': return (await import('./lib/commands/report.mjs')).list(ctx);
    case 'report-view': return (await import('./lib/commands/report.mjs')).view(ctx);
    case 'report-draft': return (await import('./lib/commands/report.mjs')).draft(ctx);
    case 'report-create': return (await import('./lib/commands/report.mjs')).create(ctx);
    case 'cost': return (await import('./lib/commands/cost.mjs')).run(ctx);
    case 'fund-list': return (await import('./lib/commands/fund.mjs')).list(ctx);
    case 'fund-view': return (await import('./lib/commands/fund.mjs')).view(ctx);
    case 'fund-comment': return (await import('./lib/commands/fund.mjs')).comment(ctx);
    case 'room-availability': return (await import('./lib/commands/room.mjs')).availability(ctx);
    case 'room-reserve': return (await import('./lib/commands/room.mjs')).reserve(ctx);
    case 'room-cancel': return (await import('./lib/commands/room.mjs')).cancel(ctx);
    case 'stay-login': return (await import('./lib/commands/stay.mjs')).login(ctx);
    case 'stay-availability': return (await import('./lib/commands/stay.mjs')).availability(ctx);
    case 'stay-reserve': return (await import('./lib/commands/stay.mjs')).reserve(ctx);
    case 'stay-cancel': return (await import('./lib/commands/stay.mjs')).cancel(ctx);
    case 'stay-list': return (await import('./lib/commands/stay.mjs')).list(ctx);
    case 'stay-profile': return (await import('./lib/commands/stay.mjs')).profile(ctx);
    default:
      throw new AsmError('VALIDATION', `unknown command: ${command}`, { hint: `known: ${COMMAND_LIST.join(', ')}` });
  }
}

main();
