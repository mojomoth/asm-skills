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
