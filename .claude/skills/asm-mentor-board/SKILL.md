---
name: asm-mentor-board
description: >-
  AI·SW 마에스트로 조회 기능 묶음 — 공지사항, 월간일정, 팀매칭(+Notion 연수생/멘토/Expert 목록),
  회원정보(조회 전용), 신청/접수(IT기기·자기주도학습·프로젝트 활동비 + 멘토 평가의견). "공지 확인",
  "이번달 일정", "내 팀/팀원/멘토 목록", "연수생 명단", "활동비/평가의견", "회원정보" 요청에 사용한다.
allowed-tools: Bash, Read, mcp__claude_ai_Notion__notion-fetch, mcp__claude_ai_Notion__notion-search
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

## 팀매칭 (+ Notion)
```
asm team --region seoul|busan [--search 키워드]         # 팀명/팀장/팀원/멘토/프로젝트/ICT분류
```
- 반환 `data.notion` 에 region별 연수생/멘토/Expert Notion URL이 들어있다.
- 연수생·멘토·Expert 명단은 **Notion MCP** 로 읽는다: `notion-fetch`(해당 URL) →
  데이터베이스이므로 페이지네이션/더보기를 따라 전체 행을 수집한다. 홈페이지 팀 정보와 교차 확인.

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
