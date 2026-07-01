---
name: asm-mentor-cost
description: >-
  AI·SW 마에스트로 멘토링/특강 비용(강의료 + 부산 출장수당) 계산. 전체(서울+부산)/서울/부산 단위,
  한 달 기준으로 강의료(시간당 200,000원, 하루 인정 1~3시간)와 부산 오프라인 출장수당을 집계한다.
  데이터는 보고 게시판(보고서, 기본)이나 개설된 멘토링/특강 강의에서 가져온다.
  "이번달 멘토링 비용/강의료", "수당 계산", "출장수당", "전체/서울/부산 비용", "한달 정산" 요청에 사용한다.
allowed-tools: Bash, Read
---

# asm-mentor-cost — 멘토링/특강 비용 계산

코어 CLI 사용. 세션/JSON 규칙은 `asm-mentor-core` 참조. 출력은 단일 JSON 1개.

```
asm cost --month 2026-06                         # 전체(서울+부산), 보고서 기준(기본)
asm cost --month 2026-06 --region seoul          # 서울만
asm cost --month 2026-06 --region busan          # 부산만(출장수당 포함)
asm cost --month 2026-06 --source mento          # 개설 강의 시간으로 산출(보고 전 예상치)
asm cost --month 2026-06 --recompute             # 보고서 진행시간으로 재계산 후 지급액과 대조
```

- `--month YYYY-MM` **필수**. `--region all|seoul|busan` (기본 `all`). `--source report|mento` (기본 `report`).

## 계산 규칙
- **강의료** = 인정시간 × `hourlyRate`(기본 200,000원).
- **하루 인정시간** = clamp(해당일 모든 세션 시간 **합산**, 최소 1시간 ~ 최대 3시간).
- `--source report`(기본): 보고 게시판의 **공식 인정시간/지급액을 그대로 신뢰**(사무국이 이미 상한 적용). 지역은
  보고서 `멘토링대상`(서울/부산 연수생), 온/오프라인은 `진행장소`로 판별. `--recompute` 시 진행시간으로 재계산해 지급액과 대조.
- `--source mento`: 내가 개설한 멘토링/특강의 시작~종료 시간으로 직접 계산(보고 전 예상치). 부산은 상세의 진행장소로 온/오프 판별.

## 부산 출장수당
- **부산 '오프라인'** 세션만 대상. **연속된 날짜**를 하나의 출장으로 묶어 일수(days) 산정.
- 출장수당 = `운임(왕복, 출장 1회)` + `숙박비 × (days−1)박` + `일비/식비 × days`.
  - 예) 서울 기준역: 1일=217,400 / 2일=347,400 / 3일=477,400(운임167,400+숙박160,000+일비식비150,000).
- 멘토의 **기준역(homeBase)**·운임표·숙박/일비식비 단가는 데이터 파일에서 읽는다(아래). 부산/경남 거주(운임 0)는 미지급.

## 설정 파일 (편집 가능)
- `asm-mentor-core/references/cost-config.json` — `hourlyRate`, `dailyMinHours`, `dailyMaxHours`.
- `asm-mentor-core/references/travel-allowance.json` — `homeBase`(기준역), `perNightLodging`(80,000),
  `perDayMeals`(50,000), `fareByOrigin`(기준역별 왕복 운임). 출장지/단가가 바뀌면 이 파일만 수정.
- 파일이 없으면 기본값(시간당 200,000원·1~3시간)으로 동작하고 부산 출장수당은 0 처리하며 `warnings`로 알린다.

## 출력(JSON `data`)
- `sessions[]` 세션별 분해(지역/날짜/시간/장소/온오프/인정시간/지급액)
- `days[]` (지역,날짜)별 인정시간·강의료, `trips[]` 부산 출장 묶음과 출장수당 산정
- `regions{seoul,busan}` 지역 소계(강의료+출장수당=subtotal), `total{lectureFee,allowance,grandTotal}`
- `warnings[]` 미승인·시간누락·설정누락 등 주의사항

## 안전
조회 전용(읽기). 보고서/멘토링 데이터를 가져와 계산만 하며 사이트에 아무것도 쓰지 않는다.
