# PRD / implem plan relais

## 0\) Pack layout

/relais.config.json

/relais/

  STATE.json

  TASK.json

  REPORT.json

  REPORT.md

  BLOCKED.json

  FACTS.md

  lock.json

  history/\<run\_id\>/{meta.json,report.json,report.md,diff.patch,verify.log}

  schemas/{task.schema.json,builder\_result.schema.json,report.schema.json}

  prompts/{orchestrator.system.txt,orchestrator.user.txt,builder.system.txt,builder.user.txt}

  fixtures/README.md

Everything below is copy-pasteable into those paths.

---

## 1\) `RELAIS_PRD.md` — Relais PRD v1.0 (final)

\# Relais — PRD v1.0

Tagline: Deterministic orchestration for Claude Code agent coding: Brain → Hands → Judge  

Status: Final (build-from-scratch spec)  

Owner: Clément  

Target users: “tech enthusiasts” (non-dev to seasoned dev) who want Claude Code power without chaos.

\#\# 1\) What this product is

Relais is a local runner that executes a strict, finite loop:

\- Brain (Orchestrator): Claude Code proposes exactly one next TASK as strict JSON (runner validates).

\- Hands (Builder): Claude Code executes that task using tools (Read/Edit/Bash…) with hard limits.

\- Judge (Runner): The runner computes the blast radius from git reality, enforces scope \+ budgets, runs verifications safely (argv/no-shell), and writes canonical truth.

Relais integrates with Claude Code CLI in non-interactive mode (-p) and can parse JSON responses from \--output-format json (runner reads wrapper.result). Claude Code supports permission modes such as plan and bypassPermissions. The runner treats bypassPermissions as “dangerous” and compensates with strict scope \+ verification enforcement.

\#\# 2\) Non-negotiables (V1)

G1 — Determinism of effects

\- Every tick starts from base\_commit.

\- Every tick ends with a recorded blast radius and verification results derived from git.

\- No hidden retries inside a tick (strict attempt limits).

G2 — Safety by default

\- Scope fencing is strict. If touched paths escape scope → STOP.

\- Runner-owned files are sacred (LLM cannot write truth).

G3 — One tick only

\- One \`relais run\` is finite. No “just one more try” loops.

G4 — Token/usage discipline is a feature

\- Hard caps on turns and prompt size.

\- Budget gates happen before spending.

G5 — OSS-friendly

\- Config is one file (relais.config.json).

\- Fixtures define the contract (CI-ready).

\#\# 3\) STOP vs BLOCKED

STOP \= “unsafe/invalid outcome detected; stop cleanly”

Examples: scope violation, verification taint, diff too large, builder wrote runner-owned file, verify failed.

\- Runner must write REPORT.json \+ REPORT.md and end tick deterministically.

\- For pure tasks, runner must rollback to base\_commit (tracked \+ untracked cleanup limited to touched set).

BLOCKED \= “cannot safely start”

Examples: missing config, budgets exhausted, dirty git state, lock cannot be reclaimed safely, crash recovery required.

\- Runner must write BLOCKED.json explaining exact remediation.

\#\# 4\) “argv arrays” (mandatory)

Verifications must never be executed via a shell string.

They must be executed as:

\- cmd: "pnpm"

\- args: \["-w", "test"\]

No shell, no metachar expansion, no injection surface.

\#\# 5\) Workspace (default: /relais)

Root config file: /relais.config.json

Workspace folder: /relais/ (runner-owned state \+ history \+ prompts \+ schemas).

\#\# 6\) Two reports

\- REPORT.json is the only source of truth (machine↔machine).

\- REPORT.md is a deterministic rendering of REPORT.json (human/orchestrator friendly).

Runner must generate REPORT.md from REPORT.json, not the other way around.

\#\# 7\) The Tick (finite state machine)

A tick is one \`relais run\`.

States:

1\) LOCK: acquire /relais/lock.json (no concurrency).

2\) PREFLIGHT: refuse to run unless safe and within budgets.

3\) ORCHESTRATE: 1 Claude Code call to propose TASK JSON (runner validates).

4\) BUILD: 1 Claude Code call to execute task and edit repo.

5\) JUDGE: scope check, diff caps, verify commands, blast radius.

6\) REPORT: write REPORT.json \+ REPORT.md, snapshot history.

7\) END: release lock.

Hard attempt limits (G3):

\- Orchestrator calls: 1 (+ optional 1 retry only if output is invalid JSON/schema).

\- Builder calls: 1\.

\- No other retries.

\- Verification commands: sequential; max \= len(fast)+len(slow).

\#\# 8\) Orchestrator (Brain)

Invocation (Claude Code):

\- claude \-p

\- \--output-format json  (runner reads wrapper.result string)

\- \--max-turns 1

\- \--no-session-persistence

\- \--permission-mode plan (no tool execution)

\- \--model \<alias or full model name\>

Orchestrator output:

\- It must output ONLY a JSON object that validates against task.schema.json.

\- If invalid, runner retries once with appended retry\_reason. If still invalid → BLOCKED(orchestrator\_output\_invalid).

Task kinds:

\- execute: code changes expected.

\- verify\_only: no code changes allowed; if git diff is non-empty at end → STOP(verify\_only\_side\_effects) \+ rollback.

\- question: no code changes allowed; runner asserts no diff.

\#\# 9\) Builder (Hands)

Default mode: claude\_code

Invocation (Claude Code):

\- claude \-p

\- \--output-format json (runner reads wrapper.result)

\- \--max-turns bounded (config)

\- \--no-session-persistence

\- \--allowedTools "Read,Edit,Glob,Grep,Bash"

\- \--permission-mode bypassPermissions (allowed only because tools are restricted and runner enforces scope; treated as dangerous)

\- \--model \<alias or full model name\>

Builder output:

\- Must output ONLY a JSON object matching builder\_result.schema.json.

\- If builder output is malformed, runner still judges using git \+ verifications, but report marks builder\_output\_valid=false. If config requires strict, runner STOP(builder\_output\_invalid).

\#\# 10\) Judge (scope \+ diff \+ blast radius)

Touched set:

\- tracked: git diff \--name-status base\_commit..HEAD

\- untracked: git status \--porcelain

Enforcements:

\- touched matches forbidden\_globs → STOP(scope\_violation\_forbidden)

\- touched not matched by allowed\_globs → STOP(scope\_violation\_outside\_allowed)

\- new files when allow\_new\_files=false → STOP(scope\_violation\_new\_file)

\- lockfile changes when allow\_lockfile\_changes=false → STOP(lockfile\_change\_forbidden)

\- diff too large → STOP(diff\_too\_large)

Blast radius (one line in both reports):

"\<files\_touched\> files, \+\<lines\_added\>/-\<lines\_deleted\>, \<new\_files\> new"

\#\# 11\) Verification (safe, bounded)

Verification commands are templates defined in relais.config.json as cmd+args arrays.

Runner expands params with strict validation:

\- max len

\- no whitespace

\- reject ".."

\- reject shell metacharacters

\- if path: must resolve under repo root

Execution:

\- no shell spawn

\- timeouts enforced

\- run fast\[\] then slow\[\]; first failure stops.

\#\# 12\) Budgets

Budgets are counters in STATE.json per milestone:

\- ticks, orchestrator\_calls, builder\_calls, verify\_runs, estimated\_cost\_usd

Preflight reservation:

\- runner must confirm remaining budget can cover worst-case tick including the one allowed orchestrator retry.

If not: BLOCKED(budget\_exhausted).

80% warning:

\- runner sets STATE.budget\_warning=true, prints warning, and adds “budget critical” hint to orchestrator input.

No automatic block.

\#\# 13\) Atomicity & crash safety

Runner writes runner-owned JSON atomically:

\- write \*.tmp

\- fsync

\- rename to final

Startup preflight:

\- delete stale \*.tmp under /relais/

\- validate runner-owned JSON files against schemas (when applicable)

\- if invalid → BLOCKED(crash\_recovery\_required)

Lock:

\- lock.json includes pid \+ started\_at \+ boot\_id fingerprint.

\- reclaim only if pid not running OR boot\_id differs.

\#\# 14\) History (V1)

History snapshots are kept; no replay command in V1.

History cap enforced at preflight only:

\- if exceeded → BLOCKED(history\_cap\_cleanup\_required)

\#\# 15\) CLI (V1)

\- relais init

\- relais status \[--preflight\]

\- relais run

\- relais doctor

\#\# 16\) Acceptance criteria (V1)

\- One tick only: hard attempt limits enforced.

\- Runner is judge: STOP/BLOCKED always writes reports; repo ends clean for question/verify\_only and for pure execute failures (rollback).

\- Scope fencing: cannot touch forbidden/outside allowed.

\- Verification safety: argv/no-shell \+ taint checks \+ timeouts.

\- Two reports: REPORT.json canonical \+ REPORT.md deterministic rendering.

\- Claude Code integration: uses \-p, \--output-format json, \--max-turns, \--permission-mode, \--model as configured.

\#\# 17\) Explicit non-goals (V1)

\- replay

\- Windows determinism matrix

\- in-tick negotiation loops (“decision\_budget”)

\- CI drift regression beyond hard caps

---

# **2\) `relais.config.json` (fresh)**

Key fixes vs the draft you pasted:

* workspace is consistently **`relais/`** (no more `ccp/` mixed paths)  
* we **do not** claim a CLI `--json-schema` flag; instead: runner validates JSON after parsing wrapper.result ([Claude API Docs](https://docs.anthropic.com/s/claude-code-sdk?utm_source=chatgpt.com))  
* tool restriction uses `--allowedTools` ([Claude API Docs](https://docs.anthropic.com/fr/docs/claude-code/sdk?utm_source=chatgpt.com))  
* permission modes are grounded in docs ([Claude API Docs](https://docs.claude.com/en/docs/claude-code/team?utm_source=chatgpt.com))

{

  "version": "1.0",

  "product\_name": "relais",

  "workspace\_dir": "relais",

  "runner": {

    "require\_git": true,

    "max\_tick\_seconds": 900,

    "lockfile": "relais/lock.json",

    "runner\_owned\_globs": \[

      "relais/STATE.json",

      "relais/TASK.json",

      "relais/REPORT.json",

      "relais/REPORT.md",

      "relais/BLOCKED.json",

      "relais/FACTS.md",

      "relais/history/\*\*",

      "relais/lock.json",

      "relais/schemas/\*\*",

      "relais/prompts/\*\*"

    \],

    "crash\_cleanup": {

      "delete\_tmp\_glob": "relais/\*.tmp",

      "validate\_runner\_json\_files": true

    },

    "render\_report\_md": {

      "enabled": true,

      "max\_chars": 6000

    }

  },

  "claude\_code\_cli": {

    "command": "claude",

    "output\_format": "json",

    "no\_session\_persistence": true

  },

  "models": {

    "orchestrator\_model": "opus",

    "orchestrator\_fallback\_model": "sonnet",

    "builder\_model": "sonnet",

    "builder\_fallback\_model": "haiku"

  },

  "orchestrator": {

    "max\_turns": 1,

    "permission\_mode": "plan",

    "allowed\_tools": "",

    "system\_prompt\_file": "relais/prompts/orchestrator.system.txt",

    "user\_prompt\_file": "relais/prompts/orchestrator.user.txt",

    "task\_schema\_file": "relais/schemas/task.schema.json",

    "max\_parse\_retries\_per\_tick": 1,

    "max\_budget\_usd": 0.4

  },

  "builder": {

    "default\_mode": "claude\_code",

    "allow\_patch\_mode": true,

    "claude\_code": {

      "max\_turns": 8,

      "permission\_mode": "bypassPermissions",

      "allowed\_tools": "Read,Edit,Glob,Grep,Bash",

      "system\_prompt\_file": "relais/prompts/builder.system.txt",

      "user\_prompt\_file": "relais/prompts/builder.user.txt",

      "builder\_result\_schema\_file": "relais/schemas/builder\_result.schema.json",

      "max\_budget\_usd": 1.5,

      "strict\_builder\_json": false

    },

    "patch": {

      "max\_patch\_attempts\_per\_milestone": 10

    }

  },

  "scope": {

    "default\_allowed\_globs": \[

      "src/\*\*",

      "app/\*\*",

      "packages/\*\*",

      "tests/\*\*",

      "README.md"

    \],

    "default\_forbidden\_globs": \[

      ".git/\*\*",

      "relais/\*\*",

      "\*\*/.env\*",

      "\*\*/\*secret\*",

      "\*\*/\*token\*",

      "\*\*/node\_modules/\*\*"

    \],

    "default\_allow\_new\_files": false,

    "default\_allow\_lockfile\_changes": false,

    "lockfiles": \[

      "pnpm-lock.yaml",

      "package-lock.json",

      "yarn.lock",

      "bun.lockb"

    \]

  },

  "diff\_limits": {

    "default\_max\_files\_touched": 12,

    "default\_max\_lines\_changed": 400

  },

  "verification": {

    "execution\_mode": "argv\_no\_shell",

    "max\_param\_len": 128,

    "reject\_whitespace\_in\_params": true,

    "reject\_dotdot": true,

    "reject\_metachars\_regex": "\[;&|$\\\\\\\\\>\<(){}\\\\\[\\\\\]\`\\\\n\\\\r\\\\t\\\\0\]",

    "timeout\_fast\_seconds": 90,

    "timeout\_slow\_seconds": 600,

    "templates": \[

      {

        "id": "lint",

        "cmd": "pnpm",

        "args": \["-w", "lint"\]

      },

      {

        "id": "typecheck",

        "cmd": "pnpm",

        "args": \["-w", "typecheck"\]

      },

      {

        "id": "test",

        "cmd": "pnpm",

        "args": \["-w", "test"\]

      },

      {

        "id": "test\_filter",

        "cmd": "pnpm",

        "args": \["-w", "test", "--filter", "{{pkg}}"\],

        "params": {

          "pkg": { "kind": "string\_token" }

        }

      }

    \]

  },

  "budgets": {

    "per\_milestone": {

      "max\_ticks": 200,

      "max\_orchestrator\_calls": 260,

      "max\_builder\_calls": 200,

      "max\_verify\_runs": 600,

      "max\_estimated\_cost\_usd": 80.0

    },

    "warn\_at\_fraction": 0.8

  },

  "history": {

    "enabled": true,

    "dir": "relais/history",

    "max\_mb": 500,

    "include\_diff\_patch": true,

    "include\_verify\_log": true

  }

}

---

# **3\) JSON Schemas (Draft 2020-12)**

## **3.1 `relais/schemas/task.schema.json`**

{

  "$schema": "https://json-schema.org/draft/2020-12/schema",

  "$id": "https://relais.local/schemas/task.schema.json",

  "title": "Relais Task",

  "type": "object",

  "additionalProperties": false,

  "required": \["task\_id", "milestone\_id", "task\_kind", "intent", "scope", "diff\_limits", "verification", "builder"\],

  "properties": {

    "task\_id": { "type": "string", "minLength": 1, "maxLength": 80 },

    "milestone\_id": { "type": "string", "minLength": 1, "maxLength": 80 },

    "task\_kind": { "type": "string", "enum": \["execute", "verify\_only", "question"\] },

    "intent": { "type": "string", "minLength": 1, "maxLength": 1200 },

    "question": {

      "type": "object",

      "additionalProperties": false,

      "required": \["prompt"\],

      "properties": {

        "prompt": { "type": "string", "minLength": 1, "maxLength": 2000 },

        "choices": {

          "type": "array",

          "items": { "type": "string", "minLength": 1, "maxLength": 200 },

          "minItems": 0,

          "maxItems": 12

        }

      }

    },

    "scope": {

      "type": "object",

      "additionalProperties": false,

      "required": \["allowed\_globs", "forbidden\_globs", "allow\_new\_files", "allow\_lockfile\_changes"\],

      "properties": {

        "allowed\_globs": {

          "type": "array",

          "items": { "type": "string", "minLength": 1, "maxLength": 200 },

          "minItems": 1,

          "maxItems": 64

        },

        "forbidden\_globs": {

          "type": "array",

          "items": { "type": "string", "minLength": 1, "maxLength": 200 },

          "minItems": 0,

          "maxItems": 64

        },

        "allow\_new\_files": { "type": "boolean" },

        "allow\_lockfile\_changes": { "type": "boolean" }

      }

    },

    "diff\_limits": {

      "type": "object",

      "additionalProperties": false,

      "required": \["max\_files\_touched", "max\_lines\_changed"\],

      "properties": {

        "max\_files\_touched": { "type": "integer", "minimum": 1, "maximum": 500 },

        "max\_lines\_changed": { "type": "integer", "minimum": 1, "maximum": 20000 }

      }

    },

    "verification": {

      "type": "object",

      "additionalProperties": false,

      "required": \["fast", "slow"\],

      "properties": {

        "fast": {

          "type": "array",

          "items": { "type": "string", "minLength": 1, "maxLength": 64 },

          "minItems": 0,

          "maxItems": 16

        },

        "slow": {

          "type": "array",

          "items": { "type": "string", "minLength": 1, "maxLength": 64 },

          "minItems": 0,

          "maxItems": 16

        },

        "params": {

          "type": "object",

          "additionalProperties": {

            "type": "object",

            "additionalProperties": {

              "type": \["string", "number", "boolean", "null"\]

            }

          }

        }

      }

    },

    "builder": {

      "type": "object",

      "additionalProperties": false,

      "required": \["mode", "max\_turns", "instructions"\],

      "properties": {

        "mode": { "type": "string", "enum": \["claude\_code", "patch"\] },

        "max\_turns": { "type": "integer", "minimum": 1, "maximum": 40 },

        "instructions": { "type": "string", "minLength": 1, "maxLength": 4000 },

        "patch": { "type": "string", "minLength": 1, "maxLength": 500000 }

      },

      "allOf": \[

        {

          "if": { "properties": { "mode": { "const": "patch" } } },

          "then": { "required": \["patch"\] }

        },

        {

          "if": { "properties": { "task\_kind": { "const": "question" } } },

          "then": { "properties": { "mode": { "const": "claude\_code" } } }

        }

      \]

    }

  },

  "allOf": \[

    {

      "if": { "properties": { "task\_kind": { "const": "question" } } },

      "then": { "required": \["question"\] }

    }

  \]

}

## **3.2 `relais/schemas/builder_result.schema.json`**

{

  "$schema": "https://json-schema.org/draft/2020-12/schema",

  "$id": "https://relais.local/schemas/builder\_result.schema.json",

  "title": "Relais Builder Result",

  "type": "object",

  "additionalProperties": false,

  "required": \["summary", "files\_intended", "commands\_ran", "notes"\],

  "properties": {

    "summary": { "type": "string", "minLength": 1, "maxLength": 800 },

    "files\_intended": {

      "type": "array",

      "items": { "type": "string", "minLength": 1, "maxLength": 300 },

      "minItems": 0,

      "maxItems": 200

    },

    "commands\_ran": {

      "type": "array",

      "items": { "type": "string", "minLength": 1, "maxLength": 300 },

      "minItems": 0,

      "maxItems": 50

    },

    "notes": {

      "type": "array",

      "items": { "type": "string", "minLength": 1, "maxLength": 300 },

      "minItems": 0,

      "maxItems": 20

    }

  }

}

## **3.3 `relais/schemas/report.schema.json`**

{

  "$schema": "https://json-schema.org/draft/2020-12/schema",

  "$id": "https://relais.local/schemas/report.schema.json",

  "title": "Relais Report",

  "type": "object",

  "additionalProperties": false,

  "required": \[

    "run\_id",

    "started\_at",

    "ended\_at",

    "duration\_ms",

    "base\_commit",

    "head\_commit",

    "task",

    "verdict",

    "code",

    "blast\_radius",

    "scope",

    "diff",

    "verification",

    "budgets"

  \],

  "properties": {

    "run\_id": { "type": "string", "minLength": 8, "maxLength": 80 },

    "started\_at": { "type": "string", "format": "date-time" },

    "ended\_at": { "type": "string", "format": "date-time" },

    "duration\_ms": { "type": "integer", "minimum": 0 },

    "base\_commit": { "type": "string", "minLength": 7, "maxLength": 64 },

    "head\_commit": { "type": "string", "minLength": 7, "maxLength": 64 },

    "task": {

      "type": "object",

      "additionalProperties": false,

      "required": \["task\_id", "milestone\_id", "task\_kind", "intent"\],

      "properties": {

        "task\_id": { "type": "string" },

        "milestone\_id": { "type": "string" },

        "task\_kind": { "type": "string", "enum": \["execute", "verify\_only", "question"\] },

        "intent": { "type": "string" }

      }

    },

    "verdict": { "type": "string", "enum": \["success", "stop", "blocked"\] },

    "code": {

      "type": "string",

      "enum": \[

        "SUCCESS",

        "STOP\_SCOPE\_VIOLATION\_FORBIDDEN",

        "STOP\_SCOPE\_VIOLATION\_OUTSIDE\_ALLOWED",

        "STOP\_SCOPE\_VIOLATION\_NEW\_FILE",

        "STOP\_LOCKFILE\_CHANGE\_FORBIDDEN",

        "STOP\_DIFF\_TOO\_LARGE",

        "STOP\_VERIFY\_FAILED\_FAST",

        "STOP\_VERIFY\_FAILED\_SLOW",

        "STOP\_VERIFY\_TAINTED",

        "STOP\_VERIFY\_ONLY\_SIDE\_EFFECTS",

        "STOP\_QUESTION\_SIDE\_EFFECTS",

        "STOP\_RUNNER\_OWNED\_MUTATION",

        "STOP\_BUILDER\_OUTPUT\_INVALID",

        "STOP\_HEAD\_MOVED",

        "STOP\_INTERRUPTED",

        "BLOCKED\_BUDGET\_EXHAUSTED",

        "BLOCKED\_DIRTY\_WORKTREE",

        "BLOCKED\_LOCK\_HELD",

        "BLOCKED\_CRASH\_RECOVERY\_REQUIRED",

        "BLOCKED\_ORCHESTRATOR\_OUTPUT\_INVALID",

        "BLOCKED\_HISTORY\_CAP\_CLEANUP\_REQUIRED",

        "BLOCKED\_MISSING\_CONFIG"

      \]

    },

    "blast\_radius": {

      "type": "object",

      "additionalProperties": false,

      "required": \["files\_touched", "lines\_added", "lines\_deleted", "new\_files"\],

      "properties": {

        "files\_touched": { "type": "integer", "minimum": 0 },

        "lines\_added": { "type": "integer", "minimum": 0 },

        "lines\_deleted": { "type": "integer", "minimum": 0 },

        "new\_files": { "type": "integer", "minimum": 0 }

      }

    },

    "scope": {

      "type": "object",

      "additionalProperties": false,

      "required": \["ok", "violations", "touched\_paths"\],

      "properties": {

        "ok": { "type": "boolean" },

        "violations": {

          "type": "array",

          "items": { "type": "string", "minLength": 1, "maxLength": 200 },

          "minItems": 0,

          "maxItems": 200

        },

        "touched\_paths": {

          "type": "array",

          "items": { "type": "string", "minLength": 1, "maxLength": 400 },

          "minItems": 0,

          "maxItems": 500

        }

      }

    },

    "diff": {

      "type": "object",

      "additionalProperties": false,

      "required": \["files\_changed", "lines\_changed", "diff\_patch\_path"\],

      "properties": {

        "files\_changed": { "type": "integer", "minimum": 0 },

        "lines\_changed": { "type": "integer", "minimum": 0 },

        "diff\_patch\_path": { "type": "string", "minLength": 1, "maxLength": 300 }

      }

    },

    "verification": {

      "type": "object",

      "additionalProperties": false,

      "required": \["exec\_mode", "runs", "verify\_log\_path"\],

      "properties": {

        "exec\_mode": { "type": "string", "enum": \["argv\_no\_shell"\] },

        "runs": {

          "type": "array",

          "items": {

            "type": "object",

            "additionalProperties": false,

            "required": \["template\_id", "phase", "cmd", "args", "exit\_code", "duration\_ms", "timed\_out"\],

            "properties": {

              "template\_id": { "type": "string", "minLength": 1, "maxLength": 64 },

              "phase": { "type": "string", "enum": \["fast", "slow"\] },

              "cmd": { "type": "string", "minLength": 1, "maxLength": 120 },

              "args": {

                "type": "array",

                "items": { "type": "string", "maxLength": 200 },

                "minItems": 0,

                "maxItems": 40

              },

              "exit\_code": { "type": "integer", "minimum": \-1, "maximum": 255 },

              "duration\_ms": { "type": "integer", "minimum": 0 },

              "timed\_out": { "type": "boolean" }

            }

          },

          "minItems": 0,

          "maxItems": 40

        },

        "verify\_log\_path": { "type": "string", "minLength": 1, "maxLength": 300 }

      }

    },

    "budgets": {

      "type": "object",

      "additionalProperties": false,

      "required": \["milestone\_id", "ticks", "orchestrator\_calls", "builder\_calls", "verify\_runs", "estimated\_cost\_usd", "warnings"\],

      "properties": {

        "milestone\_id": { "type": "string" },

        "ticks": { "type": "integer", "minimum": 0 },

        "orchestrator\_calls": { "type": "integer", "minimum": 0 },

        "builder\_calls": { "type": "integer", "minimum": 0 },

        "verify\_runs": { "type": "integer", "minimum": 0 },

        "estimated\_cost\_usd": { "type": "number", "minimum": 0 },

        "warnings": {

          "type": "array",

          "items": { "type": "string", "minLength": 1, "maxLength": 200 },

          "minItems": 0,

          "maxItems": 20

        }

      }

    },

    "pointers": {

      "type": "object",

      "additionalProperties": false,

      "properties": {

        "report\_md\_path": { "type": "string" },

        "history\_dir": { "type": "string" }

      }

    }

  }

}

---

# **4\) Prompts**

## **4.1 `relais/prompts/orchestrator.system.txt`**

You are the Orchestrator (Brain) for Relais.

Your job: propose exactly ONE next task as a JSON object.

The runner will validate your JSON and will enforce safety and determinism.

Hard rules:

\- Output MUST be a single JSON object and NOTHING ELSE.

\- No markdown. No code fences. No commentary.

\- The task must be small and safe. Prefer minimal diff.

\- Never touch runner-owned files or forbidden paths.

\- Respect budgets and constraints provided in the user prompt.

\- If you cannot propose a safe task, output task\_kind="question" with a clear prompt.

Task design rules:

\- Choose task\_kind:

  \- execute: repo edits expected

  \- verify\_only: no repo edits allowed (runner will STOP if there is a diff)

  \- question: no repo edits allowed (runner will STOP if there is a diff)

\- Scope:

  \- allowed\_globs should be minimal (least privilege)

  \- forbidden\_globs should always include: "relais/\*\*", ".git/\*\*", "\*\*/.env\*", "\*\*/\*secret\*", "\*\*/\*token\*", "\*\*/node\_modules/\*\*"

  \- allow\_new\_files defaults to false unless necessary

  \- allow\_lockfile\_changes defaults to false unless explicitly necessary

\- Diff limits: pick conservative defaults unless instructed otherwise.

Verification:

\- Use only verification template IDs provided by the runner.

\- Put quick checks in fast\[\], slower in slow\[\].

Builder:

\- Prefer mode="claude\_code".

\- max\_turns should be small (usually 4–8).

\- instructions must be concrete and implementable.

## **4.2 `relais/prompts/orchestrator.user.txt` (template)**

You are orchestrating the next tick for Relais.

Return EXACTLY one JSON object matching task.schema.json. Nothing else.

\=== CONTEXT \===

Project goal:

{{PROJECT\_GOAL}}

Milestone:

{{MILESTONE\_ID}}

Budgets (remaining / status):

{{BUDGETS\_SUMMARY}}

Verification templates available:

{{VERIFY\_TEMPLATE\_IDS}}

Repo summary (short):

{{REPO\_SUMMARY}}

FACTS (curated, capped):

{{FACTS\_MD}}

Last report (human digest):

{{LAST\_REPORT\_MD}}

BLOCKED (if present):

{{BLOCKED\_JSON\_OR\_EMPTY}}

Runner constraints (non-negotiable):

\- One tick only. No retries except possible runner parse-retry if your JSON is invalid.

\- Scope is enforced from git reality. Any out-of-scope touch will STOP and rollback.

\- verify\_only and question tasks MUST produce zero git diff, or the runner will STOP.

\=== YOUR OUTPUT \===

Return one task:

\- minimal scope

\- conservative diff limits

\- fast verifications preferred

If anything requires a human decision (missing info, ambiguous desired behavior), output task\_kind="question".

## **4.3 `relais/prompts/builder.system.txt`**

You are the Builder (Hands) for Relais.

Your job: execute the provided TASK safely and minimally.

Hard rules:

\- Obey TASK scope. Only edit files inside allowed\_globs. Never touch forbidden paths.

\- Never edit anything under: relais/\*\*, .git/\*\*, \*\*/.env\*, \*\*/\*secret\*, \*\*/\*token\*, \*\*/node\_modules/\*\*

\- Keep diffs small. No refactors. No drive-by formatting. No renames unless required.

\- Do NOT change lockfiles unless TASK.scope.allow\_lockfile\_changes=true.

\- Do NOT create new files unless TASK.scope.allow\_new\_files=true.

\- If you realize you cannot complete the task safely within scope, STOP and return a builder\_result that explains why.

Output MUST be a single JSON object matching builder\_result.schema.json and NOTHING ELSE.

No markdown. No code fences. No commentary.

## **4.4 `relais/prompts/builder.user.txt` (template)**

Execute this TASK.

Return ONLY builder\_result JSON matching builder\_result.schema.json. Nothing else.

TASK (canonical):

{{TASK\_JSON}}

Scope reminders:

\- allowed\_globs: {{ALLOWED\_GLOBS}}

\- forbidden\_globs: {{FORBIDDEN\_GLOBS}}

\- allow\_new\_files: {{ALLOW\_NEW\_FILES}}

\- allow\_lockfile\_changes: {{ALLOW\_LOCKFILE\_CHANGES}}

\- diff limits: files\<= {{MAX\_FILES\_TOUCHED}}, lines\<= {{MAX\_LINES\_CHANGED}}

Notes:

\- The runner will run verifications separately (do not invent verification results).

\- If task\_kind is verify\_only or question: DO NOT modify any files.

Now execute.

---

# **5\) Minimal fixture list (`relais/fixtures/README.md`)**

These are the **smallest** tests that prove the contract. Each fixture is “setup → run → assert report.code \+ repo state”.

\# Relais Fixtures (V1)

\#\# F001 one\_tick\_limits

\- Arrange: orchestrator produces valid task; builder succeeds.

\- Assert: orchestrator\_calls \<= 2 (only if first JSON invalid), builder\_calls \== 1, no other retries.

\#\# F002 orchestrator\_invalid\_json\_blocks

\- Arrange: orchestrator outputs invalid JSON twice.

\- Assert: verdict=blocked, code=BLOCKED\_ORCHESTRATOR\_OUTPUT\_INVALID.

\#\# F003 question\_no\_side\_effects

\- Arrange: orchestrator returns task\_kind=question but builder mistakenly edits a file.

\- Assert: verdict=stop, code=STOP\_QUESTION\_SIDE\_EFFECTS, repo rolled back clean.

\#\# F004 verify\_only\_no\_side\_effects

\- Arrange: task\_kind=verify\_only, builder touches a file.

\- Assert: verdict=stop, code=STOP\_VERIFY\_ONLY\_SIDE\_EFFECTS, rollback clean.

\#\# F005 scope\_violation\_outside\_allowed

\- Arrange: allowed\_globs=\["src/\*\*"\], builder edits "package.json".

\- Assert: STOP\_SCOPE\_VIOLATION\_OUTSIDE\_ALLOWED.

\#\# F006 forbidden\_path\_violation

\- Arrange: builder edits "relais/STATE.json" or ".git/config".

\- Assert: STOP\_RUNNER\_OWNED\_MUTATION (or STOP\_SCOPE\_VIOLATION\_FORBIDDEN), rollback clean.

\#\# F007 new\_file\_rejected

\- Arrange: allow\_new\_files=false, builder creates src/new.ts.

\- Assert: STOP\_SCOPE\_VIOLATION\_NEW\_FILE.

\#\# F008 lockfile\_change\_rejected

\- Arrange: allow\_lockfile\_changes=false, builder changes pnpm-lock.yaml.

\- Assert: STOP\_LOCKFILE\_CHANGE\_FORBIDDEN.

\#\# F009 diff\_too\_large

\- Arrange: set max\_lines\_changed=20, builder changes 200 lines.

\- Assert: STOP\_DIFF\_TOO\_LARGE.

\#\# F010 verify\_taint\_rejected

\- Arrange: set verification param with metachar (e.g. "a;rm \-rf").

\- Assert: STOP\_VERIFY\_TAINTED; command not executed (verify\_runs stays unchanged).

\#\# F011 verify\_fast\_fail\_stops

\- Arrange: fast verification fails; slow exists.

\- Assert: STOP\_VERIFY\_FAILED\_FAST; slow not executed (verify\_runs count shows only fast).

\#\# F012 crash\_tmp\_cleanup\_blocks\_if\_invalid

\- Arrange: leave relais/STATE.json.tmp and corrupt relais/STATE.json.

\- Assert: BLOCKED\_CRASH\_RECOVERY\_REQUIRED.

---

## **Implementation notes (so Opus builds it correctly)**

1. **Claude Code CLI parsing**  
* Run `claude -p --output-format json ...`  
* Parse stdout JSON, then parse `stdout_json.result` as the *actual* model text. ([Claude API Docs](https://docs.anthropic.com/s/claude-code-sdk?utm_source=chatgpt.com))  
2. **Permission modes**  
* Orchestrator uses `--permission-mode plan` (analyze only). ([Claude API Docs](https://docs.claude.com/en/docs/claude-code/team?utm_source=chatgpt.com))  
* Builder uses `bypassPermissions` only because tools are restricted \+ runner enforces safety. Treat it as dangerous (documented as such). ([Claude](https://platform.claude.com/docs/en/agent-sdk/permissions?utm_source=chatgpt.com))  
3. **Allowed tools**  
* Builder uses `--allowedTools` to restrict tool surface. ([Claude API Docs](https://docs.anthropic.com/fr/docs/claude-code/sdk?utm_source=chatgpt.com))

## **Appendix A — STOP/BLOCKED Decision Table (first-match wins)**

**Legend**

* **BLOCKED** \= refuse to start a tick (no orchestrator/builder calls).

* **STOP** \= tick started, but runner stops safely, writes reports, and (when required) rolls back.

* “Rollback” means: reset tracked files to `base_commit` and remove **untracked touched paths** (only those paths), then assert clean.

### **A1) Preflight / Start-of-tick (BLOCKED-only)**

| Priority | Condition (preflight) | Verdict | Code | Runner action |
| ----- | ----- | ----- | ----- | ----- |
| 1 | `relais.config.json` missing / unreadable | BLOCKED | `BLOCKED_MISSING_CONFIG` | Write `BLOCKED.json` with remediation |
| 2 | Not a git repo OR cannot read `HEAD` | BLOCKED | `BLOCKED_MISSING_CONFIG` | Same |
| 3 | Lock exists AND cannot safely reclaim | BLOCKED | `BLOCKED_LOCK_HELD` | Write `BLOCKED.json` |
| 4 | Worktree dirty (tracked or untracked), and not explained by last interrupted tick (V1: always block if dirty) | BLOCKED | `BLOCKED_DIRTY_WORKTREE` | Write `BLOCKED.json` |
| 5 | History size \> cap at tick start | BLOCKED | `BLOCKED_HISTORY_CAP_CLEANUP_REQUIRED` | Write `BLOCKED.json` |
| 6 | Crash artifacts: `.tmp` cleanup ran AND any runner-owned JSON fails schema validation after cleanup | BLOCKED | `BLOCKED_CRASH_RECOVERY_REQUIRED` | Write `BLOCKED.json` |
| 7 | Milestone budgets exhausted OR cannot reserve worst-case tick spend (incl. allowed parse-retry) | BLOCKED | `BLOCKED_BUDGET_EXHAUSTED` | Write `BLOCKED.json` |

**Notes**

* V1 simplification: “dirty worktree explained by interrupted footprint” can be deferred; for now, **dirty \= blocked**.

---

### **A2) Orchestrator stage (BLOCKED / STOP)**

| Priority | Condition | Verdict | Code | Runner action |
| ----- | ----- | ----- | ----- | ----- |
| 1 | Orchestrator call fails (process error / timeout / non-JSON wrapper) | STOP | `STOP_INTERRUPTED` | Write report, no repo changes expected |
| 2 | Wrapper JSON parses but `result` missing / not string | STOP | `STOP_INTERRUPTED` | Same |
| 3 | `result` parses but TASK JSON invalid → retry allowed and already used | BLOCKED | `BLOCKED_ORCHESTRATOR_OUTPUT_INVALID` | Write `BLOCKED.json` |
| 4 | TASK JSON valid but violates schema constraints (additional props, missing required) → after retry | BLOCKED | `BLOCKED_ORCHESTRATOR_OUTPUT_INVALID` | Write `BLOCKED.json` |

**Notes**

* We treat “invalid orchestrator output” as BLOCKED because continuing tends to burn spend with no progress.

---

### **A3) Builder stage (STOP)**

| Priority | Condition | Verdict | Code | Runner action |
| ----- | ----- | ----- | ----- | ----- |
| 1 | Builder invocation fails (timeout, process error) | STOP | `STOP_INTERRUPTED` | Report \+ rollback if repo changed |
| 2 | Builder returns invalid JSON (cannot parse wrapper/result OR schema invalid) AND `strict_builder_json=true` | STOP | `STOP_BUILDER_OUTPUT_INVALID` | Report \+ judge diff anyway; rollback if needed |
| 3 | Builder returns invalid JSON but `strict_builder_json=false` | STOP (soft) | `STOP_BUILDER_OUTPUT_INVALID` | Continue to Judge; final verdict may still be success if everything else passes (but code remains STOP in V1 to keep contract simple) |

**V1 recommendation:** keep it strict and predictable: **any builder JSON invalid → STOP**.

---

### **A4) Judge stage — invariants based on git reality (STOP)**

These rules use:

* touched tracked: `git diff --name-status base_commit..HEAD`

* touched untracked: `git status --porcelain`

* lockfiles list from config

* runner-owned globs from config

| Priority | Condition | Verdict | Code | Runner action |
| ----- | ----- | ----- | ----- | ----- |
| 1 | Any runner-owned path changed (e.g. `relais/STATE.json`, `relais/REPORT.json`, anything under `relais/`) | STOP | `STOP_RUNNER_OWNED_MUTATION` | Rollback \+ report |
| 2 | Any touched path matches forbidden\_globs | STOP | `STOP_SCOPE_VIOLATION_FORBIDDEN` | Rollback \+ report |
| 3 | Any touched path not matched by allowed\_globs | STOP | `STOP_SCOPE_VIOLATION_OUTSIDE_ALLOWED` | Rollback \+ report |
| 4 | New files created AND `allow_new_files=false` | STOP | `STOP_SCOPE_VIOLATION_NEW_FILE` | Rollback \+ report |
| 5 | Any lockfile touched AND `allow_lockfile_changes=false` | STOP | `STOP_LOCKFILE_CHANGE_FORBIDDEN` | Rollback \+ report |
| 6 | Diff size exceeds limits (`files_touched > max_files_touched` OR `lines_changed > max_lines_changed`) | STOP | `STOP_DIFF_TOO_LARGE` | Rollback \+ report |
| 7 | TASK kind is `question` and any diff exists | STOP | `STOP_QUESTION_SIDE_EFFECTS` | Rollback \+ report |
| 8 | TASK kind is `verify_only` and any diff exists | STOP | `STOP_VERIFY_ONLY_SIDE_EFFECTS` | Rollback \+ report |
| 9 | `HEAD` moved externally during tick (base/head mismatch not attributable to builder diff) | STOP | `STOP_HEAD_MOVED` | Block further runs until clean; rollback if possible |

---

### **A5) Verification stage (STOP / SUCCESS)**

Runner executes verifications **only after** scope/diff checks pass.

| Priority | Condition | Verdict | Code | Runner action |
| ----- | ----- | ----- | ----- | ----- |
| 1 | Any verification template missing from config | STOP | `STOP_VERIFY_TAINTED` | Do not execute anything; report |
| 2 | Any param fails validation (len / whitespace / `..` / metachar regex / path escape) | STOP | `STOP_VERIFY_TAINTED` | Do not execute anything; report |
| 3 | Any fast verification exits non-zero or times out | STOP | `STOP_VERIFY_FAILED_FAST` | Do not run slow; report |
| 4 | Any slow verification exits non-zero or times out | STOP | `STOP_VERIFY_FAILED_SLOW` | Report |

**Success condition**

* All required verifications pass,

* No STOP/BLOCKED rules triggered.

→ Verdict: **SUCCESS**, Code: **SUCCESS**

---

### **A6) Reporting & history (never change verdict after success)**

| Priority | Condition | Verdict | Code | Runner action |
| ----- | ----- | ----- | ----- | ----- |
| 1 | Unable to write REPORT.json atomically | STOP | `STOP_INTERRUPTED` | Best-effort write `BLOCKED.json` with “disk/write failure” |
| 2 | History cap would be exceeded *after* this run | **No change** | (keep verdict) | V1 rule: cap checked only in preflight; do not fail a completed tick |

---

## **Appendix B — Rollback rules (V1)**

Rollback is mandatory on any STOP that happens **after builder ran**, except when runner cannot safely perform it (then STOP\_INTERRUPTED).

Rollback steps:

1. `git reset --hard <base_commit>`

2. Remove **untracked touched paths** captured by the runner (only those paths)

3. Assert clean: `git diff --exit-code` and no untracked files

