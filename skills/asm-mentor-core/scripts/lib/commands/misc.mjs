// misc.mjs — utility commands (full-page screenshot of any page).
import { withSession, gotoGuarded, regionUrl } from '../session.mjs';
import { artifact } from '../widgets.mjs';
import { AsmError } from '../io.mjs';

export async function screenshot(ctx) {
  const { region, state, flags } = ctx;
  const rel = flags.url;
  if (!rel) throw new AsmError('VALIDATION', 'screenshot requires --url <region-relative path>');
  const out = flags.out ? flags.out : artifact(`shot-${region}-${Date.now()}.png`);
  const fullPage = flags.fullPage !== 'false' && flags.fullPage !== false;
  return withSession(region, async ({ page }) => {
    await gotoGuarded(page, region, regionUrl(region, rel), state);
    await page.waitForTimeout(800);
    await page.screenshot({ path: out, fullPage });
    return { path: out, url: page.url(), fullPage };
  }, { state });
}
