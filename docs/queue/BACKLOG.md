# bb-collab intake queue — 2026-08-18T04:10Z

Built under supervisor standing order (intake as standing duty). Triage of all 25 open
issues. Priority order: startable first, one line each. This is the durable artifact;
dispatch works top-down.

## Startable (dispatch-ready: not blocked, not waiting-external, not operator-only)

1. #145 AGENTS.md "no reload history" false — correction of contract text (previously superseded by ADR note; verify remaining span)
2. #127 DONE-shaped non-closure — define collected-completion rule (pairs with #141)
3. #141 Completion is handoff not event — collection duty design, pairs with #127
4. #152 Spawn --base-branch resolves stale local main — provider/platform-adjacent fix in spawn surface
5. #149 Spawn-default inheritance sets fleet-wide profile implicitly — explicit-default rule + fix
6. #113 Hidden fleet threads — cache the unhidden spawn path post-mortem; sweep for residual hidden threads
7. #138/#135 256-family bounds — one lane: survey all bounds, resize from live data, drop dupes into one issue
8. #93 wait-validator launchd artifact — host-supervised, model-free; infrastructure lane
9. #104 Assignment/ExecutionAttempt recording gap — profile compliance audit unblocked by recording fix
10. #103 Document and enforce model-to-role routing matrix — doc + enforcement check
11. #79 Explicit LOW-effort default for subagent spawns — small policy + check
12. #161 Latent flake server.test.ts:5120 — stabilize or split the timeout
13. #106 muse-spark-1.2 graded placement probe — queued probe work
14. #105 Terra graded placement probe — queued probe work
15. #80 Weekly throughput metrics — reporting lane, low priority startable
16. #47 Sidebar UI debt — front-end polish, startable, low priority

## Waiting-external (cannot start now)

- #169 requireRoleActorBinding bootstrap exemption — needs director/supervisor ruling recorded (this seat will rule)
- #143 Queued messages go stale — platform behavior get-bb/bb#1706 adjacent; watch upstream
- #162 setsid() descendants escape doctor probe — upstream kernel/platform constraint; document workaround only
- #125 Plugin source checkout silently diverges — needs non-destructive repoint upstream (get-bb/bb#1766) or operator deploy-dir decision
- #29 MigrationRun completion + first cutover — operator-gated (fixture-only contract)

## Blocked / operator-only

- #134 executed-triple design note — provisional, awaits authority decision (operator)
- #57 awareness/continuation substrate — superseded-by-parts; needs re-scoping ruling before any lane (candidate: close as absorbed)
- #147 thread-archive sweep (392 threads) — depends on #138/#135 protected-set computability; start after that lane
