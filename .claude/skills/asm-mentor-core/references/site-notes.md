# AI·SW 마에스트로 사이트 구조 메모 (recon 2026-06-18)

> 사이트 변경 시 `asm recon --region <r> --area <a>` 또는 `--url <relpath>` 로 재캡처하고
> 이 문서 + `selectors.json` / `urls.json` / `endpoints.json` 를 갱신한다.
> recon 산출물: `.agentdocs/asm/recon/<region>/<area>.{json,html,png,har}`

## 공통
- eGovFrame JSP. 모든 region URL = origin(`https://www.swmaestro.ai`) + prefix(seoul:`/sw`, busan:`/busan/sw`) + path.
- **로그인 폼(서울/부산 동일)**: `#username`, `#password`, hidden `csrfToken`(로드마다 갱신), submit `button.btn-login`(`actionLogin()`), `#login_form` → `toLogin.do`.
- **세션 만료 신호**: 미인증 `…/mypage/…` 요청 → 302 `…/member/user/loginForward.do`.
- **서울/부산 JSESSIONID 공유**(`www.swmaestro.ai` `Path=/`) → region별 별도 storageState/컨텍스트 필수.
- ⚠️ **Playwright 직렬화 버그**: 이 사이트에서 `page.evaluate`가 객체/배열을 반환하면 `undefined`가 됨(문자열/숫자는 정상). → 항상 `dom.mjs`의 `evalJson()`(페이지 내 JSON.stringify) 사용.
- 목록/조회 페이지는 **서버 렌더링 HTML**(XHR 없음) → 읽기는 HTTP GET + `node-html-parser` 파싱(빠른 경로).
- 모든 mypage 페이지에 공용 팀 위젯(`teamFrm`)과 캘린더가 섞여 들어옴 → 파싱 시 대상 폼/테이블을 id로 특정.

## 멘토링/특강 등록 (mento, `forInsert.do` → `board` form POST `mentoLec/insert.do`)
- 강의구분 radio: `#MRC010`=자유멘토링, `#MRC020`=멘토특강 (name=reportCd)
- 모집명: `#qustnrSj`
- 접수기간 radio: `#receiptTypeLecture`=강의시작전까지, `#receiptTypeDirect`=직접입력
  - 접수시작 `#bgndeDate`(text, YYYY-MM-DD) + `#bgndeTime`(select, 값 `HH:MM` 30분단위)
  - 직접입력 시 접수종료 `#enddeDate` + `#enddeTime`
- 강의날짜: `#eventDt`(text) + `#eventStime` + `#eventEtime` (select `HH:MM`)
- 수강인원: `#applyCnt`(text, JS로 채워짐) + 보조 select `#applyNewCnt1`/`#applyNewCnt2` (구분에 따라 노출). 자유멘토링 ≥2, 특강 ≥6.
- 진행장소: `#place` select. **옵션 value=장소명 문자열** (예: `스페이스 A1`, `온라인(Webex)`, 토즈 지점들).
- 첨부: `#file_1_1`(file). 추가 버튼으로 행 증가(`file_1_2`…).
- 본문: **DEXT5Editor** (textarea `#qestnarCn`, iframe `#dext_frame_qestnarCn`). 콘텐츠 주입은 `DEXT5` API 또는 iframe body 타이핑, 폴백 textarea 값 설정.
- hidden: `csrfToken`, `qustnrSn`(신규 빈값), `atchFileId`, `qustnrAt=N`, `stateCd=A`, `openAt=Y`, `menuNo=200046`.
- 제출: 등록 버튼 `onclick=checkForm()`. 취소 버튼은 list.do로 이동.
- **부산 차이**: `progressMethodCd` radio 추가 — `#progressMethodCd0`=온라인, `#progressMethodCd1`=오프라인. 선택에 따라 `#place` 옵션이 바뀜(온라인→online(webex), 오프라인→하이텐/하이스퀘어/외부/센터). 나머지 필드/이름 동일.

## 보고 게시판 등록 (report, `forInsert.do?menuNo=200048` → `board` POST `mentoringReport/insert.do`)
- 멘토링대상 radio: `#menteeRegionCd_0`=서울연수생, `#menteeRegionCd_1`=부산연수생 (name=menteeRegionCd)
- 구분 radio: `#state1_1`=정규멘토링, `#state1_2`=자유멘토링, `#state1_3`=멘토특강 (name=reportGubunCd)
- 진행날짜: `#progressDt`(text)
- 팀명(정규멘토링만): `#teamNmsInput` 입력 + 추가버튼 → hidden `teamNms`(콤마 누적)
- 진행장소: `#progressPlace` select — **멘토링대상 선택 시 옵션이 동적 로드**(초기 `=선택` 1개뿐). region radio 선택 후 대기 필요.
- 참여연수생수: `#attendanceCnt`(text, 이름 추가 시 자동)
- 참여연수생이름: `#attendanceNmsInput` + 추가 → hidden `attendanceNms`
- 진행시간: `#progressStimeHour`/`#progressStimeMin` → hidden `progressStime`; 종료 `#progressEtimeHour`/`#progressEtimeMin` → `progressEtime`. **Min select는 Hour 선택 후 채워짐**(cascade).
- 제외시간: `#exceptStimeHour/Min`, `#exceptEtimeHour/Min` → hidden exceptStime/exceptEtime. 제외사유 `#exceptReason`.
- 멘토링개요: 주제 `#subject`(text), 추진내용 `#nttCn`(textarea ≤500), 멘토의견 `#mentoOpn`(≤100), 기타 `#etc`(≤100).
- 무단불참자: `#nonAttendanceNmsInput` + 추가 → hidden `nonAttendanceNms`.
- 증빙서류(필수): `#upload-name_file_1_1`(표시) + `#file_1_1`(file). 추가+ 버튼으로 행 증가.
- hidden 운반필드: `teamNms`, `attendanceNms`, `nonAttendanceNms`, `progressStime/Etime`, `exceptStime/Etime`, `progressTtime`, `exceptTtime`, `payPrice`, `acceptTime`, `nttSj`, `reportId=0`, `csrfToken`, `menuNo=200048`.
- 제출: 저장 버튼 `onclick=checkForm()`.
- 보고게시판은 **서울 전용**. 부산 멘토링도 서울 보드에 작성하되 멘토링대상=부산연수생으로 구분.

## 회의실 예약 (room)
- 목록 `officeMng/list.do` — 방마다 `officeMng/view.do?menuNo=200058&sdate=YYYY-MM-DD&itemId=N` 예약 링크. 방이름↔itemId는 목록 HTML에서 동적 파싱(아래 매핑은 2026-06 기준, 변동 가능).
  - 서울: 17=스페이스 A1, 18=A2(4인), 19=A3, 21=A4, 22=A5, 23=A6, 28=A7, 29=A8, 30=M1, 47=M2, 48=S1-2, (S3-4=다음 id). 부산은 별도(7월 갱신 예정).
- 예약 화면 `frm` POST → `itemRent/insert.do`. 필드:
  - 제목 `#title`, 예약날짜 `#rentDt`(text), 예약인원 `#rentNum`(text)
  - 시간: 30분 슬롯 체크박스 `input[name=time]` `#time1_1`..`#time1_30` (09:00~23:30). value=슬롯번호, hidden `chkData_N`=`HH:MM`. `<label for=time1_N>` = 표시시간. `onclick=setSt($(this))`.
  - **이미 예약된 슬롯은 런타임 JS로 `disabled` 처리**(정적 HTML엔 없음) + 예약자명은 JS 데이터(`예약자 : 홍길동`). → 가용성은 **live DOM에서 `.disabled` 판독**.
  - 내용 `#infoCn`(textarea). 예약가능 날짜범위 hidden `rentBgnde`/`rentEndde`.
  - 제출: `#saveBtn`(신청하기). 성공 시 itemRent/list로 이동.
- 예약내역 `itemRent/list.do`, 상세 `itemRent/view.do?rentId=`. 취소 버튼 존재.
- 외부 토즈는 스킬 범위 외(브라우저 링크 안내만).

## 신청/접수 (fund, 서울 전용)
- IT기기/자기주도학습 `myFound/list.do?menuNo=200053`, 프로젝트활동비 `…?menuNo=200054`.
- 활동비 상세 `projectSpt/view.do?foundId=&menuNo=200054` — 멘토 평가의견 입력/삭제(활동비당 1개 이상 필요). 상세 폼 셀렉터는 view 페이지 recon 후 보강.

## 조회 페이지(파싱)
- 공지 `myNotice/list.do` — 테이블(NO/제목/작성자/등록일), 행의 view 링크 `nttId`(또는 view.do?…). 상세 `myNotice/view.do?nttId=`.
- 월간일정 `schedule/list.do` — 캘린더 + 주요일정 테이블.
- 팀매칭 `myTeam/team.do` — 팀 테이블(팀명/팀장/팀원/멘토명/프로젝트/ICT분류). 연수생·멘토·Expert는 Notion(별도 MCP).
- 멘토링 목록 `mentoLec/list.do` — listFrm. 행 view 링크 `qustnrSn`. 상세 `mentoLec/view.do?qustnrSn=` (신청자/참여자 목록 포함 → 보고서 자동채움 소스).
- 보고 목록 `mentoringReport/list.do` — frm. 상세 `mentoringReport/view.do?reportId=` (인정시간/지급액/사무국의견).
- 회원정보 `myInfo/forUpdateMy.do` — 조회만(수정 미지원).

## 직접 POST(향후 최적화)
쓰기는 현재 브라우저 경로(폼 채움+제출) 사용. 직접 POST 엔드포인트(참고): `mentoLec/insert.do`, `mentoringReport/insert.do`, `itemRent/insert.do` — 모두 `csrfToken` hidden 필요. DEXT5 본문/파일업로드/동적 cascade 때문에 직접 POST는 보류.
