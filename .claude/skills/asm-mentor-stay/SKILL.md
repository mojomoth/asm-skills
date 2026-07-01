---
name: asm-mentor-stay
description: >-
  부산센터 숙박 예약(swmaestro.ai/booking, 메인 사이트와 별도 로그인/세션). 지점·월별 예약 가능
  현황 조회, 예약 신청, 예약 내역 조회, 예약 취소, 내 정보 조회. "숙박 예약", "부산 숙소", "토요코인",
  "서면점/부산역1점", "잠온다" 요청에 사용한다.
allowed-tools: Bash, Read
---

# asm-mentor-stay — 부산 숙박 예약 (booking)

메인 사이트(swmaestro.ai)와 별도 로그인·세션을 쓰는 부산센터 전용 앱(`/booking`)이다. 코어 CLI에
region `busan-stay` 로 접근한다:
```
node .claude/skills/asm-mentor-core/scripts/asm.mjs <cmd> --region busan-stay [옵션]
```
JSON 출력/에러 코드 규칙은 `asm-mentor-core` SKILL 참조. **다른 seoul/busan 명령과 세션이 완전히
분리**되어 있으므로 항상 `--region busan-stay` 를 붙인다.

## 로그인
```
asm stay-login --region busan-stay
```
- 이메일은 소마 계정과 동일(`ASM_HOMEPAGE_ID`), 비밀번호는 `.env`의 `ASM_BUSAN_STAY_BOOKIN_PW`.
- 비어 있으면 회원정보(`member-info`)에서 연락처 뒤 4자리를 조회해 최초 로그인 임시 비밀번호로 시도한다.
- **최초 로그인 시 비밀번호 생성 화면**이 뜨면 `ASM_BUSAN_STAY_BOOKIN_PW` 값을 그대로 새 비밀번호로
  등록한다(사용자 확인된 정책). 값이 비어 있으면 자동화를 멈추고 `.env` 설정을 요청한다 — 비밀번호를
  임의로 만들거나 `.env`를 대신 수정하지 않는다(계정 잠금 위험 회피).
- 이후 명령은 저장된 세션이 만료되면 자동으로 재로그인한다(`meta.reLoggedIn`).

## 예약 가능 현황 조회
```
asm stay-availability --region busan-stay [--month 2026-07] [--branch 서면점|부산역1점]
```
- `--month` 미지정 시 사이트가 보여주는 현재 달. 반환 `data.days[]`:
  `{date, dateLabel, branch, branchId, remaining, applyable, formId}` — 예약 가능 요일(금·토 / 토·일)만
  카드로 나타난다.

## 예약 신청
```
asm stay-reserve --region busan-stay --branch 서면점 --date 2026-07-31 [--preview]
```
- 해당 날짜·지점 카드를 찾아 잔여 여부를 확인한 뒤 신청한다(사이트의 SweetAlert2 확인 팝업까지 자동
  처리). **기본 자동 신청**. 미리보기만 하려면 `--preview`(스크린샷만, 신청 안 함).
- 성공 시 `data.applied:true`, 사이트가 예약 내역 화면으로 이동시킨다.

## 예약 내역 조회
```
asm stay-list --region busan-stay [--month 2026-07] [--branch 서면점] [--status REQUESTED|APPROVED|CANCELED|REJECTED]
```
- 반환 `data.reservations[]`: `{date, branch, status, appliedAt, cancelable, cancelFormId}`.

## 예약 취소
```
asm stay-cancel --region busan-stay --branch 서면점 --date 2026-07-31 [--preview]
```
- 예약 내역에서 취소 가능한(`cancelable:true`) 건을 찾아 취소한다(확인 팝업 자동 처리).
- **되돌리기 어려운 작업**이므로 실행 전 한 줄로 확인을 권한다. 이용일 기준 3일 전(주말·공휴일 포함)
  취소가 원칙이며, 미취소/노쇼 위약금은 개인 부담임을 사용자에게 안내한다.

## 내 정보
```
asm stay-profile --region busan-stay
```
- 조회 전용: `data.profile = {type, name, email, phone, agency, workplace}`.

## 안내 사항 (사무국 공지 요약)
- 부산에서 2일(연속) 이상 멘토링·특강·엑스퍼트 활동을 진행하는 경우에만 신청 가능, 금·토 / 토·일
  숙박만 가능.
- 숙소 이용 시 출장 수당은 숙박비를 제외한 금액으로 지급된다(비용 계산은 `asm-mentor-cost` 참고).
- 예약 확정은 이용일 2일 전 Webex 개인 DM으로 통보 + 사이트에서 확인 가능.
