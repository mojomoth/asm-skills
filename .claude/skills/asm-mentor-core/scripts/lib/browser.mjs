// browser.mjs — Playwright launch + context factory.
import { existsSync } from 'node:fs';
import { chromium } from 'playwright';
import { log } from './io.mjs';

const NAV_TIMEOUT = 30000;
const ACTION_TIMEOUT = 15000;

export async function launchBrowser() {
  const headless = process.env.ASM_HEADFUL ? false : true;
  const channel = process.env.ASM_BROWSER_CHANNEL || 'chrome';
  try {
    return await chromium.launch({ headless, channel });
  } catch (e) {
    log(`[browser] channel="${channel}" unavailable (${e.message}); falling back to bundled chromium`);
    return await chromium.launch({ headless });
  }
}

export async function newContext(browser, storageStatePath, extraOpts = {}) {
  const opts = {
    locale: 'ko-KR',
    timezoneId: 'Asia/Seoul',
    viewport: { width: 1440, height: 900 },
    ...extraOpts,
  };
  if (storageStatePath && existsSync(storageStatePath)) opts.storageState = storageStatePath;
  const ctx = await browser.newContext(opts);
  ctx.setDefaultTimeout(ACTION_TIMEOUT);
  ctx.setDefaultNavigationTimeout(NAV_TIMEOUT);
  return ctx;
}
