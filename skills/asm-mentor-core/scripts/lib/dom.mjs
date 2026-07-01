// dom.mjs — safe in-page evaluation helpers.
//
// IMPORTANT: pages on this site poison Playwright's structured (by-value)
// serialization in BOTH directions — passing an object arg or returning an
// object/array can yield `undefined` or throw `refs.set is not a function`.
// Strings survive. So we pass the arg AS a JSON string and return a JSON string,
// parsing on each side. Use evalJson for every page.evaluate in this codebase.
import { AsmError } from './io.mjs';

const UNDEF = '__asm_undefined__';

export async function evalJson(page, fn, arg) {
  const argJson = JSON.stringify(arg === undefined ? null : arg);
  const wrapper = new Function(
    '__argjson',
    `var __a = JSON.parse(__argjson);
     var __r = (${fn.toString()})(__a);
     return (typeof __r === 'undefined' || __r === null) ? '${UNDEF}' : JSON.stringify(__r);`
  );
  let s;
  try {
    s = await page.evaluate(wrapper, argJson);
  } catch (e) {
    throw new AsmError('NAV_ERROR', `page.evaluate failed: ${e.message}`);
  }
  if (s == null || s === UNDEF) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
