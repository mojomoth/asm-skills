// team.mjs — 팀매칭 조회 (HTTP). Full team table; Notion lists (연수생/멘토/Expert) are
// fetched by the SKILL via the Notion MCP, not here.
import { httpGet } from '../http.mjs';
import { url } from '../maps.mjs';
import { parse, findTable, rowsOf, clean } from '../parse.mjs';

const NOTION = {
  seoul: {
    mentees: 'https://swmaestromain.notion.site/32b91e401fdf8060a9c0d884c83bad6a?v=32d91e401fdf809eac47000c7ed52d19',
    mentors: 'https://swmaestromain.notion.site/AI-SW-32b91e401fdf8026a911df1dc614d5a4',
    experts: 'https://swmaestromain.notion.site/AI-SW-32c91e401fdf80f3acfdcfb0f53d7c62',
  },
  busan: {
    mentees: 'https://asm-busan.notion.site/mentee-list?v=33da01badc2180d0bd03000cd17634ca',
    mentors: 'https://swmaestromain.notion.site/AI-SW-32b91e401fdf8026a911df1dc614d5a4',
    experts: 'https://swmaestromain.notion.site/AI-SW-32c91e401fdf80f3acfdcfb0f53d7c62',
  },
};

export async function team(ctx) {
  const { region, state, flags } = ctx;
  let rel = url('team');
  if (flags.search) rel += `&searchWrd=${encodeURIComponent(flags.search)}`;
  const { body } = await httpGet(region, rel, { state });
  const root = parse(body);
  const table = findTable(root, ['팀명', '멘토']);
  const headers = table ? table.querySelectorAll('th').map((c) => clean(c.text)) : [];
  const teams = rowsOf(table).map((r) => {
    const c = r.cells;
    return {
      no: c[0] || null, teamName: c[1] || null, leader: c[2] || null, members: c[3] || null,
      mentors: c[4] || null, project: c[5] || null, ictMajor: c[6] || null, ictMinor: c[7] || null,
    };
  }).filter((t) => t.teamName && t.teamName !== '로딩중');
  return { count: teams.length, headers, teams, notion: NOTION[region] };
}
