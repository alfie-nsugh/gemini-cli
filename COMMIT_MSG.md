feat(custom-agent): persist autosaves and restore richer history

- track conversation IDs for sessions, trigger autosave on turn completion, and
  attempt to resume matching autosaves on new session creation
- write checkpoint metadata + optional chat recordings, encode checkpoint tags,
  and keep legacy paths readable for existing saves
- rebuild history snapshots from recordings or checkpoint history, including
  tool calls and timestamps, and emit history_snapshot on resume
- allow resume to reuse existing sessions and thread conversation IDs through
  API params
- update slash command resume to pass session and conversation IDs
- avoid sync spawn in pre-commit by resolving git root with async execFile
