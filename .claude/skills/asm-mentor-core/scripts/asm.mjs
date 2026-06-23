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

  const meta = () => ({
    path: state.path,
    reLoggedIn: state.reLoggedIn,
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
      log,
    };
    const data = await route(command, ctx);
    emit(ok(command, region, data, meta()));
  } catch (err) {
    if (!(err instanceof AsmError)) log(`[fatal] ${err?.stack || err}`);
    emit(fail(command, region, err, meta()));
  }
}

const COMMAND_LIST = [
  'login', 'session-status', 'recon',
  'notices-list', 'notice-view', 'team', 'roster', 'schedule',
  'mento-list', 'mento-view', 'mento-create', 'mento-update', 'mento-delete',
  'report-list', 'report-view', 'report-draft', 'report-create',
  'cost',
  'fund-list', 'fund-view', 'fund-comment',
  'room-availability', 'room-reserve', 'room-cancel',
  'member-info', 'screenshot',
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
    default:
      throw new AsmError('VALIDATION', `unknown command: ${command}`, { hint: `known: ${COMMAND_LIST.join(', ')}` });
  }
}

main();
