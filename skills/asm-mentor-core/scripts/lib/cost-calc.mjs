// cost-calc.mjs — 멘토링/특강 비용 계산 순수 함수 (네트워크/파일 IO 없음 → 단위 테스트 용이).
// 규칙: 강의료 = 인정시간 × 시간당단가. 하루 인정시간 = clamp(해당일 세션 시간 합, min, max).
// 부산 오프라인은 연속 날짜를 출장으로 묶어 출장수당 추가.

// "19:30" -> 1170 (분). 형식 불명이면 null.
export function toMinutes(hhmm) {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(hhmm ?? '').trim());
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

// 시작/종료(HH:MM) -> 시간(float). 자정 넘김 방어. 한쪽이라도 없으면 null.
export function durationHours(start, end) {
  const s = toMinutes(start);
  const e = toMinutes(end);
  if (s == null || e == null) return null;
  let d = e - s;
  if (d < 0) d += 1440;
  return d / 60;
}

// 인정시간 "02:00" 처럼 HH:MM 으로 표기된 '시간량' -> 시간(float). (00:00 기준 경과)
export function hhmmToHours(hhmm) {
  const m = toMinutes(hhmm);
  return m == null ? null : m / 60;
}

// "1시간 30분" / "2시간" -> 시간(float). 보고서 진행시간(progressTtime) 재계산용.
export function koreanDurationHours(s) {
  const str = String(s ?? '');
  const h = str.match(/(\d+)\s*시간/);
  const mn = str.match(/(\d+)\s*분/);
  if (!h && !mn) return null;
  return (h ? Number(h[1]) : 0) + (mn ? Number(mn[1]) / 60 : 0);
}

// "400,000원" -> 400000. 숫자 없으면 null.
export function wonToNumber(s) {
  const digits = String(s ?? '').replace(/[^\d]/g, '');
  return digits ? parseInt(digits, 10) : null;
}

// 하루 인정시간 상·하한 적용.
export function clampDay(hours, { min, max }) {
  return Math.min(max, Math.max(min, hours));
}

// 부산 진행장소가 '온라인'인가 (온라인은 출장수당 없음).
export function isOnlinePlace(place) {
  return /webex|online|온라인/i.test(String(place ?? ''));
}

// ISO 날짜 배열 -> 연속된 날짜 구간(run)들의 배열. ['06-10','06-11','06-13'] -> [[10,11],[13]].
export function groupConsecutive(dates) {
  const dayNum = (d) => Math.round(Date.parse(`${d}T00:00:00Z`) / 86400000);
  const uniq = [...new Set((dates || []).filter(Boolean))]
    .filter((d) => Number.isFinite(dayNum(d)))
    .sort();
  const runs = [];
  let cur = [];
  for (const d of uniq) {
    if (cur.length && dayNum(d) - dayNum(cur[cur.length - 1]) === 1) cur.push(d);
    else { if (cur.length) runs.push(cur); cur = [d]; }
  }
  if (cur.length) runs.push(cur);
  return runs;
}

// days일 출장의 출장수당. 운임(왕복 1회) + 숙박비×(days-1) + 일비식비×days.
// homeBase 운임이 0(예: 부산/경남 거주)이면 전액 미지급.
export function tripAllowance(days, alw) {
  const fare = Number(alw?.fareByOrigin?.[alw?.homeBase] || 0);
  if (!fare) return { days, fare: 0, lodging: 0, meals: 0, amount: 0 };
  const lodging = Number(alw?.perNightLodging || 0) * Math.max(0, days - 1);
  const meals = Number(alw?.perDayMeals || 0) * days;
  return { days, fare, lodging, meals, amount: fare + lodging + meals };
}

const round2 = (n) => (n == null ? null : Math.round(n * 100) / 100);

// 세션들을 (region,date)로 묶어 일별 인정시간/강의료 산출.
// mode 'trust'  : 보고서 공식 인정시간/지급액을 그대로 합산(사무국이 이미 상한 적용).
// mode 'compute': 멘토링 강의 시간으로 직접 계산 — 하루 합산 후 clamp(min,max) × 단가.
export function aggregateDays(sessions, { mode, caps, rate }) {
  const map = new Map();
  for (const s of sessions) {
    const key = `${s.region}\t${s.date}`;
    if (!map.has(key)) map.set(key, { region: s.region, date: s.date, sessions: [], rawHours: 0, timed: 0 });
    const d = map.get(key);
    d.sessions.push(s);
    if (mode === 'trust') {
      if (s.recognizedHours != null) { d.rawHours += s.recognizedHours; d.timed++; }
    } else if (s.durationHours != null) {
      d.rawHours += s.durationHours; d.timed++;
    }
  }
  const days = [];
  for (const d of map.values()) {
    let recognizedHours;
    let lectureFee;
    if (mode === 'trust') {
      recognizedHours = d.rawHours;
      lectureFee = d.sessions.reduce((a, s) => a + (s.fee || 0), 0);
    } else {
      recognizedHours = d.timed ? clampDay(d.rawHours, caps) : 0;
      lectureFee = Math.round(recognizedHours * rate);
    }
    days.push({
      region: d.region, date: d.date,
      sessionCount: d.sessions.length, timedCount: d.timed,
      rawHours: round2(d.rawHours), recognizedHours: round2(recognizedHours),
      lectureFee,
    });
  }
  return days.sort((a, b) => (a.region || '').localeCompare(b.region || '') || (a.date || '').localeCompare(b.date || ''));
}
