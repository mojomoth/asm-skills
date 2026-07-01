# 스케줄 잡 레시피 (선택 기능)

평소 스킬은 명령 시에만 동작한다. 아래는 사용자가 "스케줄 잡"을 명시할 때 활성화하는 백그라운드 작업이다.
모든 명령은 만료를 감지하면 자동 재로그인하므로, 스케줄 잡은 단지 주기적으로 호출만 하면 세션이 유지된다.

`ASM="node .claude/skills/asm-mentor-core/scripts/asm.mjs"` (프로젝트 루트 기준)

## 1) 세션 keep-alive (서울·부산)
세션 만료를 주기적으로 감지·재로그인해 유지. 만료 시 자동 재로그인됨.
```
$ASM session-status --region seoul   # invalid면 login --force
$ASM session-status --region busan
```
- cron(예: 30분마다): `*/30 * * * *`
- Claude Code에서: `/schedule` 로 "30분마다 ASM 서울·부산 세션 점검·유지" 루틴 생성, 또는 `/loop 30m`.

## 2) 일일 공지/월간일정 다이제스트
새 공지·일정 변경을 매일 요약.
```
$ASM notices-list --region seoul
$ASM notices-list --region busan
$ASM schedule --region seoul --month <이번달>
```
- 직전 결과와 비교해 신규/변경분만 사용자에게 알림.
- cron(매일 09:00): `0 9 * * *`.

## 3) 보고서 미제출 리마인드
지난 멘토링 중 보고서 미작성 건을 찾아 알림.
```
$ASM mento-list --region seoul --mine --month <이번달>
$ASM mento-list --region busan --mine --month <이번달>
$ASM report-list --region seoul --year <올해>
```
- 종료된(마감/지난 날짜) 내 멘토링 중 `.agentdocs/asm/state/reported.json` 또는 보고목록에 없는 건 = 미제출 → 리마인드.

## 활성화 방법
- **Claude Code `/schedule`**: 위 명령을 수행하는 클라우드 루틴을 cron으로 등록(사용자 트리거).
- **OS cron**: 위 명령을 쉘에서 직접 실행(헤드리스). 결과 JSON을 파싱해 알림 채널로 전송.
- keep-alive 외의 잡(다이제스트/리마인드)은 사용자가 명시적으로 요청할 때만 만든다.
