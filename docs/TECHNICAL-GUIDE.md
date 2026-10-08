# Agent fleet — technical guide

How the fleet is built, how each feature works inside, the safety decisions behind it, and how to extend it. For using it, see the [README](../README.md).

Version 0.6.1 · © 2026 Belsis Meletis

---

## 1. What kind of plugin this is

Claude Code supports two kinds of plugin code. Most plugins use *command hooks*: shell commands that settings run on events. The fleet uses the newer **function hooks** (Claude Code calls plugins built this way "mods"): a TypeScript module that Claude Code loads into an isolated environment and calls on every event it subscribes to.

That model is what makes the fleet possible. A function hook can:

- **intercept and rewrite** what Claude does — a subagent launch, a tool call, a prompt, the system prompt;
- **draw its own UI** — a side pane, a band above the prompt, and replacements for transcript rows;
- **keep state** for the session (`$.state`) and across sessions (`$.store`);
- **call into Claude Code** — launch agents, call tools, read the session's cost and transcripts, run processes, play sounds.

The module has no DOM and no Node. Everything outside it is reached through the engine interface `$`, and everything it does is visible in its source to `claude plugin validate`, which lists what it hooks and calls and refuses anything the engine would not allow.

Requirements: Claude Code 2.1.294 or later. There is no build step; Claude Code compiles the TypeScript.

## 2. How it was created

The fleet was built in one long Claude Code session, as a conversation between its owner and Claude, iterating on real runs:

1. **A mod in the session.** It started as a mod written into the session's hot-reload folder (`~/.claude/dev-mods/<session>/agent-fleet/`). Claude Code reloads such a mod each time a turn that edited it ends, so every change could be tried immediately in the same session.
2. **Driven by real use.** Each feature came from a run that exposed a need: text that was hard to read on a dark terminal led to colour schemes; three workers that all picked slot 1 led to slot reservation; a budget stop that showed only a passing toast led to a lasting transcript line and a note to Claude; a 49,000-word specification that could not come back through the chat led to run folders.
3. **Tested against the engine.** Every feature has tests that run inside Claude Code's own test kit (`claude plugin test`), which loads the plugin with a mocked world beneath it (clock, store, session, git), and every change was type-checked against the engine's declarations and validated with `claude plugin validate`.
4. **Moved to a repository and installed.** Once stable it was copied to its own git repository, which is also a plugin marketplace (`.claude-plugin/marketplace.json`), and installed at user scope from there.

## 3. Files

```
.claude-plugin/
  plugin.json         name, version, description, author, and "types" (the state contract)
  marketplace.json    makes this repository a marketplace listing the plugin
hooks/
  hooks.json          { "modules": ["./register.tsx"] } — the one hooks module
  register.tsx        everything that talks to Claude Code: hooks, commands, the pane
  lib.ts              the pure logic: texts and prompts, parsing, waves, guards, arithmetic
types/
  index.d.ts          the state contract: every value the plugin keeps, typed
tests/
  fleet.test.ts       ~46 tests run by `claude plugin test .`
fx/
  done.wav alert.wav  the finish chimes (generated, ~25 KB each)
docs/, Screenshots/   documentation
```

`lib.ts` holds no `$` calls, so it can be read and tested in isolation. `register.tsx` keeps every function that takes `$` at its top level, which the validator requires so it can follow each call.

## 4. Architecture

### 4.1 The hooks it uses

| Event | What the fleet does there |
|---|---|
| `session.start` | Loads the saved plan, history, worktree ledger and per-project switch; registers `/fleet`, the three lead agent types (`agent-fleet:planner`, `:reviewer`, `:designer`) and the `progress` tool; starts a one-second clock for live figures and the budget; reminds you of unmerged worktrees. |
| `command.run` (`fleet`) | Answers every `/fleet …` command. |
| `prompt.submit` | For a message you typed (`origin.kind === 'composer'`) while the fleet is on: opens a *request* (id, title, run folder, cost at start) and attaches the plan as context the model reads beside your message. |
| `prompt.compose` | Adds the plan (and, in quiet mode, the quiet-progress rule) as a section of the system prompt. |
| `agent.spawn` | The heart of the fleet. Classifies each launch (planner, worker, reviewer, designer, other), assigns the worker's slot and model, enforces waves, worker count and the budget, appends the run-folder, progress and worktree instructions to the brief, creates the worktree, and records the run. |
| `tool.call` | For agents: the safe-point pause, the designer's upload guard, the worktree guard, step counting. A second hook answers the plugin's own `progress` tool. |
| `turn.complete` | For an agent: records its result, tokens and status; for the planner, parses jobs, waves and deliverable; finishes worktrees; delivers rerun results. For the main loop: closes the request when nothing is running or paused, writes `summary.md`, records history, announces. |
| `ui.render` `Pane` | Draws the fleet pane. |
| `ui.render` `AbovePrompt` | Draws the status band. |
| `ui.render` `UserMessage` | In compact or quiet mode, folds agents' notices and reports to one line (left alone when expanded with ctrl+o). |

Hooks that can refuse something (`agent.spawn`, `tool.call`) have a `.catch` that lets the call through if the plugin itself fails, so a bug in the fleet never blocks Claude.

### 4.2 State

All state is declared in `types/index.d.ts` and held by Claude Code, not in module variables, so it survives a reload:

| Key | Holds | Kept across sessions in `$.store` |
|---|---|---|
| `plan` | slots and models, planner/reviewer/designer, auto-size, files, worktrees, budget, notify, messages, theme | yes |
| `requests` | the last few requests: title, run folder, cost, budget level, jobs and waves, deliverable, base commit | no |
| `runs` | every agent: role, slot, job, model, status, progress, tokens, task, brief, output path, worktree | no |
| `worktrees` | the worktree ledger | yes |
| `history` | finished requests (last 200) | yes |
| `isProjectOff` | the per-project switch (the list of switched-off projects is in the store) | yes |
| `peek`, `now`, `isHelpOpen`, `isHistoryOpen`, `isBandHidden` | UI state | no |

A render hook reads state with `read($, atom)`, which subscribes it; any later write redraws exactly the readers. Writes use `update($, atom, fn)`, which re-applies on a version conflict, so two quick button presses both land.

Two module variables exist on purpose: `slotCursor` and `reserved` (below), which only need to live within one burst of parallel launches.

### 4.3 The life of a request

1. **You send a message.** `prompt.submit` opens a request and writes `request.md` to a new run folder; the plan travels with your message.
2. **Claude launches the planner.** `agent.spawn` sees `agent-fleet:planner`, gives it its own model and appends the worker slots. The planner answers with `## Deliverable: …` and `## Job N: …` sections, some marked `(after …)`.
3. **The plan is parsed.** At the planner's `turn.complete`, `jobsOf` and `wavesOf` turn the headings into jobs and waves; `plan.md` is saved.
4. **Claude launches the workers**, each brief starting with its `## Job N` heading. For each launch `agent.spawn`: refuses a job whose dependencies have not finished; reserves the slot (Job N → slot N); sets the model; appends the progress note, the output file path, the input files of its dependencies and, with worktrees, the worktree note — and creates the worktree.
5. **Workers report progress** through `mcp__agent-fleet__progress`; every other tool call passes the guards and is counted.
6. **Workers finish.** `turn.complete` records tokens and status; a worktree is committed and counted.
7. **Claude combines, then launches the reviewer and the designer**, each on its own model, each told where the run folder is.
8. **The main turn ends with nothing running or paused.** The request closes: `summary.md`, history, chime, banner.

### 4.4 Assigning slots without a race

Claude launches parallel agents in one message, and their `agent.spawn` hooks run at the same moment — each reads the state before any of them has been recorded. Choosing "the first free slot" from the state alone gave all of them slot 1 (and slot 1's model). The fleet therefore keeps `reserved`, a per-request set of slots handed out but not yet recorded. Choosing and reserving happen with no `await` between them, so the next launch sees the reservation; it is released only once the run is in the state, or the launch was refused.

## 5. How each feature works

**Progress.** The plugin registers a tool (`$.tool.register`) the model calls as `mcp__agent-fleet__progress` with `{ done, total, step }`, answered by the plugin's own `tool.call` hook. Workers are asked to call it; a `TodoWrite` or `TaskCreate` list is read as a fallback. A request's percentage gives one share to the planner, each expected worker, the reviewer, the designer and the final combining step.

**Waves.** `wavesOf` assigns each job the first wave after all its dependencies; a cycle puts the rest in one last wave. Enforcement is in `agent.spawn`, so Claude cannot start a job early even by mistake.

**Run folders and file hand-off.** Workers are told to write their result to `job-N.md` and reply with only the path and their notes; later waves receive their dependencies' paths. This keeps very long results out of the conversation.

**Budget.** Every second, `$.session.usage().cost.usd` minus the cost at the request's start gives its live cost. Level 1 (80%) and level 2 (the limit) each fire once: a toast, a transcript line (`$.ui.log`), and at the limit a note to Claude (`$.session.append`); with *stop*, the request's agents are stopped and `agent.spawn` refuses new ones until the next message. Cost arrives in steps as responses finish, hence the documented overshoot.

**Pause and resume.** *Pause* only sets `pauseRequested`. The agent's next `tool.call` hook sees it, marks the run paused, stops the agent with `TaskStop`, tells Claude, and refuses the call — so the agent stops between steps and the refused call never ran. The aborted `turn.complete` keeps the run paused, and the request stays open. *Resume* calls `SendMessage` to the agent's id, which wakes it with its context; if that fails, the agent is rerun with its brief, progress and partial result.

**Peek and rerun.** Peek reads the agent's transcript with `$.session.messages({ agentId })`. Rerun launches `$.agent.spawn` with the stored brief plus a note; the `agent.spawn` hook recognises it by description and gives it the original slot, job and worktree. Its answer is handed to the conversation with `$.prompt.submit`.

**Designer.** A registered agent type with its own system prompt; it inherits the session's tools so it can load the docx, pptx and pdf skills and use the browser. The `tool.call` hook refuses it every tool that would upload or publish (`Artifact*`, `mcp__claude_ai_*`, `DesignSync`, `SendUserFile`, …).

**Worktrees.** Git runs through `$.process.run`. Creation: `git worktree add -b fleet/<request>/job-N <path> <base>`. The guard confines file tools to the worktree and run folder and refuses shell commands that name the main checkout or move branches. Finishing: uncommitted work is committed, commits counted, empty worktrees removed. Merging (`/fleet merge` only): pre-checks, then `git merge --no-ff` per branch; on failure, the conflicted files are read and `git merge --abort` restores the checkout before the fleet stops. Removal uses `git worktree remove` and `git branch -d`, never forced. The ledger lives in `$.store`.

**Quieter transcript.** A `ui.render` hook on `UserMessage` rows whose origin is an agent (`task-notification`, `peer`, `peer-send-message`, `coordinator`) returns one dim line, and returns `next(e)` when the row is expanded, so ctrl+o still shows everything. Quiet mode adds a system-prompt section asking Claude for one-line updates. Only the drawing changes; what the model reads is untouched.

**Notifications and history.** When a request closes, it is appended to `history` in the store; if it lasted 30 seconds or more, `$.audio.play` plays a chime shipped in `fx/`, and `osascript` raises a macOS banner (silently skipped elsewhere).

**The pane.** Built from the surface's element table (`$.ui.resolve(e)`): `Box`, `Text`, `Button`, `Input`. Rows are sized to `e.props.bodyColumns` and cut rather than wrapped; spaces at the edge of a text use a non-breaking space, because the renderer drops plain ones there. A colour scheme paints a full-size `Box` background with a matching text colour.

## 6. Safety decisions

- **Nothing destructive happens on its own.** Merges run only on your command; worktrees and branches are removed only after the merge is confirmed, and never with force; your uncommitted work is never stashed or overwritten.
- **Guards are enforced, not requested.** Where it matters — worktree confinement, git commands, designer uploads, waves, the worker count, the budget stop — the plugin refuses the call itself instead of trusting the model to follow an instruction.
- **Failures fail open for Claude, closed for the plugin's own actions.** If a fleet hook throws, Claude's call proceeds rather than being blocked; if a git step fails, the fleet stops and reports rather than guessing.
- **What the model reads is not hidden.** Folding messages changes only the drawing; notes the fleet adds for Claude are explicit and prefixed `[Agent fleet]`.
- **Honest limits.** The budget can overshoot, a pause waits for the next tool call, a pause lasts for the session, and the cost on a subscription is an API-price estimate. The README says so.

## 7. Testing

```bash
claude plugin validate .   # the module as the engine sees it
claude plugin test .       # the test suite
```

Tests use the kit in `claude-code/testing`. Hooks a test registers sit beneath the plugin and stand in for Claude Code: they answer `agent.spawn` with an agent id, `process.run` with simulated git, `session.usage` with a chosen cost, `tool.call` for `TaskStop` and `SendMessage`. UI tests mount a component (`Pane`, `UserMessage`) on both the terminal and desktop surfaces and press buttons by key. Examples worth reading: the worktree test (job 1 merges, job 2 conflicts, the merge is aborted, nothing is forced), the budget-stop test, the pause-and-resume test, and the parallel-launch slot test.

To type-check, open the plugin folder from a session that has loaded it (Claude Code writes the engine's declarations to `.claude-plugin/types/`, which is git-ignored) and run `tsc -p .`.

## 8. Known limits

- A pause waits for the next tool call. Waking a paused background agent by message is covered by the tests but not yet confirmed across many real runs; if it fails, the fleet falls back to a rerun and says so.
- The budget is a tripwire that can overshoot, and measures the API-price cost.
- Agents belong to the session that started them: pauses and peeks do not survive closing the session.
- The designer is thorough and can be the most expensive stage; choose its model accordingly.
- The banner is macOS only. Opening a run folder uses `open` or `xdg-open`.

## 9. Extending the fleet

### Recipes

- **A new `/fleet` command:** add a branch to the `command.run` hook in `register.tsx` and a line to `HELP_LINES` in `lib.ts`. If a pane button should do the same, put the logic in a top-level function both call — a plugin cannot answer a command it runs itself.
- **A new setting:** add a field to `FleetPlan` in `types/index.d.ts`, read it with a helper in `lib.ts`, change it with `savePlan`. It is stored across sessions automatically.
- **A new lead role** (say, a *tester* that runs the test suite after the workers): add `TESTER_TYPE` and a prompt in `lib.ts`; register the agent type in `session.start`; add the role to `FleetRole`, `phaseOf`, `requestPercent`, `roleLabel` and `ROLE_COLOR`; give it a branch in `agent.spawn` for its model and notes; add a step to `planText`/`promptReminder`; add a pane row and a command branch.
- **A new guard:** write a pure function in `lib.ts` returning a refusal reason or `null`, and call it in the agent `tool.call` hook.
- **A new deliverable type:** add it to the planner prompt's `## Deliverable` line and describe what the designer should produce for it in `DESIGNER_PROMPT`.
- **Always:** add tests, run `claude plugin validate .` and `claude plugin test .`, bump the version in `plugin.json` and `VERSION` in `lib.ts`.

### Ideas for future capabilities

- **Presets:** named plans (`/fleet use research`, `code`, `quick`) saved and switched in one command, optionally per project.
- **Quality checks per job:** the planner writes two or three checks for each job ("every requirement has acceptance criteria"), and the reviewer reports pass or fail for each — catching gaps like missing acceptance criteria automatically.
- **A tester role** for code: runs the project's tests on each worktree before it is offered for merge, and blocks the merge of a branch that fails.
- **Cost per agent:** split the request's cost by agent from per-step token usage, and a per-agent budget.
- **Learning from history:** suggest a plan (workers, models, designer on or off) from past runs of similar requests and what they cost.
- **Resume across sessions:** save enough of a paused agent's state to rerun it in a later session.
- **Notifications elsewhere:** Slack or Teams messages on finish or budget events through a connected MCP server.
- **Team use:** a shared plan in the repository (`.claude/fleet.json`) so a team runs the same fleet on a project.
- **Claude Design, optionally:** where an account has it and the user allows uploads, the designer could produce Slides or Design artifacts as well as local files.
- **Smarter skipping:** let the planner answer a trivial request itself instead of always splitting it.

## 10. Credits

Designed and directed by Belsis Meletis; written with Claude Code. Free to use and customise under the terms in [LICENSE](../LICENSE).
