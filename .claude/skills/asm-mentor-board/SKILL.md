---
name: asm-mentor-board
description: >-
  AI·SW 마에스트로 조회 기능 묶음 — 공지사항, 월간일정, 팀매칭(연수생/멘토/프로젝트/팀명 검색),
  연수생·멘토·Expert 명단(Notion), 회원정보(조회 전용), 신청/접수(IT기기·자기주도학습·프로젝트 활동비 +
  멘토 평가의견). "공지 확인", "이번달 일정", "내 팀/팀원/멘토 목록", "연수생/멘토 정보", "연수생 명단",
  "활동비/평가의견", "회원정보" 요청에 사용한다.
allowed-tools: Bash, Read
---

# asm-mentor-board — 조회 묶음 (공지/일정/팀/회원/신청·접수)

코어 CLI 사용. 세션/JSON 규칙은 `asm-mentor-core` 참조.

## 공지사항
```
asm notices-list --region seoul|busan [--page N] [--search 키워드 --searchType 1|2|3]
asm notice-view  --region seoul|busan --id <nttId>     # 제목/작성자/등록일/첨부/본문
```

## 월간일정
```
asm schedule --region seoul|busan [--month 2026-06]    # 주요 월간 일정 목록
```

## 팀매칭
```
asm team --region seoul|busan [--searchType member|mentor|project|teamName] [--search 키워드]
```
- 검색조건(`--searchType`)으로 사이트 검색 인터페이스의 모든 조건을 지원한다 (서버사이드 검색):
  `member`=연수생명, `mentor`=멘토명, `project`=프로젝트명, `teamName`=팀명. 생략 시 **전체**(모든 필드).
- 반환 `data.teams[]`: `{no, teamName, teamId, leader, members, mentors, project, ictMajor, ictMinor}`
  (전체 팀 대상 — 본인 매칭 팀만이 아니라 검색어에 맞는 팀 전부). `data.notion` 에 명단 Notion URL.
- 예: `asm team --region busan --searchType member --search 안용수` → 안용수가 속한 팀(SMP500) 반환.

## 연수생/멘토/Expert 명단 (Notion, JS 렌더링)
```
asm roster --region seoul|busan [--kind mentees|mentors|experts] [--search 키워드]
```
- 공개 Notion 명단을 **브라우저로 가져온다**(페이지의 queryCollection API를 가로채 전체 행을 한 번에 수집).
  Notion MCP 불필요. 반환 `data.rows[]`(컬럼명 보존), `data.columns`, `data.count`/`data.totalCount`.
- `--kind` 기본값 `mentees`(연수생). 멘토는 `mentors`, Expert는 `experts`.
- **라우팅: "연수생 정보/명단 조회"는 `roster --kind mentees`, "멘토 정보/명단 조회"는 `roster --kind mentors`.**
  특정 인물은 `--search 이름` 으로 필터. 팀 소속까지 필요하면 `team --searchType member --search 이름` 과 교차 확인.
- 예: `asm roster --region busan --kind mentees --search 안용수` → 안용수 연수생 카드(이름/기술스택/거주지/연락처 등).

## 회원정보 (조회 전용)
```
asm member-info --region seoul|busan                    # 아이디/이름/연락처/주소/소속/직책
```
수정은 민감 항목이라 지원하지 않는다. 필요하면 반환된 `editUrl` 을 브라우저로 열어 직접 수정하도록 안내.

## 신청/접수 (서울 전용)
```
asm fund-list --region seoul --kind project|device      # 프로젝트 활동비 / IT기기·자기주도학습
asm fund-view --region seoul --id <foundId>
asm fund-comment --region seoul --id <foundId> --text "평가의견"   # 입력 (활동비엔 1개 이상 필요)
```
- `fund-comment` 의 의견 입력란 셀렉터가 사이트에서 바뀌었으면 `SELECTOR_NOT_FOUND` + recon 힌트가 나온다 →
  `asm recon --region seoul --url "/mypage/projectSpt/view.do?menuNo=200054&foundId=<id>"` 후
  `references/selectors.json[fund]` 보강.
