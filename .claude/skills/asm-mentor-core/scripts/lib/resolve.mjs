// resolve.mjs — point-of-use selector resolver for WRITE flows. Adopted at load-bearing
// call sites (await R('key')) alongside the existing synchronous sel(). For a key WITH a
// descriptor it verifies the mapped css resolves to a live element on its consume surface
// and, if not, invokes the healer (auto-fix or Tier-2 escalation). For a key WITHOUT a
// descriptor it is a transparent passthrough to sel() — behavior is unchanged.
//
// Resolving at point of use (not in a single up-front pass) means cascading/dynamic
// fields are checked only AFTER the interaction that populates them, so a transient
// "not yet hydrated" select is never mistaken for structural breakage.
import { sel, selOpt, desc } from './maps.mjs';
import { evalJson } from './dom.mjs';
import { healSelector } from './heal/index.mjs';

function hasTextPseudo(css) { return /:has-text\(|:text\(/i.test(css || ''); }

async function countOn(page, css, consume) {
  if (hasTextPseudo(css) || consume === 'locator') {
    try { return await page.locator(css).count(); } catch { return 0; }
  }
  const n = await evalJson(page, (a) => document.querySelectorAll(a.css).length, { css });
  return Number(n) || 0;
}

export async function resolveSel(page, area, key, region, healCtx = {}) {
  const dsc = desc(area, key, region);
  const css = selOpt(area, key, region);

  // Un-annotated key: transparent passthrough (legacy tolerant behavior preserved).
  if (!dsc) return css == null ? sel(area, key, region) : css;

  const consume = dsc.consume || 'both';
  if (css != null) {
    let n = await countOn(page, css, consume);
    if (n >= 1) return css;
    // settle window: dynamic selects whose <option>s / element arrive late.
    if (dsc.tag === 'select' || dsc.dynamic) {
      for (let i = 0; i < 3 && n === 0; i++) { await page.waitForTimeout(300); n = await countOn(page, css, consume); }
      if (n >= 1) return css;
    }
  }

  // Persistently missing -> heal (auto-fix + retry, or throw HEAL_NEEDED for Tier-2).
  const r = await healSelector({ autoHeal: healCtx.autoHeal !== false, force: healCtx.force }, { area, key, region, page });
  if (Array.isArray(healCtx.healed)) {
    healCtx.healed.push({ area, key, region: region || null, old: r.old, new: r.css, confidence: r.confidence });
  }
  return r.css;
}
