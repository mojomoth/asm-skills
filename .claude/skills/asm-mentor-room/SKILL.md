---
name: asm-mentor-room
description: >-
  AI·SW 마에스트로 회의실 예약. 서울/부산 회의실의 30분 슬롯 가용시간 조회, 예약 신청, 예약 취소.
  "회의실 예약/조회/취소", "스페이스 A1~M2/S1-4", "하이텐/하이스퀘어 회의실", "빈 회의실/가능한 시간"
  요청에 사용한다. (외부 토즈 예약은 범위 외 — 브라우저 링크만 안내)
allowed-tools: Bash, Read
---

# asm-mentor-room — 회의실 예약

코어 CLI 사용: `node .claude/skills/asm-mentor-core/scripts/asm.mjs <cmd> --region seoul|busan ...`
세션/JSON 규칙은 `asm-mentor-core` SKILL 참조.

## 가용시간 조회
```
asm room-availability --region seoul --date 2026-06-25 [--room "스페이스 A1" | --itemId 17]
```
- 반환 `data.rooms[]`: `{name, itemId, capacity, freeCount, slots:[{time,status:free|taken,reserver}]}` (30분 단위).
- `--room`/`--itemId` 없으면 그 날짜의 모든 회의실을 조회(느림). 가능하면 방을 지정.
- 서울 방: 스페이스 A1~A8, M1·M2, 7층 S1-2·S3-4. 부산: 하이텐/하이스퀘어(7월 갱신 예정). itemId는 날짜별로 동적 조회됨.

## 예약
```
asm room-reserve --region seoul --date 2026-06-25 --room "스페이스 A1" \
  --start 14:00 --end 16:00 --title "OO 멘토링" --num 5 [--content "..."] [--preview] [--force]
```
- `--start`~`--end` 사이 **연속 30분 슬롯**을 자동 체크. 이미 예약된 슬롯이 있으면 예약자명과 함께 `WRITE_BLOCKED`(필요 시 `--force`).
- 예약 직전 그리드를 재확인해 stale 충돌을 막는다. 성공 시 `data.reserved:true`.
- **기본 자동 신청**. 사용자가 미리보기를 원하면 `--preview`(폼+슬롯 체크 후 스크린샷, 신청 안 함).

## 취소
```
asm room-cancel --region seoul --rentId 20479 [--preview]
```
- 취소는 되돌리기 어려우므로 실행 전 한 줄로 확인을 권한다.
- 예약내역(rentId)은 `asm screenshot --url "/mypage/itemRent/list.do?menuNo=200059"` 로 확인하거나
  예약 직후 반환 URL에서 확인.

## 멘토링 등록과의 연계
멘토링/특강을 열기 전에 이 스킬로 회의실을 먼저 확보하고, 그 방 이름을 `asm-mentor-mentoring` 의
`place` 로 넘긴다(진행장소 옵션 value = 회의실 이름 문자열, 예: "스페이스 A1").
