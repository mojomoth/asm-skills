// schedule.mjs — 월간일정 조회 (HTTP). Returns the "주요 월간 일정" list rows.
import { httpGet } from '../http.mjs';
import { url } from '../maps.mjs';
import { parse, rowsOf, clean } from '../parse.mjs';

export async function list(ctx) {
  const { region, state, flags } = ctx;
  let rel = url('schedule');
  if (flags.month) rel += `&searchYm=${encodeURIComponent(flags.month.replace('-', ''))}`;
  const { body } = await httpGet(region, rel, { state });
  const root = parse(body);
  // The schedule list table (date/제목) — pick the table that is NOT the team widget or calendar.
  let events = [];
  for (const t of root.querySelectorAll('table')) {
    const heads = t.querySelectorAll('th').map((c) => clean(c.text)).join(' ');
    if (/(일자|날짜|일정|제목|내용)/.test(heads) && !/팀명|팀장/.test(heads) && !/일\s*월\s*화/.test(heads)) {
      events = rowsOf(t).map((r) => r.cells);
      break;
    }
  }
  return { month: flags.month || null, count: events.length, events };
}
