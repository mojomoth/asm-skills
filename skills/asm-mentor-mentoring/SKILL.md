---
name: asm-mentor-mentoring
description: >-
  AI·SW 마에스트로 멘토링/특강 게시판. 멘토링·특강 목록/상세/신청자 조회와 내 강의 등록·수정·삭제.
  "멘토링/특강 등록·개설·수정·삭제", "자유 멘토링/멘토 특강 열기", "내 멘토링 신청자/수강 확인",
  "MY 멘토링" 요청에 사용한다. 등록 시 회의실 확보와 서울·부산 시간충돌 검사를 함께 한다.
allowed-tools: Bash, Read
---

# asm-mentor-mentoring — 멘토링/특강 게시판

코어 CLI 사용. 세션/JSON/preview 규칙은 `asm-mentor-core` 참조. 서울/부산 폼이 다르다(부산은 진행방식 추가).

## 조회
```
asm mento-list --region seoul --mine [--month 2026-06] [--search 키워드 --searchType 1|2|3]
asm mento-view --region seoul --id <qustnrSn>
```
- list 항목: `{qustnrSn,title,date,start,end,capacity,status,author,...}` (진행날짜에서 시작~종료 파싱됨).
- view: `{title,category,date,startTime,endTime,place,capacity,status, applicants[], attendeeNames[]}`.
  신청자/참여자 목록은 보고서 자동채움의 소스가 된다.

## 등록 (워크플로우)
1. **회의실 먼저 확보**: `asm-mentor-room` 으로 가용시간 확인 후 예약하고, 그 방 이름을 `place` 로 사용.
2. **시간충돌 검사**: `mento-create` 는 등록 전 서울+부산의 내 멘토링을 모아 같은 날 시간겹침을 자동 검사한다.
   겹치면 `WRITE_BLOCKED`(+conflicts) → 시간 변경 또는 `--force`.
3. 등록 실행:
```
asm mento-create --region seoul --json '{
  "category":"자유멘토링",            // 또는 "멘토특강"
  "title":"제목",
  "receiptType":"before",            // 강의시작전까지 | "direct"(직접입력: endDate/endTime 추가)
  "bgnDate":"2026-06-25","bgnTime":"09:00",
  "eventDate":"2026-06-26","startTime":"10:00","endTime":"12:00",
  "capacity":2,                       // 자유멘토링 ≥2, 특강 ≥6
  "place":"스페이스 A1",
  "body":"<p>본문(HTML)</p>"
}' [--files 첨부.pdf] [--preview] [--force]
```
- 부산은 `"method":"온라인"|"오프라인"` 추가(진행장소 옵션이 바뀜: 온라인→online(webex), 오프라인→하이텐/하이스퀘어/외부/센터).
- 시간 값은 `HH:MM`(30분 단위). 강의날짜는 접수기간 이후여야 한다.
- **기본 자동 등록**. 미리보기는 `--preview`(폼 채움+스크린샷, 등록 안 함). 본문 에디터는 DEXT5(자동 처리).

## 수정 / 삭제
```
asm mento-update --region seoul --id <qustnrSn> --json '{ "title":"새 제목", ... }'
asm mento-delete --region seoul --id <qustnrSn>          # 되돌릴 수 없음 → 실행 전 확인 권장
```

## 등록 후
`mento-view` 로 신청자 수/개설 여부를 확인한다. 멘토링이 끝나면 `asm-mentor-report` 로 보고서를 제출한다
(이 멘토링의 qustnrSn으로 자동채움).
