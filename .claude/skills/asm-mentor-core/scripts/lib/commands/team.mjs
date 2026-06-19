// team.mjs — 팀매칭 조회 (HTTP). 검색 인터페이스의 모든 조건(연수생명/멘토명/프로젝트명/팀명)을
// 서버사이드 검색(?searchCnd=&searchWrd=)으로 지원한다. 전체 팀 목록은 <ul class="bbs-team"> 의
// <li> 카드로 렌더되며(고정된 "내 팀" 표가 아님) 각 카드에 팀명·팀장·팀원·멘토·프로젝트·ICT가 들어있다.
// 연수생/멘토/Expert 명단(Notion)은 `roster` 명령(브라우저 JS 렌더링)으로 조회한다.
import { httpGet } from '../http.mjs';
import { url } from '../maps.mjs';
import { parse, findTable, rowsOf, clean } from '../parse.mjs';
import { AsmError } from '../io.mjs';

// Notion 명단 URL(연수생/멘토/Expert). `roster` 명령이 재사용한다.
export const NOTION = {
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

// 검색조건 별칭 → searchCnd 코드 (사이트 드롭다운: ""=전체, 1=연수생명, 2=멘토명, 3=프로젝트명, 4=팀명)
const SEARCH_CND = {
  '': '', all: '', 전체: '',
  member: '1', members: '1', mentee: '1', trainee: '1', 연수생: '1', 연수생명: '1', 팀원: '1',
  mentor: '2', mentors: '2', 멘토: '2', 멘토명: '2',
  project: '3', 프로젝트: '3', 프로젝트명: '3',
  teamname: '4', team: '4', 팀명: '4',
};

function suiNames(li) {
  return li ? li.querySelectorAll('a.sui').map((a) => clean(a.text)).filter(Boolean) : [];
}

// 전체 팀 목록(ul.bbs-team > li). 검색 시 서버가 이 목록을 필터해서 돌려준다.
function parseTeamList(root) {
  return root.querySelectorAll('ul.bbs-team > li').map((li, i) => {
    const link = li.querySelector('strong.t a');
    const teamName = clean(link ? link.text : '');
    const oc = link ? (link.getAttribute('onclick') || '') : '';
    const m = oc.match(/teamPageGo\(\s*'[^']*'\s*,\s*'[^']*'\s*,\s*'([^']+)'/);
    const teamId = m ? m[1] : null;
    const project = clean(li.querySelector('.add-txt') ? li.querySelector('.add-txt').text : '') || null;
    let leader = null, members = [], mentors = [];
    for (const il of li.querySelectorAll('ul.info > li')) {
      const label = clean(il.querySelector('strong') ? il.querySelector('strong').text : '');
      const names = suiNames(il);
      if (label.includes('팀장')) leader = names.join(' ') || null;
      else if (label.includes('팀원')) members = names;
      else if (label.includes('멘토')) mentors = names;
    }
    const ict = li.querySelectorAll('.bot .ict li span').map((s) => clean(s.text));
    return {
      no: String(i + 1),
      teamName,
      teamId,
      leader,
      members: members.join(' ') || null,
      mentors: mentors.join(' ') || null,
      project,
      ictMajor: ict[0] || null,
      ictMinor: ict[1] || null,
    };
  }).filter((t) => t.teamName);
}

// 폴백: bbs-team 컨테이너가 없으면(템플릿 변경 시) 표(table) 형태를 파싱한다.
function parseTeamTable(root) {
  const table = findTable(root, ['팀명', '멘토']);
  return rowsOf(table).map((r) => {
    const c = r.cells;
    return {
      no: c[0] || null, teamName: c[1] || null, leader: c[2] || null, members: c[3] || null,
      mentors: c[4] || null, project: c[5] || null, ictMajor: c[6] || null, ictMinor: c[7] || null,
    };
  }).filter((t) => t.teamName && t.teamName !== '로딩중');
}

export async function team(ctx) {
  const { region, state, flags } = ctx;
  const keyword = flags.search && flags.search !== true ? String(flags.search) : null;

  // 검색조건: --searchType 별칭 → searchCnd 코드. 미지정 시 전체("")로 모든 필드 검색.
  let cnd = '';
  if (flags.searchType != null && flags.searchType !== true) {
    const key = String(flags.searchType).trim().toLowerCase();
    if (!(key in SEARCH_CND)) {
      throw new AsmError('VALIDATION',
        `--searchType '${flags.searchType}' 미지원. 사용: member|mentor|project|teamName|all (연수생/멘토/프로젝트/팀명)`);
    }
    cnd = SEARCH_CND[key];
  }

  let rel = url('team');
  if (keyword) {
    rel += `&searchCnd=${encodeURIComponent(cnd)}&searchWrd=${encodeURIComponent(keyword)}`;
  }
  const { body } = await httpGet(region, rel, { state });
  const root = parse(body);

  // bbs-team 컨테이너가 있으면(검색결과 0건이어도 ul은 존재) 그걸 신뢰, 없으면 표로 폴백.
  const hasList = root.querySelector('ul.bbs-team') != null;
  const teams = hasList ? parseTeamList(root) : parseTeamTable(root);

  return {
    region,
    search: keyword,
    searchType: flags.searchType && flags.searchType !== true ? flags.searchType : null,
    count: teams.length,
    teams,
    notion: NOTION[region],
  };
}
