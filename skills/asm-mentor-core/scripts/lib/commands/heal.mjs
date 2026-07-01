// heal.mjs — `asm heal` CLI: inspect, auto-fix, and apply/revert self-heal overrides.
//
//   asm heal --list                         show overrides + provenance + ledger
//   asm heal --report                        replay the last HEAL_NEEDED escalation(s)
//   asm heal --probe [--area a] [--region r]  health-check mapped selectors (no mutate)
//   asm heal --auto  [--area a] [--region r]  autonomous Tier-1 heal of broken selectors
//   asm heal --apply --area a --json '{"key":"<css>"}'   persist Claude/Tier-2 selectors
//   asm heal --apply --area a --url '<relpath>' [--key k] persist a re-discovered URL
//   asm heal --revert [--area a [--key k]] | --all        drop overrides (layer-aware)
//   flags: --on <relpath> (validation page), --force (skip validation/cooldown)
//
// Overrides ALWAYS go to the gitignored heal store — references/*.json is never written.
import { url, selOpt, desc, selLayer, setOverride, reloadMerged, descriptorKeys, annotatedAreas } from '../maps.mjs';
import { listHeals, revert, readLog } from '../heal/store.mjs';
import { withSession, gotoGuarded, regionUrl, isLoginPage } from '../session.mjs';
import { httpGet } from '../http.mjs';
import { evalJson } from '../dom.mjs';
import { validateUnique } from '../heal/validate.mjs';
import { healSelector } from '../heal/index.mjs';
import { AsmError } from '../io.mjs';

// area -> a region-relative page where its selectors live (validation / sweep target).
const AREA_PAGE = { mento: () => url('mento', 'insert'), report: () => url('report', 'insert') };
function pageForArea(area, flags) {
  if (flags.on) return flags.on;
  const f = AREA_PAGE[area];
  return f ? f() : null;
}
const isTrue = (v) => v === true || v === 'true';
function dedupKeys(list) {
  const seen = new Set();
  return list.filter(({ key }) => (seen.has(key) ? false : seen.add(key)));
}

async function countOn(page, css, consume) {
  if (/:has-text\(|:text\(/i.test(css) || consume === 'locator') {
    try { return await page.locator(css).count(); } catch { return 0; }
  }
  const n = await evalJson(page, (a) => document.querySelectorAll(a.css).length, { css });
  return Number(n) || 0;
}

export async function run(ctx) {
  const { flags } = ctx;
  if (flags.list) return { action: 'list', ...listHeals() };
  if (flags.report) {
    const log = readLog();
    const last = [...log].reverse().find((e) => e.event === 'heal-needed') || null;
    return { action: 'report', last, recent: log.slice(-10) };
  }
  if (flags.revert) {
    const r = revert({ area: flags.area, key: flags.key, region: flags.layer || ctx.region, all: isTrue(flags.all) });
    reloadMerged();
    return { action: 'revert', ...r };
  }
  if (flags.apply) return applyOverrides(ctx);
  if (flags.probe) return probe(ctx);
  if (flags.auto) return auto(ctx);
  return { action: 'status', ...listHeals(), hint: 'use --probe | --auto | --apply --json | --list | --revert | --report' };
}

async function applyOverrides(ctx) {
  const { flags, region, state, payload } = ctx;
  const area = flags.area;
  if (!area) throw new AsmError('VALIDATION', 'heal --apply requires --area');

  // URL apply (validate it loads unless --force).
  if (flags.url) {
    let okLoad = false, status = null;
    try { const r = await httpGet(region, flags.url, { state }); status = r.status; okLoad = r.status < 400 && !isLoginPage(r.url || ''); } catch { okLoad = false; }
    if (!okLoad && !ctx.force) throw new AsmError('VALIDATION', `URL ${flags.url} failed to load (status ${status}); use --force to persist anyway`);
    const persisted = setOverride({ kind: 'urls', area, key: flags.key || null, value: flags.url, prov: { source: 'tier2-apply', validated: okLoad } });
    return { action: 'apply', kind: 'url', area, key: flags.key || null, value: flags.url, validated: okLoad, persisted };
  }

  // Selector apply: payload = { key: css, ... }. Re-validate on the consume surface.
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new AsmError('VALIDATION', "heal --apply requires --json '{\"key\":\"<css>\"}' or --url <relpath>");
  }
  const rel = pageForArea(area, flags);
  if (!rel) throw new AsmError('VALIDATION', `no validation page for area '${area}' — pass --on <relpath>`);
  const applied = [], rejected = [];
  await withSession(region, async ({ page }) => {
    await gotoGuarded(page, region, regionUrl(region, rel), state);
    for (const [key, css] of Object.entries(payload)) {
      const dsc = desc(area, key, region);
      const consume = (dsc && dsc.consume) || 'both';
      const valid = ctx.force ? true : await validateUnique(css, { page, consume, desc: dsc });
      if (valid) {
        const layer = selLayer(area, key, region);
        const persisted = setOverride({ kind: 'selectors', area, layer, key, value: css, prov: { source: 'tier2-apply', validated: !ctx.force } });
        applied.push({ key, css, layer, persisted });
      } else {
        rejected.push({ key, css, reason: `did not resolve to a unique matching element on ${rel}` });
      }
    }
  }, { state });
  return { action: 'apply', kind: 'selectors', area, applied, rejected };
}

async function sweepAreas(flags) {
  if (flags.area) return [flags.area];
  return annotatedAreas().filter((a) => a !== 'login' && pageForArea(a, flags)); // login is Tier-2 only
}

async function probe(ctx) {
  const { flags, region, state } = ctx;
  const areas = await sweepAreas(flags);
  const checks = [];
  await withSession(region, async ({ page }) => {
    for (const area of areas) {
      const rel = pageForArea(area, flags);
      await gotoGuarded(page, region, regionUrl(region, rel), state, { area, key: 'insert' });
      for (const { key } of dedupKeys(descriptorKeys(area))) {
        const css = selOpt(area, key, region);
        const dsc = desc(area, key, region);
        const n = css ? await countOn(page, css, (dsc && dsc.consume) || 'both') : 0;
        checks.push({ area, key, css, count: n, status: n === 1 ? 'ok' : n === 0 ? 'broken' : 'ambiguous' });
      }
    }
  }, { state });
  return { action: 'probe', region, checks, broken: checks.filter((c) => c.status !== 'ok').length };
}

async function auto(ctx) {
  const { flags, region, state } = ctx;
  const areas = await sweepAreas(flags);
  const results = [];
  await withSession(region, async ({ page }) => {
    for (const area of areas) {
      const rel = pageForArea(area, flags);
      await gotoGuarded(page, region, regionUrl(region, rel), state, { area, key: 'insert' });
      for (const { key } of dedupKeys(descriptorKeys(area))) {
        const css = selOpt(area, key, region);
        const dsc = desc(area, key, region);
        const n = css ? await countOn(page, css, (dsc && dsc.consume) || 'both') : 0;
        if (n === 1) { results.push({ area, key, status: 'ok' }); continue; }
        try {
          const r = await healSelector({ autoHeal: true, force: ctx.force }, { area, key, region, page });
          results.push({ area, key, status: 'healed', old: r.old, new: r.css, confidence: r.confidence, persisted: r.persisted });
        } catch (e) {
          results.push({ area, key, status: 'escalate', code: e.code, reason: e.extra?.reason || null });
        }
      }
    }
  }, { state });
  return { action: 'auto', region, results, healed: results.filter((r) => r.status === 'healed').length, escalated: results.filter((r) => r.status === 'escalate').length };
}
