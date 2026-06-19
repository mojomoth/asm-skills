# `.agentdocs/` 기반 Claude Code 세션 관측 훅

## 1. 목표

Claude Code 세션에서 발생하는 핵심 활동을 가볍게 관측하기 위해 `.agentdocs/` 폴더에 로그를 남긴다.

관측 대상은 다음 4가지다.

1. **입력 프롬프트**
2. **Plan Mode에서 생성된 플랜**
3. **실행 턴 종료 시 실행 내역**(플랜모드가 아닌 '실행' 턴의 LLM 요약)
4. **세션 종료 시 핸드오프 정보**

복잡한 구조나 많은 파일 생성을 피하고, 최소한의 훅과 로그 파일만 유지한다.

> 참고: 본 문서는 초기 3종 관측 설계에서 출발해, 이후 ③ 실행 턴 관측과 핸드오프 가드를
> 추가한 최종 구현을 종합한 것이다.

---

## 2. 전제

현재 레포는 거의 빈 프로젝트이며, Claude Code 훅을 이용해 세션 활동을 기록한다.

확인된 Claude Code 훅 동작은 다음과 같다.

| 이벤트                         | 확인된 내용                                                                                                                  |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `UserPromptSubmit`             | stdin JSON의 `.prompt`에 사용자 입력 프롬프트가 들어온다. matcher는 필요 없다.                                               |
| `PostToolUse` + `ExitPlanMode` | Plan Mode 종료 시점에 실행된다. 훅 페이로드에는 플랜 본문이 없지만, 플랜 파일은 이미 `~/.claude/plans/*.md`에 저장되어 있다. |
| `Stop`                         | 어시스턴트가 한 턴을 마칠 때마다 실행된다. stdin JSON에 `.session_id`, `.transcript_path`, `.stop_hook_active`가 제공된다.   |
| `SessionEnd`                   | stdin JSON에 `.reason`, `.transcript_path`, `.session_id`가 제공된다.                                                        |
| 공통                           | `$CLAUDE_PROJECT_DIR` 환경변수로 프로젝트 루트 절대경로를 얻을 수 있다.                                                      |
| JSON 처리                      | `jq 1.8.1` 사용 가능이 확인되었다.                                                                                           |
| LLM 호출                       | `claude 2.1.181` CLI 사용 가능. `claude -p`로 헤드리스 요약이 가능하다.                                                      |

주의: 본 환경은 darwin이며 GNU `timeout`이 기본 제공되지 않는다. Stop 요약은 타임아웃 대신
**백그라운드 실행**으로 사용자 블로킹을 회피한다.

---

## 3. 설계 요약

신규 파일은 2개만 만든다.

```text
.claude/
  settings.json
  hooks/
    observe.sh

.agentdocs/
  logs/
    prompts-YYYY-MM-DD.md
    plans-YYYY-MM-DD.md
    executions-YYYY-MM-DD.md
    handoff-YYYY-MM-DD.md
```

`.claude/hooks/observe.sh` 하나를 네 개의 훅 이벤트에 공통 등록하고, 이벤트 이름에 따라 분기 처리한다.

`.agentdocs/`는 관측 산출물만 저장하는 공간으로 유지한다.

---

## 4. 신규 파일

### 4.1 `.claude/hooks/observe.sh`

모든 훅에서 호출되는 단일 디스패처 스크립트다.

역할:

- 최상단에서 **재귀 방지 가드**를 적용한다.
- `UserPromptSubmit` 발생 시 입력 프롬프트 기록
- `PostToolUse` + `ExitPlanMode` 발생 시 최신 Plan 파일 기록
- `Stop` 발생 시 플랜모드가 아닌 '실행' 턴의 실행 내역을 LLM으로 요약해 기록
- `SessionEnd` 발생 시(프롬프트가 1건 이상일 때만) 핸드오프 메타데이터 기록

```bash
#!/usr/bin/env bash
# Claude Code 세션 관측 디스패처.
# UserPromptSubmit / PostToolUse(ExitPlanMode) / Stop / SessionEnd 네 이벤트가 공통 호출한다.
# 산출물은 .agentdocs/logs/ 아래 날짜별 파일로 누적된다.

# 재귀 방지: Stop 분기가 claude -p 를 호출하면 그 헤드리스 세션이 다시 훅을 발화시킨다.
# Stop 핸들러가 OBSERVE_NO_SUMMARY=1 을 export 한 채 claude 를 부르므로, 중첩 세션의
# 모든 훅 이벤트는 여기서 즉시 종료되어 로그를 오염시키지 않는다.
[ -n "$OBSERVE_NO_SUMMARY" ] && exit 0

input=$(cat)
ev=$(printf '%s' "$input" | jq -r '.hook_event_name')
dir="${CLAUDE_PROJECT_DIR:-.}/.agentdocs/logs"
mkdir -p "$dir"
day=$(date "+%Y-%m-%d")
ts=$(date "+%Y-%m-%d %H:%M:%S")
sid=$(printf '%s' "$input" | jq -r '.session_id // "?"' | cut -c1-8)

case "$ev" in
  UserPromptSubmit)
    p=$(printf '%s' "$input" | jq -r '.prompt // ""')
    { echo "## $ts  (session $sid)"; echo; echo "$p"; echo; echo "---"; echo; } >> "$dir/prompts-$day.md" ;;
  PostToolUse)   # matcher가 ExitPlanMode로 한정됨
    f=$(ls -t "$HOME/.claude/plans/"*.md 2>/dev/null | head -1)
    { echo "## $ts  (session $sid)"; echo;
      if [ -n "$f" ]; then echo "<!-- src: $f -->"; cat "$f"; else echo "_(plan file not found)_"; fi
      echo; echo "---"; echo; } >> "$dir/plans-$day.md" ;;
  Stop)   # 플랜모드가 아닌 '실행' 턴이 끝났을 때 실행 내역을 LLM 요약으로 기록
    t=$(printf '%s' "$input" | jq -r '.transcript_path // ""')
    [ -f "$t" ] || exit 0

    # 마지막 사용자 프롬프트 이후(=이번 턴)만 분석.
    # 플랜 턴(ExitPlanMode 포함) 또는 수정 툴 미사용(순수 Q&A)이면 SKIP.
    meta=$(jq -s -r '
      def isprompt: .type=="user"
        and ((.message.content|type)=="string"
             or ((.message.content|type)=="array" and any(.message.content[]; .type=="text")));
      (to_entries | map(select(.value|isprompt)) | last | .key) as $start
      | (if $start==null then . else .[$start:] end) as $turn
      | [ $turn[] | select(.type=="assistant") | .message.content[]? ] as $blocks
      | [ $blocks[] | select(.type=="tool_use") ] as $tools
      | [ $tools[].name ] as $names
      | ($names | any(. == "ExitPlanMode")) as $isplan
      | ($names | any(. == "Edit" or . == "Write" or . == "MultiEdit"
                       or . == "NotebookEdit" or . == "Bash")) as $mut
      | if ($isplan or ($mut|not)) then "SKIP"
        else
          ( $turn[0] | if .type=="user"
              then (.message.content | if type=="string" then .
                    else ([.[]|select(.type=="text")|.text]|join(" ")) end)
              else "" end ) as $prompt
          | ([ $blocks[] | select(.type=="text") | .text ] | last // "") as $final
          | ( [ $tools[] | select(.name=="Edit" or .name=="Write" or .name=="MultiEdit") | .input.file_path ]
            + [ $tools[] | select(.name=="NotebookEdit") | .input.notebook_path ]
            | map(select(.!=null)) | unique ) as $files
          | ([ $tools[] | select(.name=="Bash") | (.input.command|split("\n")[0]) ]) as $cmds
          | ($names | group_by(.) | map("\(.[0])×\(length)") | join(", ")) as $tc
          | "[PROMPT]\n" + ($prompt|gsub("\n";" ")|.[0:200])
            + "\n\n[TOOLS] " + $tc
            + "\n\n[FILES]\n" + (if ($files|length)>0 then ($files|map("- "+.)|join("\n")) else "(none)" end)
            + "\n\n[BASH]\n" + (if ($cmds|length)>0 then ($cmds|map("- "+.)|join("\n")) else "(none)" end)
            + "\n\n[FINAL]\n" + $final
        end
    ' "$t" 2>/dev/null)

    { [ "$meta" = "SKIP" ] || [ -z "$meta" ]; } && exit 0

    # 사용자 블로킹 방지를 위해 백그라운드 서브셸에서 LLM 요약 후 기록 (darwin: timeout 미사용)
    (
      instr="다음은 방금 끝난 Claude Code 실행 턴의 활동 기록이다. 무엇을 실행/변경했는지 한국어로 3~6줄 요약하라. 사실만, 추측 금지."
      s=$(printf '%s\n\n%s' "$instr" "$meta" \
          | OBSERVE_NO_SUMMARY=1 claude -p --model claude-haiku-4-5 2>/dev/null)
      [ -z "$s" ] && exit 0
      { echo "## $ts  (session $sid)"; echo; echo "$s"; echo; echo "---"; echo; } \
        >> "$dir/executions-$day.md"
    ) &
    ;;
  SessionEnd)
    r=$(printf '%s' "$input" | jq -r '.reason // "other"')
    t=$(printf '%s' "$input" | jq -r '.transcript_path // ""')
    pf="$dir/prompts-$day.md"
    if [ -f "$pf" ]; then n=$(grep -c "(session $sid)" "$pf"); else n=0; fi
    [ "$n" -gt 0 ] || exit 0   # 프롬프트가 없으면 핸드오프를 남기지 않는다
    { echo "## $ts  (session $sid)  reason=$r"; echo;
      echo "- transcript: $t";
      echo "- 이번 세션 프롬프트: ${n}건 (prompts-$day.md 참조)";
      echo "- 최신 플랜: plans-$day.md 참조";
      echo "- 실행 로그: executions-$day.md 참조";
      echo; echo "---"; echo; } >> "$dir/handoff-$day.md" ;;
esac
exit 0
```

실행 권한을 부여한다.

```bash
chmod +x .claude/hooks/observe.sh
```

---

### 4.2 `.claude/settings.json`

프로젝트 스코프에서 네 개의 훅을 등록한다.

```json
{
  "hooks": {
    "UserPromptSubmit": [
      { "hooks": [ { "type": "command", "command": "bash \"$CLAUDE_PROJECT_DIR/.claude/hooks/observe.sh\"" } ] }
    ],
    "PostToolUse": [
      { "matcher": "ExitPlanMode",
        "hooks": [ { "type": "command", "command": "bash \"$CLAUDE_PROJECT_DIR/.claude/hooks/observe.sh\"" } ] }
    ],
    "Stop": [
      { "hooks": [ { "type": "command", "command": "bash \"$CLAUDE_PROJECT_DIR/.claude/hooks/observe.sh\"" } ] }
    ],
    "SessionEnd": [
      { "hooks": [ { "type": "command", "command": "bash \"$CLAUDE_PROJECT_DIR/.claude/hooks/observe.sh\"" } ] }
    ]
  }
}
```

---

## 5. 런타임 산출물

스크립트 실행 시 `.agentdocs/logs/` 아래에 날짜별 로그 파일이 자동 생성된다.

```text
.agentdocs/logs/
  prompts-YYYY-MM-DD.md
  plans-YYYY-MM-DD.md
  executions-YYYY-MM-DD.md
  handoff-YYYY-MM-DD.md
```

### 5.1 입력 프롬프트 로그

파일명: `.agentdocs/logs/prompts-YYYY-MM-DD.md`

기록 내용: 기록 시각 / 세션 ID 앞 8자리 / 사용자 입력 프롬프트 원문

예시:

```markdown
## 2026-06-18 18:40:12 (session abc12345)

사용자 입력 프롬프트 내용

---
```

---

### 5.2 Plan Mode 결과 로그

파일명: `.agentdocs/logs/plans-YYYY-MM-DD.md`

기록 내용: 기록 시각 / 세션 ID 앞 8자리 / 읽어온 플랜 파일 경로 / 플랜 본문

Plan Mode 종료 시점에는 훅 페이로드에 플랜 본문이 없으므로, `~/.claude/plans/*.md` 중 가장 최근 수정된 파일을 읽는다.

예시:

```markdown
## 2026-06-18 18:42:03 (session abc12345)

<!-- src: /Users/user/.claude/plans/example-plan.md -->

# Plan: ...

플랜 내용

---
```

---

### 5.3 실행 턴 로그

파일명: `.agentdocs/logs/executions-YYYY-MM-DD.md`

`Stop` 이벤트(어시스턴트 턴 종료)에서, **플랜모드가 아닌 '실행' 턴**일 때만 기록한다.

기록 조건:

- transcript의 **마지막 사용자 프롬프트 이후**(=이번 턴)만 분석한다.
- 다음이면 기록하지 않는다(`SKIP`).
  - 턴에 `ExitPlanMode` tool_use가 있음 → 플랜 턴이며 `plans-*.md`가 담당
  - 수정 툴(`Edit`/`Write`/`MultiEdit`/`NotebookEdit`/`Bash`)을 하나도 쓰지 않음 → 순수 Q&A
- 그 외에는 턴 활동을 payload(프롬프트 요약·툴 카운트·수정 파일·bash 명령·Claude의 마지막 텍스트)로
  뽑아 `claude -p`(haiku)에 넘겨 한국어 요약을 받아 기록한다.

예시:

```markdown
## 2026-06-18 20:11:03 (session abc12345)

observe.sh에 Stop 분기와 재귀 방지 가드를 추가하고,
SessionEnd 분기에 0-프롬프트 가드 및 카운트 버그 수정을 적용했다.
settings.json에는 Stop 훅을 등록했다.

---
```

---

### 5.4 세션 종료 핸드오프 로그

파일명: `.agentdocs/logs/handoff-YYYY-MM-DD.md`

기록 내용: 종료 시각 / 세션 ID 앞 8자리 / 종료 reason / transcript 경로 /
이번 세션 프롬프트 수 / 최신 플랜·실행 로그 포인터

**중요: 이번 세션의 프롬프트가 0건이면 핸드오프를 남기지 않는다.**
(빈 세션 노이즈 방지) 프롬프트 수는 당일 `prompts-*.md`에서 헤더 패턴
`(session <sid>)`로 카운트하며, 파일 부재 시 0으로 처리한다.

예시:

```markdown
## 2026-06-18 18:50:11 (session abc12345) reason=clear

- transcript: /path/to/transcript.jsonl
- 이번 세션 프롬프트: 3건 (prompts-2026-06-18.md 참조)
- 최신 플랜: plans-2026-06-18.md 참조
- 실행 로그: executions-2026-06-18.md 참조

---
```

---

## 6. 설계 결정

### 6.1 핸드오프는 메타데이터와 포인터만 남긴다 (LLM 미사용)

세션 종료(`SessionEnd`) 시에는 별도의 LLM 요약을 생성하지 않는다.

이유: 추가 비용 없음 / 종료 지연 없음 / 훅 재귀 호출 위험 없음 / 구현이 단순함.

또한 프롬프트가 0건인 세션은 핸드오프 자체를 생략한다(빈 세션 노이즈 제거).

### 6.2 실행 로그는 `claude -p`(haiku)로 LLM 요약한다

`SessionEnd`(6.1)와 달리, `Stop` 실행 턴 요약은 **LLM을 사용**한다. 실행 내역을
사람이 읽기 쉬운 자연어로 정리하는 가치가 비용을 정당화하기 때문이다.

이때 발생하는 두 가지 리스크를 다음과 같이 차단한다.

- **재귀 호출**: `claude -p`가 다시 훅을 발화시키므로, 호출 시 `OBSERVE_NO_SUMMARY=1`을
  export 하고 스크립트 최상단에서 이 변수를 감지해 즉시 종료한다. 중첩 헤드리스 세션의
  어떤 훅 이벤트도 로그를 오염시키지 않는다.
- **블로킹/지연**: 요약은 **백그라운드 서브셸**에서 수행한다. darwin에는 GNU `timeout`이
  없으므로 타임아웃 대신 백그라운드 분리로 사용자 입력을 막지 않는다.
- **비용**: 경량 모델(`claude-haiku-4-5`)을 사용하고, '실행' 턴(수정 툴 사용)만 대상으로 한다.

### 6.3 설정은 프로젝트 `.claude/settings.json`에 둔다

프로젝트 단위 관측을 위해 전역 설정이 아니라 레포 내부 설정을 사용한다. 이렇게 하면 해당
레포에서만 관측 훅이 동작한다.

### 6.4 플랜은 최신 `~/.claude/plans/*.md` 파일을 읽는다

현재 Claude Code는 Plan Mode 결과를 `~/.claude/plans/` 아래 Markdown 파일로 저장한다.
따라서 `ExitPlanMode` 이후 가장 최근 수정된 `.md` 파일을 읽어 append한다.

주의점:

- 여러 Claude Code 세션을 동시에 실행하면 드물게 다른 세션의 플랜을 집을 수 있다.
- 필요하면 이후 `mtime 1분 이내` 필터를 추가해 보완할 수 있다.

### 6.5 '실행' 턴 판정은 transcript 기반으로 한다

`Stop` 페이로드에는 턴 내용이 없으므로 `transcript_path`(JSONL)를 jq로 파싱한다.
마지막 사용자 프롬프트 이후 레코드만 잘라(=이번 턴) tool_use를 검사하고, `ExitPlanMode`
포함 또는 수정 툴 미사용이면 `SKIP`한다. 단순하고 비용이 없으며 정확하다.

---

## 7. 구현 단계

### Step 1. 훅 스크립트 작성

```bash
mkdir -p .claude/hooks
touch .claude/hooks/observe.sh
chmod +x .claude/hooks/observe.sh
```

`observe.sh`에 4.1의 스크립트를 작성한다.

### Step 2. Claude Code 설정 작성

```bash
mkdir -p .claude
touch .claude/settings.json
```

`settings.json`에 4.2의 훅 등록 설정을 작성한다.

### Step 3. 로그 디렉터리는 자동 생성

`.agentdocs/logs/`는 직접 만들 필요 없다. 훅이 처음 실행될 때 자동 생성된다.

---

## 8. 검증 방법

### 8.1 입력 프롬프트 훅 단위 테스트

```bash
echo '{"hook_event_name":"UserPromptSubmit","session_id":"abc12345","prompt":"hi"}' \
  | CLAUDE_PROJECT_DIR="$PWD" bash .claude/hooks/observe.sh
cat .agentdocs/logs/prompts-$(date "+%Y-%m-%d").md
```

### 8.2 Plan Mode 훅 단위 테스트

```bash
mkdir -p "$HOME/.claude/plans"; echo "# Test Plan" > "$HOME/.claude/plans/test-plan.md"
echo '{"hook_event_name":"PostToolUse","session_id":"abc12345"}' \
  | CLAUDE_PROJECT_DIR="$PWD" bash .claude/hooks/observe.sh
cat .agentdocs/logs/plans-$(date "+%Y-%m-%d").md
```

### 8.3 Stop 실행 요약 단위 테스트

수정 툴(Edit/Bash 등)이 포함된 실제 transcript JSONL 경로로 실행한다.

```bash
echo '{"hook_event_name":"Stop","session_id":"abc12345","transcript_path":"<실제 .jsonl>"}' \
  | CLAUDE_PROJECT_DIR="$PWD" bash .claude/hooks/observe.sh
wait   # 백그라운드 claude -p 완료 대기
cat .agentdocs/logs/executions-$(date "+%Y-%m-%d").md
```

플랜 전용/순수 Q&A transcript로는 기록이 남지 않아야 한다(`SKIP`). jq 분석부만 따로
실행해 `meta`가 `SKIP`인지 확인할 수 있다.

### 8.4 세션 종료 핸드오프 단위 테스트

0-프롬프트 가드(기록되지 않아야 함):

```bash
echo '{"hook_event_name":"SessionEnd","session_id":"zzz99999","reason":"clear","transcript_path":"/tmp/x.jsonl"}' \
  | CLAUDE_PROJECT_DIR="$PWD" bash .claude/hooks/observe.sh
grep -c "zzz99999" .agentdocs/logs/handoff-$(date "+%Y-%m-%d").md 2>/dev/null || echo "기록 없음(정상)"
```

프롬프트가 있는 경우(기록되어야 함):

```bash
echo '{"hook_event_name":"UserPromptSubmit","session_id":"abc12345","prompt":"hi"}' \
  | CLAUDE_PROJECT_DIR="$PWD" bash .claude/hooks/observe.sh
echo '{"hook_event_name":"SessionEnd","session_id":"abc12345","reason":"clear","transcript_path":"/tmp/x.jsonl"}' \
  | CLAUDE_PROJECT_DIR="$PWD" bash .claude/hooks/observe.sh
cat .agentdocs/logs/handoff-$(date "+%Y-%m-%d").md
```

### 8.5 재귀 방지 단위 테스트

```bash
echo '{"hook_event_name":"UserPromptSubmit","session_id":"deadbeef","prompt":"should be ignored"}' \
  | OBSERVE_NO_SUMMARY=1 CLAUDE_PROJECT_DIR="$PWD" bash .claude/hooks/observe.sh
# → prompts 로그에 deadbeef 항목이 생기지 않아야 함
```

### 8.6 Claude Code 실사용 테스트

1. 세션을 재시작하고 `/hooks`로 `UserPromptSubmit`/`PostToolUse`/`Stop`/`SessionEnd` 등록을 확인한다.
2. 일반 프롬프트 입력 → `prompts-*.md` 확인.
3. 파일을 수정하는 '실행' 턴 1회 → `executions-*.md`에 요약이 남는지 확인.
4. Plan Mode 사용(`ExitPlanMode`) → `plans-*.md` 확인, 같은 턴은 `executions-*.md`에 남지 않음 확인.
5. `/clear` 또는 세션 종료 → 프롬프트가 있었다면 `handoff-*.md` 기록 확인.

---

## 9. 최종 결과

이 구성으로 Claude Code 세션에서 다음 네 가지를 단순하게 관측한다.

```text
입력 프롬프트        → .agentdocs/logs/prompts-YYYY-MM-DD.md
Plan Mode 결과       → .agentdocs/logs/plans-YYYY-MM-DD.md
실행 턴 요약         → .agentdocs/logs/executions-YYYY-MM-DD.md  (LLM, '실행' 턴만)
세션 종료 핸드오프   → .agentdocs/logs/handoff-YYYY-MM-DD.md     (프롬프트 0건이면 생략)
```

핵심은 `.agentdocs/`를 복잡한 에이전트 문서 시스템으로 만들지 않고, 세션 관측 로그 저장소로만 사용하는 것이다.

---

## 10. 향후 확장 가능성

이번 범위에서는 제외하지만, 필요하면 다음 기능을 추가할 수 있다.

- 플랜 파일 선택 시 `mtime 1분 이내` 필터 추가
- 세션별 하위 폴더 분리
- 프롬프트·플랜·실행을 연결하는 session index 생성
- 실행 요약 실패/빈 응답 시 사실 기반(jq) 폴백 기록
- 실패한 명령이나 주요 ToolUse 이벤트 추가 관측

단, 현재 목표는 단순 관측이므로 위 확장은 필요해질 때만 추가한다.
