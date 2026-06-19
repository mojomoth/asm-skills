// notices.mjs — 공지사항 조회 (HTTP).
import { httpGet } from '../http.mjs';
import { url } from '../maps.mjs';
import { parse, findTable, rowsOf, qparam, viewDetail, clean } from '../parse.mjs';
import { AsmError } from '../io.mjs';

export async function list(ctx) {
  const { region, state, flags } = ctx;
  let rel = url('notices', 'list');
  if (flags.page) rel += `&pageIndex=${encodeURIComponent(flags.page)}`;
  if (flags.search) rel += `&searchCnd=${encodeURIComponent(flags.searchType || '1')}&searchWrd=${encodeURIComponent(flags.search)}`;
  const { body } = await httpGet(region, rel, { state });
  const root = parse(body);
  const table = findTable(root, ['제목', '작성자']);
  const items = rowsOf(table)
    .map((r) => {
      const link = r.links.find((l) => /view\.do/.test(l.href) || qparam(l.href, 'nttId'));
      return {
        nttId: link ? qparam(link.href, 'nttId') : null,
        title: link ? clean(link.text) : r.cells[1] || null,
        author: r.cells[r.cells.length - 2] || null,
        date: r.cells[r.cells.length - 1] || null,
      };
    })
    .filter((i) => i.nttId || i.title);
  return { count: items.length, items };
}

export async function view(ctx) {
  const { region, state, flags } = ctx;
  const id = flags.id;
  if (!id) throw new AsmError('VALIDATION', 'notice-view requires --id <nttId>');
  const rel = `${url('notices', 'view')}&nttId=${encodeURIComponent(id)}`;
  const { body } = await httpGet(region, rel, { state });
  const d = viewDetail(parse(body));
  return { nttId: id, title: d.title, author: d.author, date: d.date, attachments: d.attachments, body: d.body };
}
