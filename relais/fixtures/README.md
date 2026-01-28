# Relais Fixtures (V1)

## F001 one_tick_limits

- Arrange: orchestrator produces valid task; builder succeeds.

- Assert: orchestrator_calls <= 2 (only if first JSON invalid), builder_calls == 1, no other retries.

## F002 orchestrator_invalid_json_blocks

- Arrange: orchestrator outputs invalid JSON twice.

- Assert: verdict=blocked, code=BLOCKED_ORCHESTRATOR_OUTPUT_INVALID.

## F003 question_no_side_effects

- Arrange: orchestrator returns task_kind=question but builder mistakenly edits a file.

- Assert: verdict=stop, code=STOP_QUESTION_SIDE_EFFECTS, repo rolled back clean.

## F004 verify_only_no_side_effects

- Arrange: task_kind=verify_only, builder touches a file.

- Assert: verdict=stop, code=STOP_VERIFY_ONLY_SIDE_EFFECTS, rollback clean.

## F005 scope_violation_outside_allowed

- Arrange: allowed_globs=["src/**"], builder edits "package.json".

- Assert: STOP_SCOPE_VIOLATION_OUTSIDE_ALLOWED.

## F006 forbidden_path_violation

- Arrange: builder edits "relais/STATE.json" or ".git/config".

- Assert: STOP_RUNNER_OWNED_MUTATION (or STOP_SCOPE_VIOLATION_FORBIDDEN), rollback clean.

## F007 new_file_rejected

- Arrange: allow_new_files=false, builder creates src/new.ts.

- Assert: STOP_SCOPE_VIOLATION_NEW_FILE.

## F008 lockfile_change_rejected

- Arrange: allow_lockfile_changes=false, builder changes pnpm-lock.yaml.

- Assert: STOP_LOCKFILE_CHANGE_FORBIDDEN.

## F009 diff_too_large

- Arrange: set max_lines_changed=20, builder changes 200 lines.

- Assert: STOP_DIFF_TOO_LARGE.

## F010 verify_taint_rejected

- Arrange: set verification param with metachar (e.g. "a;rm -rf").

- Assert: STOP_VERIFY_TAINTED; command not executed (verify_runs stays unchanged).

## F011 verify_fast_fail_stops

- Arrange: fast verification fails; slow exists.

- Assert: STOP_VERIFY_FAILED_FAST; slow not executed (verify_runs count shows only fast).

## F012 crash_tmp_cleanup_blocks_if_invalid

- Arrange: leave relais/STATE.json.tmp and corrupt relais/STATE.json.

- Assert: BLOCKED_CRASH_RECOVERY_REQUIRED.
