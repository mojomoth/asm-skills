---
name: asm-mentor-core
description: >-
  AI·SW 마에스트로(swmaestro.ai) 멘토 MY PAGE 자동화 엔진. 서울/부산 로그인·세션 유지와
  공통 CLI(asm.mjs)를 제공한다. "ASM", "AI SW 마에스트로", "마에스트로", "swmaestro",
  "멘토링/특강 등록", "보고서 제출/보고 게시판", "회의실 예약", "공지/팀매칭/월간일정/활동비/회원정보",
  "마에스트로 로그인/세션" 관련 작업이면 이 스킬과 하위 asm-mentor-* 스킬을 사용한다.
allowed-tools: Bash, Read
---

# asm-mentor-core — 마에스트로 멘토 자동화 엔진

`.env`(ASM_HOMEPAGE_ID/PW, ASM_SEOUL/BUSAN_HOMEPAGE_URL)로 서울·부산에 로그인하고
MY PAGE를 자동화하는 Node CLI. 조회는 인증 HTTP(빠름), 쓰기/그리드는 headless 브라우저를 쓴다.
세부 워크플로우는 하위 스킬(`asm-mentor-room`, `asm-mentor-mentoring`, `asm-mentor-report`,
`asm-mentor-board`)에 있고, 모두 이 코어 CLI를 호출한다.

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
| `notices-list` / `notice-view` | seoul/busan | http | `--page` / `--id <nttId>` / `--search` |
| `schedule` | seoul/busan | http | `--month YYYY-MM` |
| `team` | seoul/busan | http | `--searchType member\|mentor\|project\|teamName` `--search` (전체 팀 검색) |
| `roster` | seoul/busan | browser | `--kind mentees\|mentors\|experts` `--search` (Notion 명단, JS 렌더링) |
| `member-info` | seoul/busan | http | (조회 전용) |
| `mento-list` / `mento-view` | seoul/busan | http | `--mine` `--month YYYY-MM` `--search` `--searchType 1\|2\|3` / `--id <qustnrSn>` |
| `mento-create` / `mento-update` / `mento-delete` | seoul/busan | browser | `--json` `--files a,b` `--preview` `--force` / `--id` |
| `report-list` / `report-view` | seoul | http | `--year` `--view approved` / `--id <reportId>` |
| `report-draft` / `report-create` | seoul | http/browser | `--qustnrSn` `--mentoRegion` / `--json` `--files` `--preview` `--force` |
| `fund-list` / `fund-view` / `fund-comment` | seoul | http/browser | `--kind project\|device` / `--id <foundId>` / `--text` `--delete` |
| `room-availability` / `room-reserve` / `room-cancel` | seoul/busan | browser | `--date` `--room` `--itemId` `--start` `--end` `--title` `--num` / `--rentId` |
| `screenshot` | seoul/busan | browser | `--url <상대경로>` `--out` `--fullPage` |

`--json` 은 인라인 JSON 문자열 또는 `@파일경로`. `--files` 는 콤마구분(프로젝트 루트 기준 상대/절대경로).

## 세션 동작
- 서울/부산은 같은 호스트·JSESSIONID를 공유하므로 **region별 별도 storageState**(`.agentdocs/asm/sessions/`)를 쓴다.
- 모든 명령은 만료를 감지하면 `.env`로 **자동 재로그인 후 1회 재시도**한다(`meta.reLoggedIn:true`).
- 명시적 로그인: `asm login --region seoul|busan`. 상태확인: `asm session-status --region ...`.

## 에러 코드
`VALIDATION` `LOGIN_FAILED` `SESSION_EXPIRED` `SELECTOR_NOT_FOUND` `ENDPOINT_NOT_FOUND`
`NAV_ERROR` `TIMEOUT` `UPLOAD_FAILED` `WRITE_BLOCKED` `UNKNOWN`.
`SELECTOR_NOT_FOUND`/`ENDPOINT_NOT_FOUND` 가 나면 사이트 구조가 바뀐 것 → `error.hint`의 recon 명령을
실행하고 `references/selectors.json`(또는 `urls.json`)를 갱신한다. 디버그 스크린샷 경로가 `error.screenshot`.

## 사이트 구조가 바뀌었을 때 (자가 복구)
1. `asm recon --region <r> --area <area>` 또는 `--url <상대경로>` 실행 → `.agentdocs/asm/recon/<r>/` 에
   `<area>.json`(폼/인풋/셀렉트옵션/버튼onclick/HAR), `.html`, `.png` 저장.
2. 덤프를 보고 `references/selectors.json` / `urls.json` / `endpoints.json` 의 셀렉터·경로를 수정.
3. 상세 구조 메모는 `references/site-notes.md` 참고(폼 차이·DEXT5 에디터·캐스케이드·슬롯 그리드 등).

## 참고 파일 (progressive disclosure)
- `references/site-notes.md` — 페이지별 폼/필드/주의사항(서울·부산 차이 포함).
- `references/selectors.json` — 셀렉터 맵(area→_default/region 오버라이드).
- `references/urls.json` — region 상대 경로 맵. `references/endpoints.json` — 직접 API 맵(향후).
- `references/scheduling.md` — 세션 keep-alive / 공지·일정 다이제스트 / 보고 리마인드 스케줄 잡 레시피.

## 멘토 표준 워크플로우 (하위 스킬이 상세화)
회의실 확인·예약(`asm-mentor-room`) → 멘토링/특강 등록(`asm-mentor-mentoring`, 회의실·시간충돌 교차검사)
→ 수강/개설 확인 → 멘토링 진행 → 보고서 제출(`asm-mentor-report`, 멘토링 자동채움+증빙).
