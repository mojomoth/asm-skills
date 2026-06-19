// member.mjs — 회원정보 (READ-ONLY). Editing is intentionally unsupported (sensitive);
// the SKILL points users to the browser for edits.
import { httpGet } from '../http.mjs';
import { url, sel } from '../maps.mjs';
import { regionUrl, regionBase } from '../session.mjs';
import { parse, clean } from '../parse.mjs';

function findByLabel(root, label) {
  const re = new RegExp('(?:^|\\s)' + label + '\\s+([\\S][^\\n]{0,40})$');
  for (const el of root.querySelectorAll('li,td,dd,p,span,div')) {
    const t = clean(el.text);
    const m = t.match(re);
    if (m && t.length < 60) return clean(m[1]);
  }
  return null;
}

export async function info(ctx) {
  const { region, state } = ctx;
  const { body } = await httpGet(region, url('member'), { state });
  const root = parse(body);
  const inputVal = (name) => {
    const el = root.querySelector(`input[name=${name}], #${name}`);
    return el ? clean(el.getAttribute('value') || '') : null;
  };
  const profile = {
    id: findByLabel(root, '아이디'),
    name: findByLabel(root, '이름') || findByLabel(root, '성명'),
    phone: inputVal('phoneF'),
    address: [inputVal('addrFTemp'), inputVal('addrM'), inputVal('addrL')].filter(Boolean).join(' ') || null,
    agency: inputVal('agency'),
    jobTitle: inputVal('jobTitle'),
  };
  return {
    profile,
    editable: false,
    note: '회원정보 수정은 민감 항목으로 스킬에서 지원하지 않습니다. 수정은 브라우저에서 직접 진행하세요.',
    editUrl: regionUrl(region, url('member')),
    _base: regionBase(region),
  };
}

// Cached mentor name per region (used for --mine filtering / conflict detection).
const _nameCache = {};
export async function getMyName(region, state) {
  if (_nameCache[region]) return _nameCache[region];
  const { body } = await httpGet(region, url('member'), { state });
  const root = parse(body);
  const name = findByLabel(root, '이름') || findByLabel(root, '성명');
  _nameCache[region] = name;
  return name;
}
