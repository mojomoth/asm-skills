# asm-skills — AI·SW 마에스트로 멘토 자동화 스킬 모음

[AI·SW 마에스트로(swmaestro.ai)](http://swmaestro.ai/) 멘토 **MY PAGE**를 자동화하는 Claude Code 스킬 모음입니다.
서울/부산 로그인·세션 유지부터 회의실 예약, 멘토링·특강 등록, 보고서 제출, 공지·일정·팀 조회까지
멘토 업무 전반을 자연어 명령으로 처리합니다.

> 모든 스킬은 한국어로 동작하며, 하나의 공통 엔진(`asm.mjs`)을 호출합니다.

---

## 구성

`.claude/skills/` 아래 6개의 스킬로 이루어져 있습니다.

| 스킬 | 역할 |
|---|---|
| **asm-mentor-core** | 자동화 엔진 + 공통 CLI(`asm.mjs`). 서울/부산 로그인·세션 유지, 모든 하위 스킬이 이 CLI를 호출 |
| **asm-mentor-room** | 회의실 예약 — 30분 슬롯 가용시간 조회, 예약 신청, 예약 취소 |
| **asm-mentor-mentoring** | 멘토링/특강 게시판 — 목록·상세·신청자 조회, 내 강의 등록·수정·삭제(회의실 확보 + 시간충돌 검사) |
| **asm-mentor-report** | 보고 게시판(서울 전용) — 보고서 제출/승인 내역(인정시간·지급액) 조회, 진행 멘토링 자동채움 후 제출 |
| **asm-mentor-board** | 조회 묶음 — 공지사항, 월간일정, 팀매칭(+Notion 명단), 회원정보, 신청·접수(활동비/평가의견) |
| **asm-mentor-cost** | 비용 계산 — 전체/서울/부산, 한 달 기준 강의료(시간당 200,000원, 하루 1~3시간) + 부산 오프라인 출장수당 |

### 동작 방식

- **조회**는 인증된 HTTP 요청으로 처리해 빠르고, **쓰기/그리드 조작**은 headless 브라우저(Playwright)를 사용합니다.
- 서울/부산은 같은 호스트·세션을 공유하므로 **region별 별도 세션(storageState)** 으로 분리 관리합니다.
- 모든 명령은 세션 만료를 감지하면 `.env` 정보로 **자동 재로그인 후 1회 재시도**합니다.
- 출력은 항상 **stdout에 단일 JSON**(`{ok, command, region, data, meta}`)으로 반환되어, 결과를 한국어로 요약해 전달합니다.

---

## 설치

### 요구 사항
- Node.js 18+ (ESM)
- 엔진 의존성: `playwright`, `node-html-parser`

### 1. 의존성 설치 및 브라우저 다운로드
```bash
cd .claude/skills/asm-mentor-core
npm install
npx playwright install chromium
```

### 2. 환경 변수 설정
프로젝트 루트에 `.env`를 만들고 마에스트로 계정 정보를 넣습니다. (`.env.example` 참고)

```bash
cp .env.example .env
# .env 를 열어 ID/PW 입력
```

```ini
ASM_SEOUL_HOMEPAGE_URL=http://swmaestro.ai/
ASM_BUSAN_HOMEPAGE_URL=http://swmaestro.ai/busan
ASM_HOMEPAGE_ID=your-id@example.com
ASM_HOMEPAGE_PW=your-password
```

> `.env`는 실제 자격증명을 담으므로 **절대 커밋하지 마세요.** (`.gitignore`에 이미 제외되어 있습니다.)

---

## 사용법

Claude Code에서 자연어로 요청하면 적절한 스킬이 선택됩니다. 예:

- "이번 주 서울 스페이스 A1 회의실 빈 시간 알려줘"
- "6월 25일 14시~16시로 멘토링 특강 등록해줘"
- "이번 달 인정시간이랑 지급액 보여줘"
- "최근 공지사항 확인해줘"

엔진 CLI를 직접 실행할 수도 있습니다(프로젝트 루트 기준):

```bash
node .claude/skills/asm-mentor-core/scripts/asm.mjs <command> --region seoul|busan [옵션]
```

### 주요 명령

| 명령 | region | 설명 |
|---|---|---|
| `login` / `session-status` | seoul/busan | 세션 발급 / 유효성 확인 |
| `notices-list` / `notice-view` | seoul/busan | 공지사항 목록·상세 |
| `schedule` | seoul/busan | 월간 일정(`--month YYYY-MM`) |
| `team` / `member-info` | seoul/busan | 팀매칭 / 회원정보(조회) |
| `mento-list` / `mento-view` | seoul/busan | 멘토링·특강 목록·상세 |
| `mento-create` / `mento-update` / `mento-delete` | seoul/busan | 멘토링 등록·수정·삭제 |
| `report-list` / `report-view` | seoul | 보고서 제출/승인 내역 |
| `report-draft` / `report-create` | seoul | 보고서 자동채움 / 제출 |
| `room-availability` / `room-reserve` / `room-cancel` | seoul/busan | 회의실 가용시간·예약·취소 |
| `screenshot` / `recon` | seoul/busan | 화면 캡처 / 사이트 구조 재파악 |

전체 명령·옵션은 [`asm-mentor-core/SKILL.md`](.claude/skills/asm-mentor-core/SKILL.md)를 참고하세요.

---

## 쓰기 안전 정책

- **기본은 자동 제출** — 사용자가 명령하면 즉시 실행합니다.
- `--preview` 옵션을 붙이면 폼만 채우고 **제출 직전에 정지**한 뒤 스크린샷을 남깁니다("미리보기" 요청 시 적용).
- **삭제/취소**(`mento-delete`, `room-cancel`) 등 되돌리기 어려운 작업은 실행 전에 확인을 권합니다.
- **보고서 제출**(`report-create`)은 사무국 노출·수당과 연결되므로, 명확히 제출을 요청한 경우에만 자동 제출합니다.

---

## 자가 복구 (사이트 구조 변경 시)

마에스트로 사이트 구조가 바뀌어 `SELECTOR_NOT_FOUND` / `ENDPOINT_NOT_FOUND` 에러가 나면:

1. `asm recon --region <r> --area <area>`(또는 `--url <상대경로>`)로 폼/인풋/셀렉터/HAR을 덤프합니다.
2. 덤프를 보고 `references/selectors.json` · `urls.json` · `endpoints.json`의 셀렉터·경로를 수정합니다.
3. 페이지별 상세 메모는 `references/site-notes.md`를 참고합니다.

---

## 디렉터리 구조

```
.
├── .claude/
│   ├── settings.json            # 관찰(observe) 훅 설정
│   ├── hooks/observe.sh
│   └── skills/
│       ├── asm-mentor-core/     # 엔진 + CLI(scripts/asm.mjs) + references/
│       ├── asm-mentor-room/
│       ├── asm-mentor-mentoring/
│       ├── asm-mentor-report/
│       ├── asm-mentor-board/
│       └── asm-mentor-cost/
├── .agentdocs/                  # 런타임 산출물(세션·recon·스크린샷·로그) — 대부분 gitignore
├── .env                         # 자격증명 (gitignore)
└── .env.example
```

---

## 주의

- 본 도구는 **본인 멘토 계정**의 MY PAGE 업무 자동화를 위한 것입니다. 자격증명과 산출물(`.agentdocs/asm/`)은 외부에 공유하지 마세요.
- 외부 토즈 회의실 예약은 범위 외이며, 브라우저 링크만 안내합니다.
