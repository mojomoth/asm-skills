// cost.mjs — 멘토링/특강 비용 계산 (전체/서울/부산, 한 달 기준).
// 소스 2종: report(기본, 보고 게시판 공식 인정시간/지급액) | mento(개설 강의 시간으로 산출).
// 부산 '오프라인'은 연속 날짜를 출장으로 묶어 출장수당(운임+숙박+일비식비)을 더한다.
import { list as reportList, view as reportView } from './report.mjs';
import { list as mentoList, viewById as mentoView } from './mento.mjs';
import { config } from '../maps.mjs';
import {
  aggregateDays, durationHours, hhmmToHours, wonToNumber,
  koreanDurationHours, isOnlinePlace, groupConsecutive, tripAllowance,
} from '../cost-calc.mjs';
import { AsmError } from '../io.mjs';

const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
const round2 = (n) => (n == null ? null : Math.round(n * 100) / 100);
const PAGE = 10; // 게시판 페이지당 행 수
const MAX_PAGES = 50;

// ---- report 소스 ----------------------------------------------------------
// 목록(진행날짜/구분/상태/인정시간/지급액) + 보고서별 상세(멘토링대상=지역, 진행장소=온/오프).
async function fetchReportSessions(month, state, { recompute }) {
  const year = month.slice(0, 4);
  const rows = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const { items } = await reportList({ state, flags: { year, page } });
    if (!items.length) break;
    rows.push(...items);
    if (items.length < PAGE) break;
  }
  const sessions = [];
  const warnings = [];
  for (const it of rows) {
    const cells = (it.cells || []).map((c) => String(c || '').trim());
    const date = cells.find((c) => /^\d{4}-\d{2}-\d{2}$/.test(c)) || null;
    if (!date || !date.startsWith(month)) continue;
    const status = cells.find((c) => /^(승인|반려|대기|미승인|접수|제출|완료|진행)/.test(c)) || null;
    const category = cells.find((c) => /^(멘토\s?특강|자유\s?멘토링|정규\s?멘토링)$/.test(c)) || null;
    const officialHours = hhmmToHours(cells.find((c) => /^\d{1,2}:\d{2}$/.test(c)) || null);
    // 지급액만 매칭: '400,000원' 같은 순수 금액 토큰. (작성자명/제목에 흔한 음절 '원'을 오인하지 않도록 앵커링)
    const officialFee = wonToNumber(cells.find((c) => /^[\d,]+\s*원$/.test(c)) || null);
    const title = cells[2] || cells.slice().sort((a, b) => b.length - a.length)[0] || null;

    let region = 'seoul';
    let place = null;
    let progressTtime = null;
    try {
      const d = await reportView({ state, flags: { id: it.reportId } });
      region = /부산/.test(d.fields?.['멘토링대상'] || '') ? 'busan' : 'seoul';
      place = d.fields?.['진행장소'] || null;
      progressTtime = d.fields?.['진행시간'] || null;
    } catch (e) {
      warnings.push(`report ${it.reportId} (${date}): 상세 조회 실패 — 서울/오프라인 간주 (${e.message})`);
    }
    const rawHours = koreanDurationHours(progressTtime);
    if (officialHours == null) warnings.push(`report ${it.reportId} (${date}): 인정시간 없음(미승인?) — 0시간 처리`);
    sessions.push({
      source: 'report', region, ref: it.reportId, title, date, status, category,
      place, online: isOnlinePlace(place),
      recognizedHours: officialHours, fee: officialFee || 0,
      durationHours: recompute ? (rawHours ?? officialHours) : officialHours,
      officialHours, officialFee,
    });
  }
  return { sessions, warnings };
}

// 대상월 + 인접월(설정월). 목록의 setDate 는 강의날짜가 아니라 접수/등록 기준이라
// 대상월 질의에 타월 강의가 섞이거나(7월 강의가 6월에 노출) 누락될 수 있어 앞뒤 달까지 모아 강의날짜로 거른다.
function queryMonths(month) {
  const [y, mo] = month.split('-').map(Number);
  const mk = (yy, mm) => `${yy}-${String(mm).padStart(2, '0')}`;
  return [mo === 1 ? mk(y - 1, 12) : mk(y, mo - 1), month, mo === 12 ? mk(y + 1, 1) : mk(y, mo + 1)];
}

// ---- mento 소스 -----------------------------------------------------------
// 내 멘토링/특강(개설 강의)의 시작/종료로 시간 산출. 부산은 상세에서 진행장소(온/오프) 확인.
async function fetchMentoSessions(regions, month, state) {
  const sessions = [];
  const warnings = [];
  for (const region of regions) {
    let myName = null;
    const byId = new Map(); // qustnrSn → item (인접월 중복 제거)
    for (const qm of queryMonths(month)) {
      for (let page = 1; page <= MAX_PAGES; page++) {
        const res = await mentoList({ region, state, flags: { mine: true, month: qm, page } });
        myName = res.myName || myName;
        if (!res.items.length) break;
        for (const it of res.items) if (it.qustnrSn) byId.set(it.qustnrSn, it);
        if (res.items.length < PAGE) break;
      }
    }
    if (!myName) {
      // 본인 이름 미확인 시 목록은 전체 멘토의 글 → 전부 계산되는 fail-open 방지: 해당 지역 제외.
      warnings.push(`mento ${region}: 본인 이름 확인 실패 — 계산 제외`);
      continue;
    }
    // 강의날짜(date)가 실제 대상월인 것만 — setDate(접수/등록 기준)로 섞인 타월 강의 제거.
    const mine = [...byId.values()].filter((i) => i.author === myName && i.date && i.date.startsWith(month));
    for (const m of mine) {
      let place = null;
      let start = m.start;
      let end = m.end;
      if (region === 'busan') {
        try {
          const v = await mentoView(region, m.qustnrSn, state);
          place = v.place;
          start = start || v.startTime;
          end = end || v.endTime;
        } catch (e) {
          warnings.push(`mento ${m.qustnrSn}: 상세 조회 실패 — 장소 미상(오프라인 간주) (${e.message})`);
        }
      }
      const dur = durationHours(start, end);
      if (dur == null) warnings.push(`mento ${m.qustnrSn} (${m.date || '?'}): 시간 누락 — 계산 제외`);
      sessions.push({
        source: 'mento', region, ref: m.qustnrSn, title: m.title, date: m.date,
        start, end, place, online: region === 'busan' ? isOnlinePlace(place) : false,
        durationHours: dur, recognizedHours: null, fee: 0,
        status: m.status, category: null,
      });
    }
  }
  return { sessions, warnings };
}

export async function run(ctx) {
  const { state, flags } = ctx;
  const month = flags.month;
  if (!month || !/^\d{4}-\d{2}$/.test(month)) {
    throw new AsmError('VALIDATION', 'cost requires --month YYYY-MM (예: --month 2026-06)');
  }
  const source = String(flags.source || 'report').toLowerCase();
  if (!['report', 'mento'].includes(source)) {
    throw new AsmError('VALIDATION', "cost --source 는 'report' 또는 'mento'");
  }
  // scope 는 flags.region 원본으로 판단(미지정 → all). asm.mjs 가 region 을 'seoul'로 기본화하므로 flags 사용.
  const scope = String(flags.region || 'all').toLowerCase();
  if (!['all', 'seoul', 'busan'].includes(scope)) {
    throw new AsmError('VALIDATION', "cost --region 은 all|seoul|busan");
  }
  const recompute = flags.recompute === true || flags.recompute === 'true';
  const regions = scope === 'all' ? ['seoul', 'busan'] : [scope];

  const cost = config('cost-config.json');
  const alw = config('travel-allowance.json');
  const caps = { min: num(cost.dailyMinHours, 1), max: num(cost.dailyMaxHours, 3) };
  const rate = num(cost.hourlyRate, 200000);

  const warnings = [];
  if (!Object.keys(cost).length) warnings.push('references/cost-config.json 없음 — 기본값(시간당 200,000원, 1~3시간) 사용');
  if (!alw.fareByOrigin) warnings.push('references/travel-allowance.json 없음/불완전 — 부산 출장수당 0 처리');
  else if (alw.homeBase && !(alw.homeBase in alw.fareByOrigin)) warnings.push(`homeBase '${alw.homeBase}' 운임 미정의 — 출장수당 0`);

  // 1) 세션 수집
  const fetched = source === 'report'
    ? await fetchReportSessions(month, state, { recompute })
    : await fetchMentoSessions(regions, month, state);
  warnings.push(...fetched.warnings);
  const scoped = scope === 'all' ? fetched.sessions : fetched.sessions.filter((s) => s.region === scope);

  // 2) 일별 인정시간/강의료
  const mode = source === 'report' && !recompute ? 'trust' : 'compute';
  const days = aggregateDays(scoped, { mode, caps, rate });

  // 3) 부산 출장(연속 오프라인 날짜) → 출장수당
  const busanOfflineDates = scoped.filter((s) => s.region === 'busan' && !s.online && s.date).map((s) => s.date);
  const trips = groupConsecutive(busanOfflineDates).map((run) => ({ region: 'busan', dates: run, ...tripAllowance(run.length, alw) }));

  // 4) 지역별 소계 + 합계
  const regionSummary = (reg) => {
    const rdays = days.filter((d) => d.region === reg);
    const lectureFee = rdays.reduce((a, d) => a + (d.lectureFee || 0), 0);
    const recognizedHours = round2(rdays.reduce((a, d) => a + (d.recognizedHours || 0), 0));
    const allowance = reg === 'busan' ? trips.reduce((a, t) => a + t.amount, 0) : 0;
    return {
      recognizedHours, lectureFee, allowance, subtotal: lectureFee + allowance,
      dayCount: rdays.length, ...(reg === 'busan' ? { tripCount: trips.length } : {}),
    };
  };
  const regionsOut = {};
  for (const reg of regions) regionsOut[reg] = regionSummary(reg);
  const lectureFee = Object.values(regionsOut).reduce((a, r) => a + r.lectureFee, 0);
  const allowance = Object.values(regionsOut).reduce((a, r) => a + r.allowance, 0);

  if (recompute) {
    const officialFeeTotal = scoped.reduce((a, s) => a + (s.officialFee || 0), 0);
    if (officialFeeTotal && officialFeeTotal !== lectureFee) {
      warnings.push(`재계산 강의료(${lectureFee.toLocaleString()}원) ≠ 사무국 지급액 합(${officialFeeTotal.toLocaleString()}원) — 차이 확인 필요`);
    }
  }

  return {
    month, source, scope, mode,
    config: {
      hourlyRate: rate, dailyMaxHours: caps.max, dailyMinHours: caps.min,
      homeBase: alw.homeBase || null, fare: alw.fareByOrigin?.[alw.homeBase] ?? null,
      perNightLodging: alw.perNightLodging ?? null, perDayMeals: alw.perDayMeals ?? null,
    },
    sessions: scoped,
    days,
    trips,
    regions: regionsOut,
    total: { lectureFee, allowance, grandTotal: lectureFee + allowance },
    warnings,
  };
}
