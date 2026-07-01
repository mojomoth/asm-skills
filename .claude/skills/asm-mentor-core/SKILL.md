---
name: asm-mentor-core
description: >-
  AI·SW 마에스트로(swmaestro.ai) 멘토 MY PAGE 자동화 엔진. 서울/부산 로그인·세션 유지와
  공통 CLI(asm.mjs)를 제공한다. "ASM", "AI SW 마에스트로", "마에스트로", "swmaestro",
  "멘토링/특강 등록", "보고서 제출/보고 게시판", "회의실 예약", "부산 숙박 예약",
  "공지/팀매칭/월간일정/활동비/회원정보", "마에스트로 로그인/세션" 관련 작업이면 이 스킬과 하위
  asm-mentor-* 스킬을 사용한다.
allowed-tools: Bash, Read
---

# asm-mentor-core — 마에스트로 멘토 자동화 엔진

`.env`(ASM_HOMEPAGE_ID/PW, ASM_SEOUL/BUSAN_HOMEPAGE_URL)로 서울·부산에 로그인하고
MY PAGE를 자동화하는 Node CLI. 조회는 인증 HTTP(빠름), 쓰기/그리드는 headless 브라우저를 쓴다.
세부 워크플로우는 하위 스킬(`asm-mentor-room`, `asm-mentor-mentoring`, `asm-mentor-report`,
`asm-mentor-board`, `asm-mentor-stay`)에 있고, 모두 이 코어 CLI를 호출한다.

## 실행 방법
프로젝트 루트에서:
```
node .claude/skills/asm-mentor-core/scripts/asm.mjs <command> --region seoul|busan [옵션]
```
- cwd가 다르면 절대경로 사용. 스크립트는 `.env`를 스스로 찾아 세션/산출물 경로를 정한다.
- **출력은 항상 stdout에 JSON 1개**(진단 로그는 stderr). 성공 `{ok:true,command,region,data,meta}` /
  처리된 에러 `{ok:false,error:{code,message,hint,screenshot},meta}` (둘 다 종료코드 0).
  → 명령 실행 후 stdout JSON만 파싱해 사용자에게 한국어로 요약한다.
- `meta.path`: `http`(빠름) 또는 `browser`. `meta.reLoggedIn`: 세션 만료로 재로그인했는지.

## 쓰기 안전 정책 (중요)
- **기본은 자동 제출**(사용자 명령 즉시 실행). 사용자가 "미리보기/preview"라고 하면 `--preview` 를 붙여
  폼만 채우고 스크린샷 후 **제출 직전 정지**한다.
- 삭제/취소(`mento-delete`, `room-cancel`) 등 되돌리기 어려운 작업은 실행 전에 한 줄로 확인을 권한다.
- **보고서 제출(`report-create`)은 사무국 노출+수당과 연결**되므로, 사용자가 실제 제출을 명확히 요청한 경우에만
  자동 제출하고, 그 외에는 `--preview` 로 먼저 보여준다.

## 명령 목록
| 명령 | region | 경로 | 옵션 |
|---|---|---|---|
| `login` / `session-status` | seoul/busan | browser/http | 세션 발급 / 유효성 확인 |
| `recon` | seoul/busan | browser | `--area <a>` 또는 `--url <상대경로>` (구조 재파악) |
| `heal` | seoul/busan | http/browser | `--probe` / `--auto` / `--apply --area a --json'{...}'\|--url p` / `--list` / `--revert[--all]` / `--report` (자가복구 관리) |
| `notices-list` / `notice-view` | seoul/busan | http | `--page` / `--id <nttId>` / `--search` |
| `schedule` | seoul/busan | http | `--month YYYY-MM` |
| `team` | seoul/busan | http | `--searchType member\|mentor\|project\|teamName` `--search` (전체 팀 검색) |
| `roster` | seoul/busan | browser | `--kind mentees\|mentors\|experts` `--search "이름1,이름2"` (Notion 명단, JS 렌더링; 여러 명은 쉼표로 한 번에 — throttle 방지) |
| `member-info` | seoul/busan | http | (조회 전용) |
| `mento-list` / `mento-view` | seoul/busan | http | `--mine` `--month YYYY-MM` `--search` `--searchType 1\|2\|3` / `--id <qustnrSn>` |
| `mento-create` / `mento-update` / `mento-delete` | seoul/busan | browser | `--json` `--files a,b` `--preview` `--force` / `--id` |
| `report-list` / `report-view` | seoul | http | `--year` `--view approved` / `--id <reportId>` |
| `report-draft` / `report-create` | seoul | http/browser | `--qustnrSn` `--mentoRegion` / `--json` `--files` `--preview` `--force` |
| `fund-list` / `fund-view` / `fund-comment` | seoul | http/browser | `--kind project\|device` / `--id <foundId>` / `--text` `--delete` |
| `room-availability` / `room-reserve` / `room-cancel` | seoul/busan | browser | `--date` `--room` `--itemId` `--start` `--end` `--title` `--num` / `--rentId` |
| `screenshot` | seoul/busan | browser | `--url <상대경로>` `--out` `--fullPage` |
| `stay-login` / `stay-availability` / `stay-reserve` / `stay-cancel` / `stay-list` / `stay-profile` | busan-stay | browser | (부산 숙박예약, 별도 로그인) `--month` `--branch` `--date` `--status` `--preview` — 상세는 `asm-mentor-stay` 참조 |

`--json` 은 인라인 JSON 문자열 또는 `@파일경로`. `--files` 는 콤마구분(프로젝트 루트 기준 상대/절대경로).

## 세션 동작
- 서울/부산은 같은 호스트·JSESSIONID를 공유하므로 **region별 별도 storageState**(`.agentdocs/asm/sessions/`)를 쓴다.
- 모든 명령은 만료를 감지하면 `.env`로 **자동 재로그인 후 1회 재시도**한다(`meta.reLoggedIn:true`).
- 명시적 로그인: `asm login --region seoul|busan`. 상태확인: `asm session-status --region ...`.
- `busan-stay`(부산 숙박예약)는 메인 사이트와 **완전히 별도의 로그인/자격증명/세션**을 쓴다
  (`ASM_BUSAN_STAY_BOOKIN_PW`, 자체 로그인폼). `login`/`session-status`가 아닌 `stay-login` 을 쓴다 —
  상세는 `asm-mentor-stay` 참조.

## 에러 코드
`VALIDATION` `LOGIN_FAILED` `SESSION_EXPIRED` `SELECTOR_NOT_FOUND` `ENDPOINT_NOT_FOUND`
`NAV_ERROR` `TIMEOUT` `UPLOAD_FAILED` `WRITE_BLOCKED` `HEAL_NEEDED` `URL_CHANGED` `UNKNOWN`.
디버그 스크린샷 경로가 `error.screenshot`.

## 자가 복구 (self-heal) — 사이트 구조 변경 자동 대응
URL·HTML 구조가 바뀌면 엔진이 **자동으로 감지·복구**한다 (기본 ON; `--no-heal` 또는 `ASM_AUTO_HEAL=0` 으로 끔).

- **Tier-1 (자율 복구)**: 셀렉터가 안 맞으면 `references/selectors.json` 의 `desc`(의미 기반 앵커: name/label/type/value/btnText)로
  현재 DOM에서 요소를 재탐색→검증→**override 레이어에 기록**하고 그 작업을 이어서 수행한다. URL은 경로가 바뀌어도
  안정적인 `?menuNo=` 로 새 경로를 재발견한다. 읽기 명령의 URL drift는 자동 재시도 1회. 성공 시 `meta.healed[]` 에 표시된다.
- **Tier-2 (Claude 위임)**: 자율 복구가 모호하거나(신뢰도↓) 위험한 키(submit/cancel/로그인폼=`criticality:high`)면
  `{ok:false, error:{code:"HEAL_NEEDED", area, key, region, candidates[], reconRef, descriptor, hint}}` 를 반환한다.
  이때 너(Claude)가 해야 할 일:
  1. `error.reconRef` JSON(저장된 DOM 덤프)과 `error.candidates` 를 읽고 올바른 셀렉터/경로를 고른다.
  2. **`asm heal --apply --region <r> --area <area> --json '{"<key>":"<새 css>"}'`** (URL이면 `--url '<상대경로>'`) 로 반영한다.
     → `--apply` 는 제출 전에 그 셀렉터가 페이지에서 유일하게 매칭되는지 **재검증**한 뒤에만 override에 저장한다(환각 방지).
  3. 원래 명령을 다시 실행한다.
- **로그인 폼 변경**은 계정 잠금 위험 때문에 **자동 복구하지 않는다**(항상 Tier-2). `error.reconRef` 확인 후
  `asm heal --apply --area login --on "<로그인 상대경로>" --json '{"username":"#..."}'`.

**중요 — 절대 규칙:** `references/*.json`(번들 기본값+descriptor)은 **직접 수정하지 않는다**. 복구값은 오직 `asm heal --apply`(또는 Tier-1)
가 쓰는 **gitignore된 override 레이어**(`<state>/heal/overrides.json`)에만 들어간다. 잘못된 복구는 `asm heal --revert [--area a --key k] | --all` 로 되돌린다.

### heal 관리 명령
- `asm heal --probe [--area a]` — 매핑된 셀렉터/URL 건강검진(변경 없음). `asm heal --auto [--area a]` — 깨진 키 자율 복구 일괄.
- `asm heal --list` — 현재 override + provenance + ledger. `asm heal --report` — 마지막 HEAL_NEEDED 재출력. `asm heal --force` — 쿨다운/검증 무시.

### 수동 recon (필요 시)
`asm recon --region <r> --area <area>` 또는 `--url <상대경로>` → `.agentdocs/asm/recon/<r>/<area>.{json,html,png,har}`.
상세 구조 메모는 `references/site-notes.md`.

## 배포/환경변수 (플러그인·cron)
- 자격증명: `ASM_HOMEPAGE_ID`/`ASM_HOMEPAGE_PW` 와 `ASM_SEOUL_HOMEPAGE_URL`(있으면 부산도) — 레포 `.env`,
  `~/.config/asm-mentor/.env`, 또는 실제 환경변수(우선순위 높음) 어디서든 읽는다. 플러그인/cron은 환경변수로 주입.
- 런타임 저장 위치: `ASM_STATE_DIR`(명시) → 레포 `.agentdocs/asm`(개발) → `${XDG_STATE_HOME:-~/.local/state}/asm-mentor`(쓰기 가능한 fallback).
  세션·override·recon·아티팩트가 모두 여기 저장되므로 플러그인(읽기전용 설치)에서도 동작한다.
- cron 등 Tier-2 해결자가 없는 환경은 `--auto` 로 돌리고 `HEAL_NEEDED` 는 명확한 실패로 surface 한다.

## 참고 파일 (progressive disclosure)
- `references/site-notes.md` — 페이지별 폼/필드/주의사항(서울·부산 차이 포함).
- `references/selectors.json` — 셀렉터 맵(area→_default/region 오버라이드).
- `references/urls.json` — region 상대 경로 맵. `references/endpoints.json` — 직접 API 맵(향후).
- `references/scheduling.md` — 세션 keep-alive / 공지·일정 다이제스트 / 보고 리마인드 스케줄 잡 레시피.

## 멘토 표준 워크플로우 (하위 스킬이 상세화)
회의실 확인·예약(`asm-mentor-room`) → 멘토링/특강 등록(`asm-mentor-mentoring`, 회의실·시간충돌 교차검사)
→ 수강/개설 확인 → 멘토링 진행 → 보고서 제출(`asm-mentor-report`, 멘토링 자동채움+증빙).
