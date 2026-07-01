---
name: asm-mentor-report
description: >-
  AI·SW 마에스트로 보고 게시판(서울 전용; 부산 멘토링도 서울 보드에 작성). 멘토링 보고서 제출 내역/승인
  내역(인정시간·지급액) 조회와, 진행한 멘토링/특강 정보를 자동으로 끌어와 보고서를 작성·제출한다.
  "멘토링 보고서 작성/제출", "보고 게시판", "이번달 인정시간/수당", "증빙 첨부" 요청에 사용한다.
allowed-tools: Bash, Read
---

# asm-mentor-report — 보고 게시판

코어 CLI 사용(보고는 항상 서울 보드 = `--region seoul`). 세션/JSON/preview 규칙은 `asm-mentor-core` 참조.

## 조회
```
asm report-list --region seoul [--year 2026] [--view approved]   # 승인내역=인정시간/지급액
asm report-view --region seoul --id <reportId>                   # 인정시간/지급액/사무국의견
```

## 보고서 작성 (자동채움 워크플로우)
1. **초안 확인(읽기)**: 보고할 멘토링의 qustnrSn으로 자동채움 모델을 본다.
```
asm report-draft --region seoul --qustnrSn <id> --mentoRegion seoul|busan
```
   → `model`: 멘토링대상(=멘토 지역), 구분(자유/특강), 진행날짜, 진행장소, 참여연수생 이름·수,
   진행 시작/종료시간, 주제(=모집명), 추진내용(=멘토링 본문). `provenance` 가 auto/manual을 표시.
   사용자에게 표로 보여주고 수정할 필드를 묻는다(수동 오버라이드 가능).

2. **제출**:
```
asm report-create --region seoul --json '{
  "qustnrSn":"12168", "mentoRegion":"seoul",
  "overrides":{ "category":"정규 멘토링", "teamName":"재학자들", "mentorOpinion":"적극 참여" },
  "autoScreenshot": true
}' [--files 증빙1.pdf,증빙2.png] [--preview] [--force]
```
   - 기본은 멘토링에서 **자동채움**. `overrides` 로 필요한 필드만 수동 변경(빈 값은 멘토링 값 유지).
   - **정규 멘토링**은 멘토링에서 도출 불가 → `overrides.category:"정규 멘토링"` + `overrides.teamName` 필요.
   - **참여 연수생 수는 이름 개수로 자동**(수동 입력 불가). 이름 조정은 `overrides.attendees:[...]`.
   - 직접 모델 전체를 주려면 `qustnrSn` 없이 모델 필드를 그대로 `--json` 으로 전달(이때 autoScreenshot 기본 false).

## 증빙서류 (필수)
- 보고서에는 증빙이 **반드시 1개 이상** 필요하다.
- `--files` 로 준 파일을 업로드하고, `autoScreenshot:true`(qustnrSn이 있을 때 기본)면 해당 멘토링/특강 화면을
  fullPage 스크린샷으로 캡처해 증빙에 자동 첨부한다. 증빙이 하나도 없으면 `VALIDATION` 으로 막는다.

## 중복 방지
- 같은 멘토링을 두 번 보고하지 않도록 `{region}:{qustnrSn}` 로컬 원장(`.agentdocs/asm/state/reported.json`)과
  보고 목록의 날짜·구분·장소 유사매칭으로 검사한다. 이미 보고된 경우 `WRITE_BLOCKED` → 재제출은 `--force`.

## 안전
보고서는 사무국 노출+수당과 직결된다. 사용자가 실제 제출을 명확히 요청하지 않았다면 `--preview` 로 먼저 보여주고
확인을 받는다. `--preview` 는 폼을 모두 채우고 스크린샷만 남긴 뒤 제출하지 않는다.
