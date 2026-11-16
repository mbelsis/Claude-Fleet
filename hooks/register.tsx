import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type {
  FleetHistoryEntry,
  FleetLead,
  FleetLeadKey,
  FleetMemory,
  FleetPeek,
  FleetPlan,
  FleetRequest,
  FleetRole,
  FleetRun,
  FleetStatus,
  FleetWorktree,
} from '../types'
import {
  bar,
  budgetLevel,
  elapsedText,
  fileNote,
  fit,
  HELP_LINES,
  isFileHandoffOn,
  isInside,
  isModel,
  isReplaced,
  isWorktreesOn,
  jobOfPrompt,
  jobsOf,
  LEAD_MODELS,
  MAX_AGENTS,
  modelLabel,
  nextLeadModel,
  nextModel,
  NO_STEPS,
  parsePlan,
  percentOf,
  phaseOf,
  PLANNER_PROMPT,
  PLANNER_TYPE,
  plannerOf,
  planText,
  PROGRESS_NOTE,
  PROGRESS_SPEC,
  PROGRESS_TOOL,
  progressFrom,
  promptReminder,
  requestPercent,
  REVIEWER_PROMPT,
  REVIEWER_TYPE,
  reviewerOf,
  shortModel,
  slotLines,
  slugOf,
  stepsAfter,
  taskOf,
  THEME_KEYS,
  DEFAULT_THEME,
  AGENT_ORIGINS,
  compactLine,
  COPYRIGHT,
  QUIET_SECTION,
  VERSION,
  ROLE_COLOR,
  titleOf,
  DESIGNER_PROMPT,
  DESIGNER_TYPE,
  deliverableOf,
  designerGuard,
  designerOf,
  THEMES,
  themeOf,
  tokensText,
  usdText,
  wavesOf,
  worktreeGuard,
  worktreeNote,
  isAbandoned,
  hasOpenPoints,
  QUICK_REVIEW_NOTE,
  reviewNotDue,
  isQuickDirectOn,
  isQuickPrompt,
  QUICK_NOTE,
  isLeadKey,
  isMemoryLow,
  LEAD_NAME,
  leadOf,
  leadOfType,
  memoryFromMeminfo,
  memoryFromSysctl,
  memoryLimitMb,
  memText,
  parseMemory,
  RESEARCHER_PROMPT,
  researcherOf,
  SECURITY_PROMPT,
  securityOf,
  stallActionOf,
  stalledFor,
  stallMinutesOf,
  stallNote,
  stallPlace,
} from './lib'
import type { Phase } from './lib'

// The pure logic lives in ./lib; tests and other plugins import it from here too.
export * from './lib'

const PANE = 'agent-fleet'
/** A space the renderer keeps at the edge of a Text, where a plain one is dropped. */
const NB = '\u00a0'
const KEPT_RUNS = 80
const KEPT_REQUESTS = 6
/** How long the status band stays up after a request finished. */
const BAND_LINGER_MS = 2 * 60 * 1000

const plan = atom({ plugin: 'agent-fleet', key: 'plan' } as const, {
  isEnabled: false,
  models: ['inherit', 'inherit'],
})
const runs = atom({ plugin: 'agent-fleet', key: 'runs' } as const, [])
const now = atom({ plugin: 'agent-fleet', key: 'now' } as const, 0)
const requests = atom({ plugin: 'agent-fleet', key: 'requests' } as const, [])
const isBandHidden = atom({ plugin: 'agent-fleet', key: 'isBandHidden' } as const, false)
const isHelpOpen = atom({ plugin: 'agent-fleet', key: 'isHelpOpen' } as const, false)
const isProjectOff = atom({ plugin: 'agent-fleet', key: 'isProjectOff' } as const, false)
const worktrees = atom({ plugin: 'agent-fleet', key: 'worktrees' } as const, [])
const peek = atom({ plugin: 'agent-fleet', key: 'peek' } as const, null)
const history = atom({ plugin: 'agent-fleet', key: 'history' } as const, [])
const isHistoryOpen = atom({ plugin: 'agent-fleet', key: 'isHistoryOpen' } as const, false)
const memory = atom({ plugin: 'agent-fleet', key: 'memory' } as const, null)
/** How often memory is measured and stuck agents are looked for, in clock ticks (seconds). */
const MEMORY_EVERY = 5
const STALL_EVERY = 10
/** A memory reading younger than this is used again instead of measuring. */
const MEMORY_FRESH_MS = 3_000
/** Finished requests kept across sessions. */
const KEPT_HISTORY = 200
/** Requests shorter than this finish without a sound or banner. */
const NOTIFY_AFTER_MS = 30_000

const GLYPH = { running: '●', paused: '⏸', done: '✓', failed: '✗', stopped: '■' } as const
// Theme keys, so status colours follow the person's light or dark theme.
const STATUS_COLOR = {
  running: 'claude',
  paused: 'warning',
  done: 'success',
  failed: 'error',
  stopped: 'warning',
} as const
const PHASE_LABEL: Record<Phase, string> = {
  researching: 'Researching',
  securing: 'Security review',
  planning: 'Planning',
  working: 'Workers running',
  paused: 'Paused',
  combining: 'Combining results',
  reviewing: 'Reviewing',
  designing: 'Designing',
  done: 'Done',
  stopped: 'Stopped',
}
const WORKTREE_LABEL: Record<FleetWorktree['status'], string> = {
  active: 'in use',
  ready: 'ready to merge',
  empty: 'no changes',
  merged: 'merged',
  conflict: 'CONFLICT',
  removed: 'merged, removed',
  detached: 'branch kept',
}
/** Worktree states whose work is not yet on the base branch. */
const UNMERGED: FleetWorktree['status'][] = ['active', 'ready', 'conflict', 'detached']

const roleLabel = (run: FleetRun): string =>
  run.role === 'planner'
    ? 'planner'
    : run.role === 'reviewer'
      ? 'reviewer'
      : run.role === 'designer'
        ? 'designer'
        : run.role === 'researcher'
          ? 'research'
          : run.role === 'security'
            ? 'security'
            : run.job != null
              ? `job ${run.job}`
              : run.slot !== null
                ? `agent ${run.slot + 1}`
                : 'agent'

async function refreshStatus($: EngineInterface): Promise<void> {
  const list = await read($, runs)
  const running = list.filter(run => run.status === 'running').length
  const done = list.filter(run => run.status !== 'running').length
  $.ui.status(list.length === 0 ? undefined : `fleet: ${running} running · ${done} finished`)
}

async function savePlan($: EngineInterface, change: (current: FleetPlan) => FleetPlan) {
  await update($, plan, change)
  await $.store.set('plan', await read($, plan))
}

/** The project the session works in: its git repository's root, or its working folder. */
async function projectRoot($: EngineInterface): Promise<string> {
  // A host without a repository or session root (a test, a remote surface) gets no project.
  try {
    const repo = await $.session.repo()
    return repo?.root ?? (await $.session.root())
  } catch {
    return ''
  }
}

async function homeDir($: EngineInterface): Promise<string> {
  return (await $.env.get('HOME')) ?? '/tmp'
}

async function git($: EngineInterface, args: string[], cwd: string) {
  return $.process.run(['git', ...args], { cwd, timeoutMs: 120_000 })
}

/** The request still in progress, if any: the latest one with no end. */
async function openRequest($: EngineInterface): Promise<FleetRequest | undefined> {
  return (await read($, requests)).findLast(request => request.endedAt === null)
}

async function setRequest(
  $: EngineInterface,
  id: string,
  change: (request: FleetRequest) => FleetRequest,
): Promise<void> {
  await update($, requests, items => items.map(one => (one.id === id ? change(one) : one)))
}

async function isFleetActive($: EngineInterface): Promise<boolean> {
  return (await read($, plan)).isEnabled && !(await read($, isProjectOff))
}

/** Saves the worktree ledger, which outlives the session so no branch is forgotten. */
async function saveWorktrees(
  $: EngineInterface,
  change: (list: FleetWorktree[]) => FleetWorktree[],
) {
  await update($, worktrees, change)
  await $.store.set('worktrees', await read($, worktrees))
}

async function setWorktree($: EngineInterface, id: string, change: Partial<FleetWorktree>) {
  await saveWorktrees($, list => list.map(one => (one.id === id ? { ...one, ...change } : one)))
}

/** Stops one running agent through the TaskStop tool, as the person's own action. */
async function stopRun(
  $: EngineInterface,
  run: FleetRun,
  consent = `The user pressed "Stop" for the fleet agent "${run.description}".`,
): Promise<void> {
  if (run.status === 'paused') {
    // Already stopped at a safe point: it only stops being resumable.
    const at = await $.clock.now()
    await update($, runs, list =>
      list.map(one =>
        one.id === run.id ? { ...one, status: 'stopped' as const, endedAt: at } : one,
      ),
    )
    await refreshStatus($)
    return
  }
  const answer = await $.tool.call({
    tool: 'TaskStop',
    task_id: run.id,
    consent,
  })
  if (answer.deny !== undefined) {
    $.ui.toast(`Could not stop "${run.description}": ${answer.deny}`)
    return
  }
  const at = await $.clock.now()
  await update($, runs, list =>
    list.map(one =>
      one.id === run.id && one.status === 'running'
        ? { ...one, status: 'stopped' as const, endedAt: at }
        : one,
    ),
  )
  await refreshStatus($)
}

/** A system banner, which reaches the person when the terminal is in the background (macOS only;
 * elsewhere the command is missing and nothing happens). */
async function banner($: EngineInterface, title: string, text: string): Promise<void> {
  const quote = (one: string) => one.replace(/[\\"]/g, '').slice(0, 180)
  const script = `display notification "${quote(text)}" with title "${quote(title)}"`
  await $.process.run(['osascript', '-e', script], { timeoutMs: 5_000 }).catch(() => undefined)
}

/**
 * Something the person should know now, even away from the terminal: a toast, a line that stays
 * in the transcript, and the alert sound and banner their notify setting allows.
 */
async function alertUser($: EngineInterface, title: string, line: string): Promise<void> {
  $.ui.toast(line)
  $.ui.log(line)
  const mode = (await read($, plan)).notify ?? 'all'
  if (mode === 'all' || mode === 'sound') {
    await $.audio.play({ asset: 'fx/alert.wav' }).catch(() => undefined)
  }
  if (mode === 'all' || mode === 'banner') {
    await banner($, title, line.replace(/^Agent fleet: /, ''))
  }
}

/** Announces a finished request: a transcript line always, then a sound and a banner. */
async function announce($: EngineInterface, entry: FleetHistoryEntry): Promise<void> {
  const mode = (await read($, plan)).notify ?? 'all'
  const line =
    `Agent fleet: "${entry.title}" ${entry.outcome === 'done' ? 'finished' : 'stopped'} · ` +
    `${elapsedText(entry.startedAt, entry.endedAt)} · ${entry.agents} agents` +
    (entry.cost ? ` · ${usdText(entry.cost)}` : '') +
    (entry.runDir ? ` · ${entry.runDir}` : '')
  if ((await read($, plan)).messages !== 'quiet') $.ui.log(line)
  if (mode === 'off' || entry.endedAt - entry.startedAt < NOTIFY_AFTER_MS) return
  if (mode === 'all' || mode === 'sound') {
    const asset = entry.outcome === 'done' ? 'fx/done.wav' : 'fx/alert.wav'
    await $.audio.play({ asset }).catch(() => undefined)
  }
  if (mode === 'all' || mode === 'banner') {
    const title = entry.outcome === 'done' ? 'Agent fleet: finished' : 'Agent fleet: stopped'
    await banner($, title, line.replace(/^Agent fleet: /, ''))
  }
}

/** Records a request that has ended in the history, and announces it once. */
async function finishRequest($: EngineInterface, requestId: string): Promise<void> {
  const request = (await read($, requests)).find(one => one.id === requestId)
  if (request === undefined || request.endedAt === null) return
  if ((await read($, history)).some(one => one.id === request.id)) return
  const mine = (await read($, runs)).filter(run => run.requestId === request.id)
  const entry: FleetHistoryEntry = {
    id: request.id,
    title: request.title,
    project: await projectRoot($),
    startedAt: request.startedAt,
    endedAt: request.endedAt,
    outcome: request.outcome === 'stopped' ? 'stopped' : 'done',
    agents: mine.length,
    tokens: mine.reduce((sum, run) => sum + (run.tokens ?? 0), 0),
    cost: request.cost ?? null,
    runDir: request.runDir ?? null,
  }
  await update($, history, list => [...list, entry].slice(-KEPT_HISTORY))
  await $.store.set('history', await read($, history))
  await announce($, entry)
}

/** Opens a run folder in the system's file browser. */
async function openFolder($: EngineInterface, path: string): Promise<void> {
  const opened = await $.process.run(['open', path]).catch(() => null)
  if (opened === null || opened.exitCode !== 0) {
    const other = await $.process.run(['xdg-open', path]).catch(() => null)
    if (other === null || other.exitCode !== 0) $.ui.toast(`Agent fleet: run folder ${path}`)
  }
}

function historyText(list: FleetHistoryEntry[], project: string | null): string {
  const shown = list
    .filter(one => project === null || one.project === project)
    .slice(-15)
    .reverse()
  if (shown.length === 0)
    return project
      ? 'No finished fleet requests in this project yet.'
      : 'No finished fleet requests yet.'
  return shown
    .map(
      one =>
        `${one.outcome === 'done' ? '✓' : '■'} ${new Date(one.endedAt).toISOString().slice(0, 16).replace('T', ' ')} ` +
        `${one.title} · ${elapsedText(one.startedAt, one.endedAt)} · ${one.agents} agents` +
        (one.cost ? ` · ${usdText(one.cost)}` : '') +
        (project === null ? `\n    ${one.project}` : '') +
        (one.runDir ? `\n    ${one.runDir}` : ''),
    )
    .join('\n')
}

/** Tells the main conversation what the person did to its agents, so it waits or carries on. */
async function tellMain($: EngineInterface, text: string): Promise<void> {
  await $.session
    .append({
      message: { type: 'user', content: [{ type: 'text', text: `[Agent fleet] ${text}` }] },
    })
    .catch(() => undefined)
}

/**
 * Asks a running agent to pause. Nothing is cut off mid-step: the fleet waits for the agent's
 * next tool call, refuses that call, and stops the agent there (see the tool.call hook).
 */
async function pauseRun(
  $: EngineInterface,
  run: FleetRun,
  reason: 'memory' | null = null,
): Promise<void> {
  if (run.status !== 'running') return
  await update($, runs, list =>
    list.map(one =>
      one.id === run.id ? { ...one, pauseRequested: true, pauseReason: reason } : one,
    ),
  )
  if (reason === null) {
    $.ui.toast(`Agent fleet: "${run.description}" will pause at its next tool call.`)
  }
}

/** Wakes a paused agent with a message; it carries on with everything it had done. */
async function resumeRun(
  $: EngineInterface,
  run: FleetRun,
  queue: Map<string, FleetRun>,
): Promise<void> {
  if (run.status !== 'paused') return
  const at = await $.clock.now()
  const answer = await $.tool
    .call({
      tool: 'SendMessage',
      to: run.id,
      summary: 'Resume a paused fleet agent',
      message:
        'Resume your task from where you stopped. The user paused you just before a tool call; ' +
        'that call did not run, so make it again if you still need it.',
      consent: `The user pressed "Resume" for the fleet agent "${run.description}".`,
    })
    .catch((error: unknown) => ({ deny: String(error) }))
  const failed = answer.deny !== undefined || (answer as { isError?: boolean }).isError === true
  if (failed) {
    // The agent could not be woken: start it again with its brief and what it had done.
    const done = run.progress
      ? ` It had finished ${run.progress.done} of ${run.progress.total} steps (next: ${run.progress.step}).`
      : ''
    const partial = run.outputPath
      ? ` Any partial result is in ${run.outputPath}; build on it.`
      : ''
    await update($, runs, list =>
      list.map(one => (one.id === run.id ? { ...one, status: 'stopped' as const } : one)),
    )
    await rerunRun($, run, `This continues an earlier run the user paused.${done}${partial}`, queue)
    $.ui.toast(`Agent fleet: "${run.description}" could not be woken, so it was started again.`)
    return
  }
  await update($, runs, list =>
    list.map(one =>
      one.id === run.id
        ? {
            ...one,
            status: 'running' as const,
            endedAt: null,
            pauseReason: null,
            stalledAt: null,
            busyTool: null,
            lastActivityAt: at,
          }
        : one,
    ),
  )
  await tellMain($, `The user resumed "${run.description}". Wait for its result as before.`)
  await refreshStatus($)
}

async function stopRequest($: EngineInterface, request: FleetRequest): Promise<void> {
  const list = await read($, runs)
  const running = list.filter(
    run => run.requestId === request.id && (run.status === 'running' || run.status === 'paused'),
  )
  for (const run of running) await stopRun($, run)
  const at = await $.clock.now()
  await setRequest($, request.id, one =>
    one.endedAt === null ? { ...one, endedAt: at, outcome: 'stopped' } : one,
  )
  await finishRequest($, request.id)
}

/** Creates the worktree and branch one worker edits in, cut from the request's base commit. */
async function createWorktree(
  $: EngineInterface,
  request: FleetRequest,
  job: number,
  label: string,
  name = `job-${job}`,
): Promise<FleetWorktree | string> {
  const repo = await $.session.repo()
  if (repo === null) return 'this project is not a git repository'
  let baseCommit = request.baseCommit ?? null
  let baseBranch = request.baseBranch ?? null
  if (baseCommit === null) {
    const head = await git($, ['rev-parse', 'HEAD'], repo.root)
    const branch = await git($, ['rev-parse', '--abbrev-ref', 'HEAD'], repo.root)
    if (head.exitCode !== 0) return `cannot read HEAD: ${head.stderr.trim()}`
    baseCommit = head.stdout.trim()
    baseBranch = branch.stdout.trim()
    await setRequest($, request.id, one => ({ ...one, baseCommit, baseBranch }))
    const dirty = await git($, ['status', '--porcelain', '--untracked-files=no'], repo.root)
    if (dirty.stdout.trim() !== '') {
      $.ui.toast(
        'Agent fleet: your checkout has uncommitted changes; worktrees start from the last ' +
          'commit and will not contain them.',
      )
    }
  }
  const existing = (await read($, worktrees)).find(
    one =>
      one.requestId === request.id && one.id === `${request.id}-${name}` && one.status === 'active',
  )
  if (existing) return existing
  const home = await homeDir($)
  const repoName = slugOf(repo.root.split('/').pop() ?? 'repo')
  const branch = `fleet/${request.id}/${name}`
  const path = `${home}/.claude/fleet-worktrees/${repoName}/${request.id}-${name}`
  const added = await git($, ['worktree', 'add', '-b', branch, path, baseCommit], repo.root)
  if (added.exitCode !== 0) return added.stderr.trim() || 'git worktree add failed'
  const worktree: FleetWorktree = {
    id: `${request.id}-${name}`,
    repoRoot: repo.root,
    requestId: request.id,
    requestTitle: request.title,
    job,
    label,
    path,
    branch,
    baseCommit,
    baseBranch: baseBranch ?? 'HEAD',
    createdAt: await $.clock.now(),
    status: 'active',
    commits: 0,
    note: '',
  }
  await saveWorktrees($, list => [...list, worktree])
  return worktree
}

/**
 * Makes sure nothing is left uncommitted in a worktree: anything the agent did not commit is
 * committed on its branch. Returns null when the worktree is clean afterwards, or why not.
 */
async function saveWorktreeWork($: EngineInterface, wt: FleetWorktree): Promise<string | null> {
  const status = await git($, ['status', '--porcelain'], wt.path)
  if (status.exitCode !== 0) return status.stderr.trim() || 'cannot read the worktree status'
  if (status.stdout.trim() === '') return null
  const added = await git($, ['add', '-A'], wt.path)
  if (added.exitCode !== 0) return added.stderr.trim()
  const committed = await git(
    $,
    ['commit', '-m', `fleet: save uncommitted work of ${wt.label}`],
    wt.path,
  )
  return committed.exitCode === 0 ? null : committed.stderr.trim() || committed.stdout.trim()
}

/** After a worker ends: save its work, count its commits, and drop a worktree that made none. */
async function finishWorktree($: EngineInterface, wt: FleetWorktree): Promise<void> {
  const unsaved = await saveWorktreeWork($, wt)
  if (unsaved !== null) {
    await setWorktree($, wt.id, { note: `uncommitted changes could not be saved: ${unsaved}` })
    $.ui.toast(
      `Agent fleet: ${wt.label} left changes that could not be committed — see /fleet worktrees`,
    )
    return
  }
  const count = await git($, ['rev-list', '--count', `${wt.baseCommit}..${wt.branch}`], wt.repoRoot)
  const commits = Number(count.stdout.trim()) || 0
  if (commits > 0) {
    await setWorktree($, wt.id, { status: 'ready', commits, note: '' })
    return
  }
  // No commits and a clean tree: nothing to keep. Neither removal is ever forced.
  const removed = await git($, ['worktree', 'remove', wt.path], wt.repoRoot)
  const deleted =
    removed.exitCode === 0 ? await git($, ['branch', '-d', wt.branch], wt.repoRoot) : removed
  await setWorktree($, wt.id, {
    status: removed.exitCode === 0 ? 'empty' : 'ready',
    commits: 0,
    note: deleted.exitCode === 0 ? '' : `kept: ${deleted.stderr.trim()}`,
  })
}

/**
 * Merges the finished worktrees of this repository into their base branch, one branch at a
 * time in job order. Stops at the first conflict and aborts that merge, so the checkout is
 * left as it was before it; never stashes, never resolves, never forces. Worktrees are
 * removed only after their branch is confirmed merged.
 */
async function mergeWorktrees($: EngineInterface): Promise<string> {
  const repo = await $.session.repo()
  if (repo === null) return 'This project is not a git repository.'
  const list = (await read($, worktrees)).filter(
    one => one.repoRoot === repo.root && (one.status === 'ready' || one.status === 'conflict'),
  )
  if (list.length === 0) return 'No finished fleet worktrees are waiting to be merged here.'
  const active = (await read($, worktrees)).filter(
    one => one.repoRoot === repo.root && one.status === 'active',
  )
  const running = (await read($, runs)).filter(
    run =>
      run.status === 'running' && run.worktreeId && active.some(one => one.id === run.worktreeId),
  )
  if (running.length > 0) {
    return `Wait for the running workers first: ${running.map(run => run.description).join(', ')}.`
  }
  const inMerge = await git($, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'], repo.root)
  if (inMerge.exitCode === 0) {
    return 'A merge is already in progress in your checkout. Finish or abort it, then run /fleet merge again.'
  }
  const dirty = await git($, ['status', '--porcelain', '--untracked-files=no'], repo.root)
  if (dirty.stdout.trim() !== '') {
    return (
      'Your checkout has uncommitted changes. Commit them (or set them aside yourself) and run ' +
      '/fleet merge again; the fleet never stashes or overwrites your work.'
    )
  }
  const branchNow = (await git($, ['rev-parse', '--abbrev-ref', 'HEAD'], repo.root)).stdout.trim()
  const report: string[] = []
  const ordered = [...list].sort((a, b) => a.createdAt - b.createdAt || (a.job ?? 0) - (b.job ?? 0))
  for (const wt of ordered) {
    if (wt.baseBranch !== branchNow) {
      report.push(
        `✗ ${wt.label}: made from ${wt.baseBranch}, but ${branchNow} is checked out. Switch to ` +
          `${wt.baseBranch} and run /fleet merge again.`,
      )
      break
    }
    const unsaved = await saveWorktreeWork($, wt)
    if (unsaved !== null) {
      report.push(`✗ ${wt.label}: uncommitted changes could not be saved (${unsaved}). Stopped.`)
      break
    }
    const isMerged = await git($, ['merge-base', '--is-ancestor', wt.branch, 'HEAD'], repo.root)
    if (isMerged.exitCode !== 0) {
      const merged = await git(
        $,
        ['merge', '--no-ff', '--no-edit', '-m', `fleet: merge ${wt.label}`, wt.branch],
        repo.root,
      )
      if (merged.exitCode !== 0) {
        const files = await git($, ['diff', '--name-only', '--diff-filter=U'], repo.root)
        await git($, ['merge', '--abort'], repo.root)
        const conflicted = files.stdout.trim().split('\n').filter(Boolean)
        await setWorktree($, wt.id, {
          status: 'conflict',
          note: conflicted.length ? `conflicts in ${conflicted.join(', ')}` : merged.stderr.trim(),
        })
        report.push(
          `✗ ${wt.label} conflicts with what is already merged` +
            (conflicted.length ? ` (${conflicted.join(', ')})` : '') +
            `. The merge was aborted, so your checkout is unchanged. Resolve it with ` +
            `"git merge ${wt.branch}" and commit, then run /fleet merge again to continue.`,
        )
        break
      }
    }
    await setWorktree($, wt.id, { status: 'merged', note: '' })
    const removed = await git($, ['worktree', 'remove', wt.path], repo.root)
    const deleted =
      removed.exitCode === 0 ? await git($, ['branch', '-d', wt.branch], repo.root) : removed
    if (removed.exitCode === 0 && deleted.exitCode === 0) {
      await setWorktree($, wt.id, { status: 'removed' })
      report.push(`✓ ${wt.label}: merged (${wt.commits} commits); worktree and branch removed.`)
    } else {
      await setWorktree($, wt.id, {
        note: `merged; cleanup left for you: ${deleted.stderr.trim()}`,
      })
      report.push(`✓ ${wt.label}: merged; ${wt.path} was kept (${deleted.stderr.trim()}).`)
    }
  }
  const left = (await read($, worktrees)).filter(
    one => one.repoRoot === repo.root && UNMERGED.includes(one.status),
  )
  if (left.length) report.push(`${left.length} fleet worktree(s) still hold unmerged work.`)
  return report.join('\n')
}

/** Removes one worktree folder but keeps its branch, so its commits stay reachable. */
async function detachWorktree($: EngineInterface, job: number): Promise<string> {
  const repo = await $.session.repo()
  const wt = (await read($, worktrees))
    .filter(one => one.repoRoot === repo?.root && one.job === job && UNMERGED.includes(one.status))
    .at(-1)
  if (wt === undefined) return `No unmerged fleet worktree for job ${job} here.`
  const running = (await read($, runs)).some(
    run => run.worktreeId === wt.id && run.status === 'running',
  )
  if (running) return `Job ${job}'s worker is still running.`
  const unsaved = await saveWorktreeWork($, wt)
  if (unsaved !== null) return `Job ${job}: uncommitted changes could not be saved (${unsaved}).`
  const removed = await git($, ['worktree', 'remove', wt.path], wt.repoRoot)
  if (removed.exitCode !== 0) return `Could not remove ${wt.path}: ${removed.stderr.trim()}`
  await setWorktree($, wt.id, { status: 'detached', note: 'folder removed; branch kept' })
  return `Removed ${wt.path}. Branch ${wt.branch} is kept with its ${wt.commits} commit(s).`
}

async function worktreeReport($: EngineInterface): Promise<string> {
  const root = await projectRoot($)
  const list = (await read($, worktrees)).filter(one => one.repoRoot === root)
  if (list.length === 0) return 'No fleet worktrees in this project.'
  return list
    .map(
      one =>
        `${UNMERGED.includes(one.status) ? '•' : '✓'} ${one.label} — ${WORKTREE_LABEL[one.status]}` +
        ` · ${one.commits} commit(s) · ${one.branch}\n    ${one.path}${one.note ? `\n    ${one.note}` : ''}`,
    )
    .join('\n')
}

/**
 * Switches the fleet on or off for the current project. Shared by `/fleet use` and the pane's
 * button: a plugin cannot answer a command it runs itself, so the button calls this directly.
 */
async function setProjectUse($: EngineInterface, isOn: boolean): Promise<string> {
  const root = await projectRoot($)
  const offList = ((await $.store.get('projects-off')) as string[] | undefined) ?? []
  const nextList = isOn ? offList.filter(one => one !== root) : [...new Set([...offList, root])]
  await $.store.set('projects-off', nextList)
  await update($, isProjectOff, () => !isOn)
  return isOn
    ? `Agent fleet is on again for ${root}.`
    : `Agent fleet is off for ${root}. Other projects keep their setting; /fleet use on turns it back on here.`
}

/** Turns worktrees on or off; shared by `/fleet worktrees on|off` and the pane's button. */
async function setWorktreesMode($: EngineInterface, isOn: boolean): Promise<string> {
  if (isOn && (await $.session.repo()) === null) {
    return 'This project is not a git repository, so worktrees cannot be used here.'
  }
  await savePlan($, current => ({ ...current, isWorktrees: isOn }))
  return isOn
    ? 'Each worker now edits its own git worktree and branch. Merge them with /fleet merge.'
    : 'Workers edit the project directly. Existing fleet worktrees are kept; see /fleet worktrees.'
}

/** Reads what an agent is doing: its latest text and its latest tool call. */
async function peekRun($: EngineInterface, run: FleetRun): Promise<FleetPeek> {
  const at = await $.clock.now()
  const messages = await $.session.messages({ agentId: run.id })
  if (!Array.isArray(messages)) return { runId: run.id, text: messages.deny, tool: '', at }
  const assistant = messages.filter(message => message.role === 'assistant')
  const lastText = [...assistant].reverse().find(message => message.text.trim() !== '')
  const lastTool = [...assistant].reverse().flatMap(message => [...message.toolUses].reverse())[0]
  const toolText = lastTool
    ? `${lastTool.tool} ${String(
        lastTool.input.file_path ??
          lastTool.input.command ??
          lastTool.input.query ??
          lastTool.input.pattern ??
          lastTool.input.url ??
          lastTool.input.step ??
          '',
      ).slice(0, 120)}`
    : ''
  const text = (lastText?.text ?? '(no text yet)').trim().split('\n').slice(-6).join('\n')
  return { runId: run.id, text: text.slice(0, 900), tool: toolText, at }
}

/** The record of an agent that repeats `run`: same role, slot, job, brief and worktree. */
function rerunRecord(
  run: FleetRun,
  id: string,
  description: string,
  model: string,
  at: number,
): FleetRun {
  return {
    id,
    description,
    type: run.type,
    model,
    slot: run.slot,
    status: 'running',
    startedAt: at,
    lastActivityAt: at,
    busyTool: null,
    stalledAt: null,
    stallRestarts: (run.stallRestarts ?? 0) + (run.stalledAt != null ? 1 : 0),
    endedAt: null,
    tools: 0,
    lastTool: null,
    tokens: null,
    steps: NO_STEPS,
    role: run.role ?? 'worker',
    requestId: run.requestId ?? null,
    progress: null,
    task: run.task ?? taskOf(run.prompt ?? ''),
    prompt: run.prompt,
    notes: run.notes ?? '',
    job: run.job ?? null,
    outputPath: run.outputPath ?? null,
    worktreeId: run.worktreeId ?? null,
    rerunOf: run.id,
  }
}

/** The description a rerun of this agent is launched under, which its spawn is recognised by. */
const rerunDescription = (run: FleetRun): string =>
  `${run.description.replace(/ \(rerun\)$/, '')} (rerun)`

/**
 * Starts a finished agent again with the same brief and the person's note. Resolves to whether
 * the new agent started.
 */
async function rerunRun(
  $: EngineInterface,
  run: FleetRun,
  note: string,
  queue: Map<string, FleetRun>,
): Promise<boolean> {
  if (!run.prompt) {
    $.ui.toast(
      'Agent fleet: this agent started before reruns were possible; its brief was not kept.',
    )
    return false
  }
  const description = rerunDescription(run)
  // The spawn hook does not run for an agent the fleet starts from its own clock, so what the
  // hook would have refused is checked here too.
  const short = await memoryRefusal($, await read($, plan)).catch(() => null)
  if (short !== null) {
    $.ui.toast(`Agent fleet: "${run.description}" was not started again: memory is low.`)
    return false
  }
  queue.set(description, run)
  const wt = run.worktreeId
    ? (await read($, worktrees)).find(one => one.id === run.worktreeId)
    : undefined
  const extra = note.trim() ? `\n\nNote from the user for this rerun: ${note.trim()}` : ''
  const started = await $.agent.spawn({
    // The brief as its caller wrote it, then the fleet's own notes (where to write the result,
    // the worktree, the slots), which the first launch added and this one must not lose.
    prompt: run.prompt + (run.notes ?? '') + extra,
    description,
    subagentType: run.type,
    model: run.model,
    ...(wt && UNMERGED.includes(wt.status) ? { cwd: wt.path } : {}),
  })
  if (started.deny !== undefined) {
    queue.delete(description)
    $.ui.toast(`Agent fleet: rerun refused: ${started.deny}`)
    return false
  }
  // The spawn hook does not see every launch the fleet makes itself, and a launch may answer
  // without its id: the new agent is then found in the engine's list by its description.
  const known = await read($, runs)
  let agentId = started.agentId
  if (agentId === undefined) {
    const listed = await $.agent.list().catch(() => null)
    agentId = (Array.isArray(listed) ? listed : []).findLast(
      one => one.description === description && !known.some(seen => seen.id === one.id),
    )?.id
  }
  if (agentId !== undefined && !known.some(one => one.id === agentId)) {
    queue.delete(description)
    const at = await $.clock.now()
    const record = rerunRecord(run, agentId, description, started.model ?? run.model, at)
    await update($, runs, items => [...items, record].slice(-KEPT_RUNS))
    await refreshStatus($)
  }
  return true
}

/** Keeps a request's live cost and acts on its budget. */
async function tickBudget($: EngineInterface): Promise<void> {
  // The latest request, and for a minute after it ends too: responses still in flight when it
  // stopped land afterwards, and the figure shown should include them.
  const request = (await read($, requests)).at(-1)
  if (request === undefined || request.costAtStart == null) return
  const at = await $.clock.now()
  if (request.endedAt !== null && at - request.endedAt > 60_000) return
  const usd = (await $.session.usage()).cost?.usd
  if (usd === undefined) return
  const cost = Math.max(0, usd - request.costAtStart)
  const fleet = await read($, plan)
  const level = budgetLevel(cost, fleet.budgetUsd)
  const before = request.budgetLevel ?? 0
  if (Math.abs(cost - (request.cost ?? 0)) >= 0.01 || level > before) {
    await setRequest($, request.id, one => ({
      ...one,
      cost,
      budgetLevel: Math.max(level, one.budgetLevel ?? 0),
    }))
  }
  if (level <= before || !fleet.budgetUsd || request.endedAt !== null) return
  const budget = usdText(fleet.budgetUsd)
  if (level === 1) {
    const line = `Agent fleet: "${request.title}" has used ${usdText(cost)} of its ${budget} budget.`
    $.ui.toast(line)
    $.ui.log(line)
    return
  }
  const isStop = fleet.budgetAction === 'stop'
  const line =
    `Agent fleet: "${request.title}" reached its ${budget} budget (${usdText(cost)} used)` +
    (isStop ? ' and was stopped. No further agents start for it.' : '.')
  // A toast passes quickly; the transcript line stays, and Claude is told why.
  $.ui.toast(line)
  $.ui.log(line)
  await $.session.append({
    message: {
      type: 'user',
      content: [
        {
          type: 'text',
          text:
            `[Agent fleet] This request reached the user's ${budget} budget (${usdText(cost)} used).` +
            (isStop
              ? ' The fleet stopped its agents and will refuse new ones. Do not relaunch them; tell ' +
                'the user the budget was reached and offer to continue if they raise it (/fleet budget).'
              : ' The user chose to be warned, not stopped; finish promptly and mention the cost.'),
        },
      ],
    },
  })
  if (isStop) await stopRequest($, request)
}

/**
 * Measures the memory the laptop still has available: on macOS the kernel's own figure, on
 * Linux MemAvailable. Null where neither can be read; the guard then does nothing.
 */
async function readMemory($: EngineInterface): Promise<FleetMemory | null> {
  const at = await $.clock.now()
  const known = await read($, memory)
  if (known !== null && at >= known.at && at - known.at < MEMORY_FRESH_MS) return known
  const run = (argv: string[]) => $.process.run(argv, { timeoutMs: 5_000 }).catch(() => null)
  const mac = await run(['sysctl', '-n', 'kern.memorystatus_level', 'hw.memsize'])
  let found = mac !== null && mac.exitCode === 0 ? memoryFromSysctl(mac.stdout) : null
  if (found === null) {
    const linux = await run(['cat', '/proc/meminfo'])
    found = linux !== null && linux.exitCode === 0 ? memoryFromMeminfo(linux.stdout) : null
  }
  if (found === null) return null
  const limit = memoryLimitMb(await read($, plan), found.totalMb)
  const fresh: FleetMemory = {
    ...found,
    at,
    isLow: limit !== null && isMemoryLow(found.availMb, limit, known?.isLow ?? false),
  }
  await update($, memory, () => fresh)
  return fresh
}

/** Why no agent may start now for lack of memory, or null when one may. */
async function memoryRefusal($: EngineInterface, fleet: FleetPlan): Promise<string | null> {
  if (fleet.memMinFreeMb === null) return null
  const mem = await readMemory($)
  if (mem === null) return null
  const limit = memoryLimitMb(fleet, mem.totalMb)
  if (limit === null || mem.availMb >= limit) return null
  return (
    `Agent fleet: only ${memText(mem.availMb)} of memory is available and the user's limit is ` +
    `${memText(limit)}, so no further agent starts now. If agents of this request are still ` +
    'running, wait for one to finish and then launch this one again, once. If none is running, ' +
    'stop and tell the user that memory is too low to continue; they can free memory or change ' +
    'the limit with /fleet memory.'
  )
}

/**
 * Watches memory while agents run. When it falls below the limit, once per episode: warns,
 * pauses every running agent at its next tool call, or stops the request, as the person chose.
 */
async function tickMemory($: EngineInterface): Promise<void> {
  const fleet = await read($, plan)
  if (fleet.memMinFreeMb === null) return
  const list = await read($, runs)
  const running = list.filter(run => run.status === 'running')
  // Agents paused for memory keep the reading fresh, so the pane shows when it has recovered.
  if (running.length === 0 && !list.some(run => run.status === 'paused')) return
  const before = (await read($, memory))?.isLow ?? false
  const mem = await readMemory($)
  if (mem === null || !mem.isLow || before || running.length === 0) return
  const limit = memoryLimitMb(fleet, mem.totalMb) ?? 0
  const action = fleet.memAction ?? 'pause'
  const low = `only ${memText(mem.availMb)} of memory is available (limit ${memText(limit)})`
  if (action === 'warn') {
    await alertUser($, 'Agent fleet: memory is low', `Agent fleet: ${low}. Agents keep running.`)
    return
  }
  if (action === 'stop') {
    await alertUser(
      $,
      'Agent fleet: memory is low',
      `Agent fleet: ${low}; the agents were stopped.`,
    )
    await tellMain(
      $,
      `Memory on the user's laptop ran low (${low}), so the fleet stopped its agents. Do not ` +
        'relaunch them and do not do their work now; tell the user, who can free memory and ask again.',
    )
    const open = await openRequest($)
    if (open !== undefined) await stopRequest($, open)
    for (const run of (await read($, runs)).filter(one => one.status === 'running')) {
      await stopRun(
        $,
        run,
        'The user set /fleet memory stop: agents are stopped when memory runs low.',
      )
    }
    return
  }
  await alertUser(
    $,
    'Agent fleet: memory is low',
    `Agent fleet: ${low}; ${running.length} agent(s) pause at their next tool call. Free ` +
      'memory, then /fleet resume.',
  )
  await tellMain(
    $,
    `Memory on the user's laptop ran low (${low}), so the fleet is pausing its agents at their ` +
      'next tool call. Do not relaunch them, do not do their work yourself and do not finish the ' +
      'request without them: the user resumes them once memory is free.',
  )
  for (const run of running) await pauseRun($, run, 'memory')
}

/**
 * Acts on one agent that has stopped moving: marks it, alerts the person, and then, as they
 * chose, leaves it (warn), wakes Claude to deal with it (tell), or stops it and starts its job
 * again once (restart). A job that gets stuck a second time is handed to Claude.
 */
async function handleStall(
  $: EngineInterface,
  run: FleetRun,
  quietMs: number,
  queue: Map<string, FleetRun>,
): Promise<void> {
  const at = await $.clock.now()
  const fleet = await read($, plan)
  const minutes = Math.max(1, Math.round(quietMs / 60_000))
  const place = stallPlace(run)
  const stalled: FleetRun = { ...run, stalledAt: at }
  await update($, runs, list =>
    list.map(one => (one.id === run.id ? { ...one, stalledAt: at } : one)),
  )
  const action = stallActionOf(fleet)
  const head = `Agent fleet: "${run.description}" has shown no activity for ${minutes} minutes (${place}); it looks stuck.`
  if (action === 'warn') {
    await alertUser(
      $,
      'Agent fleet: an agent looks stuck',
      `${head} Peek at it, or stop it, in /fleet.`,
    )
    return
  }
  if (action === 'restart' && (run.stallRestarts ?? 0) < 1 && run.prompt) {
    await tellMain(
      $,
      `"${run.description}" showed no activity for ${minutes} minutes (${place}), so the fleet ` +
        'is stopping it and starting its job again with the same brief. Do not relaunch it and ' +
        'do not do its job yourself: the new result will arrive as a message. Carry on with ' +
        'anything that does not depend on it.',
    )
    // Queued before the stop, so the stopped agent's worktree is kept for the one that follows.
    queue.set(rerunDescription(run), stalled)
    await stopRun(
      $,
      run,
      `The user set /fleet stuck restart: "${run.description}" showed no activity for ${minutes} minutes.`,
    )
    const stopped = (await read($, runs)).find(one => one.id === run.id)
    const isRestarted =
      stopped !== undefined &&
      stopped.status !== 'running' &&
      (await rerunRun($, stalled, stallNote(run, minutes), queue))
    if (isRestarted) {
      await alertUser(
        $,
        'Agent fleet: restarted a stuck agent',
        `${head} It was stopped and started again.`,
      )
      return
    }
    queue.delete(rerunDescription(run))
    await tellMain(
      $,
      `The fleet could not restart "${run.description}" after all; the next message says what to do.`,
    )
  }
  // Hand it to Claude, which is otherwise still waiting for a result that may never come.
  await alertUser(
    $,
    'Agent fleet: an agent looks stuck',
    `${head} Claude was asked to deal with it.`,
  )
  const again = (run.stallRestarts ?? 0) > 0 ? ' The fleet already restarted this job once.' : ''
  const file = run.outputPath ? ` Its result file, if it wrote one, is ${run.outputPath}.` : ''
  await $.prompt
    .submit({
      text:
        `[Agent fleet] The agent "${run.description}" (task id ${run.id}) has shown no activity ` +
        `for ${minutes} minutes, ${place}, and is probably stuck.${again}${file} Do not keep ` +
        'waiting for it. Check it now. If it is stuck, stop it with TaskStop and then either ' +
        'launch its job again with the same brief (the fleet allows that for a stuck agent) or ' +
        'do the rest of its work yourself, and say which you did. If it is still working, leave ' +
        'it and tell the user what it is doing.',
    })
    .catch(() => undefined)
}

/**
 * Looks for agents that have stopped moving. Activity is a model response arriving (counted in
 * `beats` by the turn.step hook) or a tool call. An agent the engine lists as ended, though its
 * end never reached the fleet, is closed here so nothing waits for it.
 */
async function tickStalls(
  $: EngineInterface,
  beats: Map<string, number>,
  seen: Map<string, number>,
  queue: Map<string, FleetRun>,
): Promise<void> {
  const at = await $.clock.now()
  const running = (await read($, runs)).filter(run => run.status === 'running')
  const moved = new Set(
    running.filter(run => beats.get(run.id) !== seen.get(run.id)).map(r => r.id),
  )
  for (const id of moved) seen.set(id, beats.get(id) ?? 0)
  for (const id of [...beats.keys()]) {
    if (!running.some(run => run.id === id)) {
      beats.delete(id)
      seen.delete(id)
    }
  }
  if (moved.size > 0) {
    await update($, runs, list =>
      list.map(one =>
        moved.has(one.id) && one.status === 'running'
          ? { ...one, lastActivityAt: at, busyTool: null, stalledAt: null }
          : one,
      ),
    )
  }
  const minutes = stallMinutesOf(await read($, plan))
  if (minutes === null || running.length === 0) return
  const listed = await $.agent.list().catch(() => null)
  const infos = Array.isArray(listed) ? listed : []
  for (const run of (await read($, runs)).filter(one => one.status === 'running')) {
    const info = infos.find(one => one.id === run.id)
    const quiet = at - (run.lastActivityAt ?? run.startedAt)
    const ended =
      info?.status === 'completed'
        ? ('done' as const)
        : info?.status === 'failed'
          ? ('failed' as const)
          : info?.status === 'killed'
            ? ('stopped' as const)
            : null
    if (ended !== null) {
      // Its end should have arrived as turn.complete; a minute later it clearly has not.
      if (quiet < 60_000) continue
      await update($, runs, list =>
        list.map(one =>
          one.id === run.id && one.status === 'running'
            ? { ...one, status: ended, endedAt: at, busyTool: null }
            : one,
        ),
      )
      $.ui.log(
        `Agent fleet: "${run.description}" had already ended (${info?.status}) without reporting; it is now shown as ${ended}.`,
      )
      const wt = run.worktreeId
        ? (await read($, worktrees)).find(one => one.id === run.worktreeId)
        : undefined
      if (wt && wt.status === 'active') await finishWorktree($, wt)
      await refreshStatus($)
      continue
    }
    if (run.stalledAt != null) continue
    const stalledMs = stalledFor(run, at, minutes, info?.status === 'waiting')
    if (stalledMs !== null) await handleStall($, run, stalledMs, queue)
  }
}

export const register: Register = on => {
  // Slots the main loop has handed out since the person's last prompt, when no job is named.
  let slotCursor = 0
  // Slots handed out but not yet recorded, per request. Agents launched together reach the
  // spawn hook at the same moment, before any of them is in the state; without this they all
  // took slot 1 (and its model).
  const reserved = new Map<string, Set<number>>()
  // Reruns waiting for their agent.spawn, by description.
  const rerunQueue = new Map<string, FleetRun>()
  // Chunks of model output seen per agent, and the count the watchdog last looked at: a
  // response still arriving is activity, however long it takes.
  const beats = new Map<string, number>()
  const seenBeats = new Map<string, number>()
  let ticks = 0

  on('session.start', async ($, e, next) => {
    const saved = (await $.store.get('plan')) as FleetPlan | undefined
    if (saved !== undefined && Array.isArray(saved.models)) {
      await update($, plan, () => saved)
    }
    const root = await projectRoot($)
    const offList = ((await $.store.get('projects-off')) as string[] | undefined) ?? []
    await update($, isProjectOff, () => offList.includes(root))
    const past = ((await $.store.get('history')) as FleetHistoryEntry[] | undefined) ?? []
    await update($, history, () => past)
    const ledger = ((await $.store.get('worktrees')) as FleetWorktree[] | undefined) ?? []
    await update($, worktrees, () => ledger)
    const pending = ledger.filter(one => one.repoRoot === root && UNMERGED.includes(one.status))
    if (pending.length > 0) {
      $.ui.toast(
        `Agent fleet: ${pending.length} worktree branch(es) here hold unmerged work — /fleet worktrees`,
      )
    }

    await $.command.register({
      name: 'fleet',
      description: 'Split tasks across subagents you configure, and follow their progress',
      argumentHint: '[N model…] | on | off | use on|off | merge | worktrees | budget … | help',
    })
    await $.agent.register({
      name: 'planner',
      description:
        'Lead planner of the agent fleet: thinks a task through and returns one self-contained ' +
        'job brief per worker slot. Launch it first when the fleet plan has a planner.',
      prompt: PLANNER_PROMPT,
      tools: ['Read', 'Bash', 'WebSearch', 'WebFetch'],
      effort: 'high',
    })
    await $.agent.register({
      name: 'reviewer',
      description:
        "Reviewer of the agent fleet: checks and corrects the combined draft of the fleet's " +
        'workers. Launch it last when the fleet plan has a reviewer.',
      prompt: REVIEWER_PROMPT,
      tools: ['Read', 'Bash', 'WebSearch', 'WebFetch'],
      effort: 'high',
    })
    await $.agent.register({
      name: 'designer',
      description:
        "Designer of the agent fleet: polishes the fleet's final result into documents, decks or " +
        'improved web pages as local files. Launch it last when the fleet plan has a designer.',
      prompt: DESIGNER_PROMPT,
      effort: 'high',
    })
    await $.agent.register({
      name: 'researcher',
      description:
        'Market researcher of the agent fleet: searches the web for competing and alternative ' +
        'products, features, books, papers, decks and videos, and returns a research brief for ' +
        'the planner. Launch it first when the fleet plan has a researcher.',
      prompt: RESEARCHER_PROMPT,
      tools: ['Read', 'Bash', 'WebSearch', 'WebFetch'],
      effort: 'high',
    })
    await $.agent.register({
      name: 'security',
      description:
        'Security reviewer of the agent fleet: reviews the code, configuration and AI agents the ' +
        "fleet's workers built for security problems and reports findings; read-only. Launch it " +
        'as the very last step when the fleet plan has a security reviewer.',
      prompt: SECURITY_PROMPT,
      tools: ['Read', 'Bash', 'WebSearch', 'WebFetch'],
      effort: 'high',
    })
    await $.tool.register(PROGRESS_SPEC)
    $.clock.every(1000, async () => {
      ticks += 1
      const list = await read($, runs)
      const open = await openRequest($)
      if (open !== undefined || list.some(run => run.status === 'running')) {
        const at = await $.clock.now()
        await update($, now, () => at)
      }
      // The budget is checked every second: cost arrives in large steps as responses finish.
      if ((await read($, plan)).budgetUsd) await tickBudget($)
      // Neither check may ever break the clock: a failure is skipped until the next round.
      if (ticks % MEMORY_EVERY === 0) await tickMemory($).catch(() => undefined)
      if (ticks % STALL_EVERY === 0) {
        await tickStalls($, beats, seenBeats, rerunQueue).catch(() => undefined)
      }
      // A peek at a running agent refreshes every five seconds.
      const peeked = await read($, peek)
      if (peeked && ticks % 5 === 0) {
        const run = list.find(one => one.id === peeked.runId)
        if (run?.status === 'running') {
          const fresh = await peekRun($, run)
          await update($, peek, () => fresh)
        }
      }
    })

    return next(e)
  })

  on('command.run', { command: 'fleet' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    const [head = '', word = ''] = arg.split(/\s+/)

    if (arg === 'on' || arg === 'off') {
      await savePlan($, current => ({ ...current, isEnabled: arg === 'on' }))
      return { text: `Agent fleet ${arg === 'on' ? 'enabled' : 'disabled'} everywhere.` }
    }
    if (head === 'use') {
      if (word !== 'on' && word !== 'off') return { text: 'Use /fleet use on | off' }
      return { text: await setProjectUse($, word === 'on') }
    }
    if (arg === 'clear') {
      await update($, runs, list => list.filter(run => run.status === 'running'))
      await update($, requests, items => items.filter(request => request.endedAt === null))
      await update($, peek, () => null)
      await refreshStatus($)
      return { text: 'Cleared finished agents and requests.' }
    }
    if (arg === 'stop') {
      const open = await openRequest($)
      const list = await read($, runs)
      if (open !== undefined) await stopRequest($, open)
      else for (const run of list.filter(one => one.status === 'running')) await stopRun($, run)
      return { text: 'Stopped the running fleet agents.' }
    }
    const leadKey: FleetLeadKey | null =
      head === 'research' ? 'researcher' : isLeadKey(head) ? head : null
    if (leadKey === 'reviewer' && ['auto', 'always', 'quick', 'full'].includes(word)) {
      if (word === 'auto' || word === 'always') {
        await savePlan($, current => ({ ...current, reviewWhen: word }))
      } else {
        await savePlan($, current => ({ ...current, reviewDepth: word as 'quick' | 'full' }))
      }
      const fleet = await read($, plan)
      return {
        text:
          (fleet.reviewWhen === 'auto'
            ? 'The reviewer runs only when two or more workers ran or a worker flagged something'
            : 'The reviewer runs on every request') +
          (fleet.reviewDepth === 'quick'
            ? ', and checks only the flagged points and contradictions, at medium effort.'
            : ', and checks every doubtful claim.') +
          (reviewerOf(fleet).isEnabled ? '' : ' It is off now: /fleet reviewer on.'),
      }
    }
    if (leadKey !== null) {
      const current = await read($, plan)
      const lead = leadOf(current, leadKey)
      let chosen: FleetLead | null = null
      if (word === 'on' || word === 'off') chosen = { ...lead, isEnabled: word === 'on' }
      else if (isModel(word)) chosen = { isEnabled: true, model: word }
      if (chosen === null)
        return { text: `Use /fleet ${leadKey} on | off | ${LEAD_MODELS.join(' | ')}` }
      const value = chosen
      await savePlan($, plan0 => ({ ...plan0, [leadKey]: value }))
      const name = LEAD_NAME[leadKey]
      return {
        text: value.isEnabled
          ? `${name} on, running on ${modelLabel(value.model)}.`
          : `${name} off.`,
      }
    }
    if (head === 'quick') {
      if (word !== 'on' && word !== 'off') return { text: 'Use /fleet quick on | off' }
      await savePlan($, current => ({ ...current, isQuickDirect: word === 'on' }))
      return {
        text:
          word === 'on'
            ? 'Small requests (a commit, a push, one command) are done directly, without the fleet. Start a message with "quick:" to force that for any request.'
            : 'Every request goes to the fleet, however small.',
      }
    }
    if (head === 'auto' || head === 'files') {
      if (word !== 'on' && word !== 'off') return { text: `Use /fleet ${head} on | off` }
      const key = head === 'auto' ? 'isAutoSize' : 'isFileHandoff'
      await savePlan($, current => ({ ...current, [key]: word === 'on' }))
      return {
        text:
          head === 'auto'
            ? word === 'on'
              ? 'Worker count is chosen per task, up to the number of slots.'
              : 'Every task uses all worker slots.'
            : word === 'on'
              ? 'Workers write their results to files in a run folder per request.'
              : 'Workers reply with their results directly.',
      }
    }
    if (head === 'budget') {
      if (word === 'off') {
        await savePlan($, current => ({ ...current, budgetUsd: null }))
        return { text: 'No budget per request.' }
      }
      if (word === 'warn' || word === 'stop') {
        await savePlan($, current => ({ ...current, budgetAction: word }))
        return {
          text:
            word === 'stop'
              ? 'At the budget the fleet stops the request.'
              : 'At the budget the fleet warns you.',
        }
      }
      const usd = Number(word.replace(/^\$/, ''))
      if (!Number.isFinite(usd) || usd <= 0)
        return { text: 'Use /fleet budget 5 (US dollars) | off | warn | stop' }
      await savePlan($, current => ({ ...current, budgetUsd: usd }))
      const action = (await read($, plan)).budgetAction ?? 'warn'
      return { text: `Budget ${usdText(usd)} per request; at the limit the fleet will ${action}.` }
    }
    if (head === 'memory') {
      if (word === 'off') {
        await savePlan($, current => ({ ...current, memMinFreeMb: null }))
        await update($, memory, () => null)
        return { text: 'Memory guard off: agents start whatever memory is available.' }
      }
      if (word === 'warn' || word === 'pause' || word === 'stop') {
        await savePlan($, current => ({ ...current, memAction: word }))
        return {
          text:
            word === 'warn'
              ? 'When memory runs low the fleet warns you; running agents carry on.'
              : word === 'pause'
                ? 'When memory runs low the fleet pauses running agents at their next tool call.'
                : 'When memory runs low the fleet stops the request and its agents.',
        }
      }
      if (word === 'on' || word === 'auto' || word === 'default') {
        await savePlan($, current => {
          const { memMinFreeMb: _dropped, ...rest } = current
          return rest
        })
      } else if (word !== '') {
        const mb = parseMemory(word)
        if (mb === null)
          return { text: 'Use /fleet memory 4g | 4096m | on | off | warn | pause | stop' }
        await savePlan($, current => ({ ...current, memMinFreeMb: mb }))
      }
      await update($, memory, () => null)
      const fleet = await read($, plan)
      if (fleet.memMinFreeMb === null)
        return { text: 'Memory guard off. /fleet memory on, or /fleet memory 4g.' }
      const mem = await readMemory($)
      if (mem === null) {
        return {
          text:
            'Memory guard is set, but available memory cannot be read on this system (macOS ' +
            'and Linux are supported), so it does nothing here.',
        }
      }
      const limit = memoryLimitMb(fleet, mem.totalMb) ?? 0
      return {
        text:
          `Memory: ${memText(mem.availMb)} available of ${memText(mem.totalMb)}. No agent starts ` +
          `below ${memText(limit)}${fleet.memMinFreeMb == null ? ' (a tenth of the memory installed)' : ''}; ` +
          `if it falls below that while agents run, the fleet will ${fleet.memAction ?? 'pause'}` +
          `${(fleet.memAction ?? 'pause') === 'warn' ? ' you' : ' them'}.`,
      }
    }
    if (head === 'stuck' || head === 'stall') {
      if (word === 'off') {
        await savePlan($, current => ({ ...current, stallMinutes: null }))
        return { text: 'The fleet no longer looks for stuck agents.' }
      }
      if (word === 'warn' || word === 'tell' || word === 'restart') {
        await savePlan($, current => ({ ...current, stallAction: word }))
      } else if (word === 'on') {
        await savePlan($, current => {
          const { stallMinutes: _dropped, ...rest } = current
          return rest
        })
      } else if (word !== '') {
        const minutes = Number(word.replace(/m(in)?$/, ''))
        if (!Number.isFinite(minutes) || minutes < 2 || minutes > 240) {
          return { text: 'Use /fleet stuck 15 (minutes, 2 to 240) | off | warn | tell | restart' }
        }
        await savePlan($, current => ({ ...current, stallMinutes: minutes }))
      }
      const fleet = await read($, plan)
      const minutes = stallMinutesOf(fleet)
      if (minutes === null)
        return { text: 'The fleet does not look for stuck agents. /fleet stuck 15 turns it on.' }
      const action = stallActionOf(fleet)
      return {
        text:
          `An agent with no activity for ${minutes} minutes counts as stuck; the fleet then ` +
          (action === 'warn'
            ? 'warns you and leaves it running.'
            : action === 'tell'
              ? 'warns you and asks Claude to check it, restart it or take over its work.'
              : 'stops it and starts its job again once; if it gets stuck again, Claude is asked to take over.'),
      }
    }
    if (head === 'worktrees') {
      if (word === 'on' || word === 'off') {
        return { text: await setWorktreesMode($, word === 'on') }
      }
      return { text: await worktreeReport($) }
    }
    if (arg === 'merge') return { text: await mergeWorktrees($) }
    if (arg === 'pause' || arg === 'resume') {
      const list = (await read($, runs)).filter(run =>
        arg === 'pause' ? run.status === 'running' : run.status === 'paused',
      )
      if (list.length === 0) {
        return {
          text: arg === 'pause' ? 'No fleet agent is running.' : 'No fleet agent is paused.',
        }
      }
      for (const run of list) {
        if (arg === 'pause') await pauseRun($, run)
        else await resumeRun($, run, rerunQueue)
      }
      return {
        text:
          arg === 'pause'
            ? `${list.length} agent(s) will pause at their next tool call.`
            : `Resumed ${list.length} agent(s).`,
      }
    }
    if (head === 'notify') {
      const modes = { on: 'all', off: 'off', sound: 'sound', banner: 'banner', all: 'all' } as const
      const mode = modes[word as keyof typeof modes]
      if (mode === undefined) return { text: 'Use /fleet notify on | off | sound | banner' }
      await savePlan($, current => ({ ...current, notify: mode }))
      return {
        text:
          mode === 'off'
            ? 'Finished requests are only noted in the transcript.'
            : `Requests of 30 seconds or longer announce themselves with ${mode === 'all' ? 'a sound and a banner' : `a ${mode}`}.`,
      }
    }
    if (head === 'history') {
      return {
        text: historyText(await read($, history), word === 'all' ? null : await projectRoot($)),
      }
    }
    if (head === 'detach') {
      const job = Number(word)
      if (!Number.isInteger(job) || job < 1) return { text: 'Use /fleet detach N (the job number)' }
      return { text: await detachWorktree($, job) }
    }
    if (head === 'theme') {
      if (!THEME_KEYS.includes(word)) return { text: `Use /fleet theme ${THEME_KEYS.join(' | ')}` }
      await savePlan($, current => ({ ...current, theme: word }))
      return { text: `Fleet pane colours: ${word}.` }
    }
    if (arg === 'help') {
      return { text: [`Agent fleet ${VERSION} ${COPYRIGHT} — commands:`, ...HELP_LINES].join('\n') }
    }
    if (head === 'messages') {
      if (word !== 'full' && word !== 'compact' && word !== 'quiet') {
        return { text: 'Use /fleet messages full | compact | quiet' }
      }
      await savePlan($, current => ({ ...current, messages: word }))
      return {
        text:
          word === 'full'
            ? 'Agent messages are shown in full.'
            : word === 'compact'
              ? 'Agent messages are folded to one line each; press ctrl+o to read one in full.'
              : 'Agent messages are folded, and Claude keeps its own progress updates to one line.',
      }
    }
    if (arg !== '') {
      const parsed = parsePlan(arg, await read($, plan))
      if (typeof parsed === 'string') return { text: `${parsed}. /fleet help lists every command.` }
      await savePlan($, () => parsed)
      return { text: `Agent fleet: ${parsed.models.map((m, i) => `${i + 1}=${m}`).join(', ')}.` }
    }

    await $.ui.open({ id: PANE, title: 'Agent fleet', focus: true })
    return { text: 'Agent fleet pane opened. Type /fleet help for every command.' }
  })

  on('prompt.submit', async ($, e, next) => {
    // Only the person's own messages start a new request; agent hand-backs do not.
    if (e.origin.kind !== 'composer') return next(e)
    if (!(await isFleetActive($)) || e.text.trimStart().startsWith('/')) return next(e)
    const fleet = await read($, plan)
    // A commit, a push, one command: Claude does it directly. No request is opened, so no
    // planner, no band and no run folder; the note beside the prompt says the plan is off for it.
    if (isQuickDirectOn(fleet) && isQuickPrompt(e.text)) {
      return next({ ...e, context: [...(e.context ?? []), QUICK_NOTE] })
    }

    slotCursor = 0
    const at = await $.clock.now()
    const title = titleOf(e.text)
    const id = `r${at}`
    let runDir: string | null = null
    if (isFileHandoffOn(fleet)) {
      const home = await homeDir($)
      const project = slugOf((await projectRoot($)).split('/').pop() ?? 'project')
      const stamp = new Date(at).toISOString().slice(0, 16).replace(/[:T]/g, '-')
      runDir = `${home}/.claude/fleet-runs/${project}/${stamp}-${slugOf(title)}`
      await $.fs.write(`${runDir}/request.md`, `# ${title}\n\n${e.text}\n`)
    }
    const usd = (await $.session.usage()).cost?.usd ?? null
    // A security review needs to know where the project stood before the agents changed it.
    let headAtStart: string | null = null
    if (securityOf(fleet).isEnabled) {
      const repo = await $.session.repo().catch(() => null)
      if (repo) {
        const head = await git($, ['rev-parse', 'HEAD'], repo.root).catch(() => null)
        if (head !== null && head.exitCode === 0) headAtStart = head.stdout.trim() || null
      }
    }
    const request: FleetRequest = {
      id,
      title,
      startedAt: at,
      endedAt: null,
      expectedWorkers: fleet.isAutoSize ? null : fleet.models.length,
      outcome: 'open',
      runDir,
      costAtStart: usd,
      cost: 0,
      budgetLevel: 0,
      jobs: [],
      baseCommit: null,
      baseBranch: null,
      headAtStart,
      researchPath: null,
    }
    // A request still open from before is closed as it stood: the person moved on.
    await update($, requests, items =>
      [
        ...items.map(one =>
          one.endedAt === null ? { ...one, endedAt: at, outcome: 'done' as const } : one,
        ),
        request,
      ].slice(-KEPT_REQUESTS),
    )
    await update($, isBandHidden, () => false)

    return next({ ...e, context: [...(e.context ?? []), promptReminder(fleet, runDir)] })
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if (!(await isFleetActive($))) return composed
    const fleet = await read($, plan)
    const quiet =
      fleet.messages === 'quiet'
        ? [{ id: 'agent-fleet:quiet', text: QUIET_SECTION, scope: 'session' as const }]
        : []

    return {
      sections: [
        ...composed.sections,
        { id: 'agent-fleet:plan', text: planText(fleet), scope: 'session' as const },
        ...quiet,
      ],
    }
  })

  on('agent.spawn', async ($, e, next) => {
    const fleet = await read($, plan)
    const active = await isFleetActive($)
    // Once the latest request has spent its budget under "stop", nothing new starts until the
    // person sends another message: not a worker, a planner, a reviewer or a nested agent.
    if (fleet.budgetUsd && fleet.budgetAction === 'stop') {
      await tickBudget($)
      const latest = (await read($, requests)).at(-1)
      if (latest && (latest.budgetLevel ?? 0) >= 2) {
        return {
          deny:
            `The agent fleet budget of ${usdText(fleet.budgetUsd)} for this request is spent ` +
            `(${usdText(latest.cost ?? 0)} used), so no further agents start. Stop here and tell ` +
            'the user; they can raise it with /fleet budget, or send a new message.',
        }
      }
    }
    const isMain = e.parentAgentId === undefined && !e.workflow && !e.isTeammate
    // No fleet agent starts while the laptop is short of memory.
    if (active && isMain) {
      const short = await memoryRefusal($, fleet).catch(() => null)
      if (short !== null) return { deny: short }
    }
    const rerunOf = rerunQueue.get(e.description)
    if (rerunOf) rerunQueue.delete(e.description)
    const role: FleetRole = rerunOf
      ? (rerunOf.role ?? 'worker')
      : (leadOfType(e.subagentType) ?? (active && isMain ? 'worker' : 'other'))
    const open = isMain ? await openRequest($) : undefined
    const requestId = rerunOf?.requestId ?? open?.id ?? null
    const request = requestId
      ? (await read($, requests)).find(one => one.id === requestId)
      : undefined
    const list = await read($, runs)
    let slot: number | null = rerunOf?.slot ?? null
    let job: number | null = rerunOf?.job ?? null
    let input = e
    let outputPath: string | null = rerunOf?.outputPath ?? null
    let worktreeId: string | null = rerunOf?.worktreeId ?? null

    if (rerunOf) {
      // A rerun is launched with its brief and the fleet's notes already in place.
    } else if (role === 'planner') {
      // The planner takes no worker slot: it runs on its own model and is told the slots.
      const planner = plannerOf(fleet)
      const howMany = fleet.isAutoSize
        ? `You choose how many jobs to write: between 1 and ${fleet.models.length}, as many as ` +
          'the task really divides into. Job N goes to Agent N.'
        : `Write exactly ${fleet.models.length} jobs. Job N goes to Agent N.`
      input = {
        ...e,
        prompt:
          `${e.prompt}\n\nWorker slots (${fleet.models.length}):\n${slotLines(fleet).join('\n')}\n${howMany}` +
          (request?.researchPath
            ? `\n\nMarket research for this request is in ${request.researchPath}. Read it before ` +
              'you plan: build on what it recommends, cover the expected minimum it lists, and ' +
              'aim at the gaps it found. Name that file in the brief of every job that needs it.'
            : ''),
      }
      if (planner.model !== 'inherit') input = { ...input, model: planner.model }
    } else if (role === 'researcher') {
      const researcher = researcherOf(fleet)
      if (request?.runDir) outputPath = `${request.runDir}/research.md`
      input = { ...e, prompt: e.prompt + PROGRESS_NOTE }
      if (researcher.model !== 'inherit') input = { ...input, model: researcher.model }
    } else if (role === 'security') {
      const security = securityOf(fleet)
      if (request?.runDir) outputPath = `${request.runDir}/security-review.md`
      const branches = (await read($, worktrees)).filter(
        one => one.requestId === request?.id && UNMERGED.includes(one.status),
      )
      const note =
        (request?.runDir
          ? `\n\nThe run folder ${request.runDir} holds the plan (plan.md), each worker's summary ` +
            'of what it changed (job-N.md) and the combined result; they say where to look, but ' +
            'review the code itself.'
          : '') +
        (request?.headAtStart
          ? `\nThe project was at commit ${request.headAtStart} when this request started: ` +
            `"git status" and "git diff ${request.headAtStart}" show what changed since.`
          : '') +
        (branches.length > 0
          ? '\nThe changes are on these worktree branches, not yet merged:\n' +
            branches
              .map(
                one =>
                  `- ${one.label}: branch ${one.branch} in ${one.path} ("git diff ${one.baseCommit}..${one.branch}")`,
              )
              .join('\n')
          : '') +
        PROGRESS_NOTE
      input = { ...e, prompt: e.prompt + note }
      if (security.model !== 'inherit') input = { ...input, model: security.model }
    } else if (role === 'reviewer') {
      const reviewer = reviewerOf(fleet)
      if (fleet.reviewWhen === 'auto' && request) {
        const workers = list.filter(
          run =>
            run.requestId === request.id &&
            run.role === 'worker' &&
            run.status === 'done' &&
            !isReplaced(run, list),
        )
        const notDue = reviewNotDue(workers)
        if (notDue !== null) return { deny: notDue }
      }
      const files = request?.runDir
        ? `\n\nThe run folder ${request.runDir} holds the plan (plan.md), each worker's result ` +
          '(job-N.md) and the combined result (combined.md) when it is long; read them there.'
        : ''
      input = {
        ...e,
        prompt: e.prompt + files + (fleet.reviewDepth === 'quick' ? QUICK_REVIEW_NOTE : ''),
      }
      if (reviewer.model !== 'inherit') input = { ...input, model: reviewer.model }
    } else if (role === 'designer' && !rerunOf) {
      const designer = designerOf(fleet)
      const kind = request?.deliverable ?? 'unknown'
      const home = await homeDir($)
      const folder = request?.runDir
        ? `${request.runDir}/design`
        : `${home}/.claude/fleet-runs/design-${slugOf(e.description || 'result')}`
      outputPath = `${folder}/CHANGES.md`
      let note =
        `\n\nYour folder: ${folder} — write everything you produce there.` +
        (request?.runDir
          ? ` The run folder ${request.runDir} holds the plan, the workers' results and the combined result.`
          : '') +
        `\nDeliverable type named by the planner: ${kind}.`
      let cwd: string | undefined
      if (isWorktreesOn(fleet) && request && (kind === 'website' || kind === 'code')) {
        const made = await createWorktree($, request, 0, 'designer', 'design')
        if (typeof made === 'string') {
          return { deny: `Agent fleet could not create a worktree for the designer: ${made}.` }
        }
        worktreeId = made.id
        cwd = made.path
        note += worktreeNote(made.path, made.branch, made.repoRoot)
      }
      input = { ...e, prompt: e.prompt + note, ...(cwd ? { cwd } : {}) }
      if (designer.model !== 'inherit') input = { ...input, model: designer.model }
    } else if (role === 'worker' && !rerunOf) {
      // A stuck agent that was stopped holds neither its job nor its slot: it may be relaunched.
      const mine = list.filter(
        run =>
          run.requestId === requestId &&
          run.role === 'worker' &&
          !isReplaced(run, list) &&
          !isAbandoned(run),
      )
      job = jobOfPrompt(e.prompt)
      const jobs = request?.jobs ?? []
      if (job !== null && mine.some(run => run.job === job && run.status !== 'failed')) {
        return { deny: `Job ${job} has already been launched for this request.` }
      }
      // A job waits for the jobs its heading names: it runs in a later wave.
      const planned = job !== null ? jobs.find(one => one.n === job) : undefined
      if (planned && planned.after.length > 0) {
        const waiting = planned.after.filter(
          dep => !mine.some(run => run.job === dep && run.status === 'done'),
        )
        if (waiting.length > 0) {
          return {
            deny:
              `Job ${job} runs after job ${waiting.join(', ')}. Launch it once ` +
              `${waiting.length > 1 ? 'they have' : 'that job has'} returned.`,
          }
        }
      }
      const pending = (reserved.get(requestId ?? '') ?? new Set<number>()).size
      if (Math.max(mine.length, pending) >= fleet.models.length) {
        return {
          deny:
            `The agent fleet allows ${fleet.models.length} workers per request and all are in ` +
            'use. Finish with the agents already running, or the user can change it with /fleet.',
        }
      }
      const held = reserved.get(requestId ?? '') ?? new Set<number>()
      const taken = new Set<number | null>([...mine.map(run => run.slot), ...held])
      slot =
        job !== null && job <= fleet.models.length && !taken.has(job - 1)
          ? job - 1
          : (Array.from({ length: fleet.models.length }, (_, i) => i).find(i => !taken.has(i)) ??
            slotCursor)
      slotCursor = Math.max(slotCursor, slot + 1)
      held.add(slot)
      reserved.set(requestId ?? '', held)
      const model = fleet.models[slot]
      let prompt = e.prompt + PROGRESS_NOTE
      const label = job !== null ? `job ${job}` : `agent ${slot + 1}`
      if (request?.runDir && isFileHandoffOn(fleet)) {
        outputPath = `${request.runDir}/${job !== null ? `job-${job}` : `agent-${slot + 1}`}.md`
        const inputs = (planned?.after ?? []).flatMap(dep => {
          const source = mine.find(run => run.job === dep)
          const title = jobs.find(one => one.n === dep)?.title ?? ''
          return source?.outputPath
            ? [{ path: source.outputPath, label: `Job ${dep}: ${title}` }]
            : []
        })
        prompt += fileNote(outputPath, inputs)
      }
      let cwd: string | undefined
      if (isWorktreesOn(fleet) && request) {
        const made = await createWorktree($, request, job ?? slot + 1, label)
        if (typeof made === 'string') {
          reserved.get(requestId ?? '')?.delete(slot)
          return {
            deny:
              `Agent fleet could not create a worktree for ${label}: ${made}. Fix the repository ` +
              'or turn worktrees off with /fleet worktrees off.',
          }
        }
        worktreeId = made.id
        cwd = made.path
        prompt += worktreeNote(made.path, made.branch, made.repoRoot)
      }
      input = { ...e, prompt, ...(cwd ? { cwd } : {}) }
      if (model !== undefined && model !== 'inherit' && !e.fork) input = { ...input, model }
    }

    let started: Awaited<ReturnType<typeof next>>
    try {
      started = await next(input)
    } catch (error) {
      if (slot !== null && role === 'worker' && !rerunOf)
        reserved.get(requestId ?? '')?.delete(slot)
      throw error
    }
    if (started.deny === undefined && started.agentId !== undefined) {
      const startedAt0 = await $.clock.now()
      const run: FleetRun = {
        id: started.agentId,
        description:
          role === 'planner'
            ? `Planner: ${e.description || 'plan'}`
            : role === 'reviewer'
              ? `Reviewer: ${e.description || 'review'}`
              : role === 'designer'
                ? `Designer: ${e.description || 'design'}`
                : role === 'researcher'
                  ? `Researcher: ${e.description || 'research'}`
                  : role === 'security'
                    ? `Security: ${e.description || 'security review'}`
                    : e.description || e.subagentType,
        type: e.subagentType,
        model: started.model,
        slot,
        status: 'running',
        startedAt: startedAt0,
        lastActivityAt: startedAt0,
        busyTool: null,
        stalledAt: null,
        stallRestarts: (rerunOf?.stallRestarts ?? 0) + (rerunOf?.stalledAt != null ? 1 : 0),
        endedAt: null,
        tools: 0,
        lastTool: null,
        tokens: null,
        steps: NO_STEPS,
        role,
        requestId,
        progress: null,
        task: taskOf(rerunOf?.prompt ?? e.prompt),
        prompt: rerunOf?.prompt ?? e.prompt,
        // What the fleet appended to the brief: a rerun gets it again.
        notes:
          rerunOf?.notes ??
          (input.prompt.startsWith(e.prompt) ? input.prompt.slice(e.prompt.length) : ''),
        job,
        outputPath,
        worktreeId,
        rerunOf: rerunOf?.id ?? null,
      }
      await update($, runs, items => [...items, run].slice(-KEPT_RUNS))
      if (requestId && rerunOf === undefined && role === 'worker') {
        await setRequest($, requestId, one => one)
      }
      await refreshStatus($)
    } else if (worktreeId && !rerunOf) {
      // The spawn was refused after its worktree was made: the empty worktree goes again.
      const wt = (await read($, worktrees)).find(one => one.id === worktreeId)
      if (wt) await finishWorktree($, wt)
    }

    // The run is in the state now (or was refused): its slot no longer needs holding.
    if (slot !== null && role === 'worker' && !rerunOf) reserved.get(requestId ?? '')?.delete(slot)
    return started
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: /^mcp__agent-fleet__progress$/ }, async ($, e) => {
    const agentId = e.agentId
    const progress = progressFrom(e as Record<string, unknown>)
    if (agentId === undefined) return { result: 'Only fleet subagents report progress.' }
    if (progress === null) return { result: 'Give done and total as whole numbers, total ≥ 1.' }
    const at = await $.clock.now()
    await update($, runs, list =>
      list.map(run =>
        run.id === agentId ? { ...run, progress, lastActivityAt: at, stalledAt: null } : run,
      ),
    )
    return { result: 'Progress recorded.' }
  })

  on('tool.call', async ($, e, next) => {
    const agentId = e.agentId
    const tool = String(e.tool)
    if (agentId === undefined || tool === PROGRESS_TOOL) return next(e)
    const list = await read($, runs)
    const run = list.find(one => one.id === agentId)
    if (run?.pauseRequested && run.status === 'running') {
      // The safe point: between steps, before this call runs. Stop the agent here.
      await update($, runs, items =>
        items.map(one =>
          one.id === agentId ? { ...one, status: 'paused' as const, pauseRequested: false } : one,
        ),
      )
      await $.tool
        .call({
          tool: 'TaskStop',
          task_id: run.id,
          consent: `The user paused the fleet agent "${run.description}".`,
        })
        .catch(() => undefined)
      // A memory pause was announced to Claude once for all agents; a person's pause, here.
      if (run.pauseReason !== 'memory') {
        await tellMain(
          $,
          `The user paused "${run.description}". Do not relaunch it and do not finish the request ` +
            'without it: the user will resume it.',
        )
      }
      await refreshStatus($)
      return {
        deny:
          run.pauseReason === 'memory'
            ? "Paused by the agent fleet: the laptop's memory is low. Stop here; you will be told when to resume."
            : 'Paused by the user. Stop here; you will be told when to resume.',
      }
    }
    if (run?.role === 'designer') {
      const refused = designerGuard(tool)
      if (refused !== null) return { deny: refused }
    }
    if (run?.worktreeId) {
      const wt = (await read($, worktrees)).find(one => one.id === run.worktreeId)
      const request = (await read($, requests)).find(one => one.id === run.requestId)
      if (wt) {
        const refused = worktreeGuard(
          tool,
          e as Record<string, unknown>,
          wt.path,
          wt.repoRoot,
          request?.runDir ?? null,
        )
        if (refused !== null) return { deny: refused }
      }
    }
    if (run) {
      const at = await $.clock.now()
      await update($, runs, items =>
        items.map(one =>
          one.id === agentId
            ? {
                ...one,
                tools: one.tools + 1,
                lastTool: tool,
                // Inside this call until the model's next response arrives (see tickStalls).
                busyTool: tool,
                lastActivityAt: at,
                stalledAt: one.status === 'running' ? null : one.stalledAt,
                steps: stepsAfter(one.steps ?? NO_STEPS, tool, e as Record<string, unknown>),
              }
            : one,
        ),
      )
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // Every piece of a subagent's model response counts as a sign of life. Nothing is changed:
  // each chunk is passed on as it came.
  on('turn.step', async function* ($, e, next) {
    const agentId = e.agentId
    if (agentId === undefined) return yield* next(e)
    // A quick review thinks less: the reviewer's own setting is high effort.
    const isQuickReview =
      (await read($, plan)).reviewDepth === 'quick' &&
      (await read($, runs)).some(run => run.id === agentId && run.role === 'reviewer')
    const stream = next(isQuickReview ? { ...e, effort: 'medium' } : e)
    beats.set(agentId, (beats.get(agentId) ?? 0) + 1)
    for await (const chunk of stream) {
      beats.set(agentId, (beats.get(agentId) ?? 0) + 1)
      yield chunk
    }
    return await stream.result
  })

  on('turn.complete', async ($, e, next) => {
    const agentId = e.agentId
    const at = await $.clock.now()

    if (agentId !== undefined) {
      const status: FleetStatus =
        e.reason === 'answer' ? 'done' : e.reason === 'aborted' ? 'stopped' : 'failed'
      // Every token the run used: fresh input, output, and prompt cache reads and writes.
      const tokens = e.usage
        ? e.usage.input_tokens +
          e.usage.output_tokens +
          e.usage.cache_read_input_tokens +
          e.usage.cache_creation_input_tokens
        : null
      const run = (await read($, runs)).find(one => one.id === agentId)
      await update($, runs, items =>
        items.map(one =>
          one.id === agentId
            ? {
                ...one,
                status: one.status === 'stopped' || one.status === 'paused' ? one.status : status,
                endedAt: one.status === 'paused' ? null : at,
                busyTool: null,
                hasOpenPoints:
                  one.role === 'worker' && status === 'done'
                    ? hasOpenPoints(e.answer)
                    : one.hasOpenPoints,
                tokens: tokens === null ? one.tokens : (one.tokens ?? 0) + tokens,
              }
            : one,
        ),
      )
      if (run?.role === 'planner' && run.requestId && status === 'done') {
        // The plan is kept in the run folder, and its jobs and waves steer the workers.
        const jobs = jobsOf(e.answer)
        const request = (await read($, requests)).find(one => one.id === run.requestId)
        if (request?.runDir) await $.fs.write(`${request.runDir}/plan.md`, e.answer)
        const deliverable = deliverableOf(e.answer)
        if (deliverable) await setRequest($, run.requestId, one => ({ ...one, deliverable }))
        if (jobs.length > 0) {
          const isAuto = (await read($, plan)).isAutoSize === true
          await setRequest($, run.requestId, one => ({
            ...one,
            jobs,
            expectedWorkers: isAuto ? jobs.length : one.expectedWorkers,
          }))
        }
      }
      if ((run?.role === 'researcher' || run?.role === 'security') && status === 'done') {
        // The findings are kept in the run folder: the planner reads the research from there.
        if (run.outputPath) await $.fs.write(run.outputPath, e.answer)
        if (run.role === 'researcher' && run.requestId && run.outputPath) {
          const researchPath = run.outputPath
          await setRequest($, run.requestId, one => ({ ...one, researchPath }))
        }
      }
      // A worktree that a restart of this agent is about to use, or already uses, is left alone.
      const isHandedOn =
        run !== undefined &&
        ([...rerunQueue.values()].some(queued => queued.id === run.id) ||
          (await read($, runs)).some(one => one.rerunOf === run.id && one.status === 'running'))
      if (run?.worktreeId && run.status !== 'paused' && !isHandedOn) {
        const wt = (await read($, worktrees)).find(one => one.id === run.worktreeId)
        if (wt && wt.status === 'active') await finishWorktree($, wt)
      }
      if (run?.rerunOf && status === 'done') {
        // A rerun the person started has no caller waiting; its answer goes to the conversation.
        await $.prompt.submit({
          text:
            ((run.stallRestarts ?? 0) > 0
              ? `[Agent fleet] "${run.description}" replaces an agent that got stuck and was restarted by the fleet. Its result`
              : `[Agent fleet] The user reran "${run.description}". Its new result`) +
            (run.outputPath ? ` is in ${run.outputPath}; its reply:` : ':') +
            `\n\n${e.answer}`,
        })
      }
      await refreshStatus($)
      return next(e)
    }

    // The main loop's turn ended: the request is over once none of its agents still runs.
    const open = await openRequest($)
    if (open !== undefined) {
      const list = await read($, runs)
      const mine = list.filter(run => run.requestId === open.id)
      if (mine.length === 0 && e.reason === 'answer') {
        // Claude answered without the fleet (a small request, a question): the request leaves
        // no trace, so nothing is announced and the history holds only real runs.
        await update($, requests, items => items.filter(one => one.id !== open.id))
      } else if (!mine.some(run => run.status === 'running' || run.status === 'paused')) {
        await setRequest($, open.id, one => ({
          ...one,
          endedAt: at,
          outcome: e.reason === 'aborted' ? 'stopped' : 'done',
        }))
        await finishRequest($, open.id)
        const workers = mine.filter(run => run.role === 'worker' && !run.rerunOf)
        const fleet = await read($, plan)
        const jobs = open.jobs ?? []
        const missing = jobs
          .filter(job => !workers.some(run => run.job === job.n))
          .map(job => job.n)
        const expected = open.expectedWorkers ?? fleet.models.length
        if (e.reason === 'answer' && missing.length > 0 && workers.length > 0) {
          $.ui.toast(`Agent fleet: job ${missing.join(', ')} of the plan was never launched`)
        } else if (e.reason === 'answer' && workers.length > 0 && workers.length < expected) {
          $.ui.toast(
            `Agent fleet: Claude launched ${workers.length} of ${expected} planned workers`,
          )
        }
        if (open.runDir) {
          await $.fs.write(
            `${open.runDir}/summary.md`,
            [
              `# ${open.title}`,
              '',
              `Outcome: ${e.reason === 'aborted' ? 'stopped' : 'done'} · ${elapsedText(open.startedAt, at)}` +
                (open.cost ? ` · ${usdText(open.cost)}` : ''),
              '',
              '| Agent | Model | Status | Time | Tokens | Result |',
              '|---|---|---|---|---|---|',
              ...mine.map(
                run =>
                  `| ${roleLabel(run)}: ${run.description} | ${shortModel(run.model)} | ${run.status} | ` +
                  `${elapsedText(run.startedAt, run.endedAt ?? at)} | ${run.tokens ? tokensText(run.tokens) : ''} | ` +
                  `${run.outputPath ?? ''} |`,
              ),
            ].join('\n') + '\n',
          )
        }
      }
    }
    return next(e)
  })

  // Agents' completion notices and reports, folded to one line each when the person asks;
  // ctrl+o shows the full row, and what Claude reads is never changed.
  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    const mode = (await read($, plan)).messages ?? 'full'
    const kind = e.props.origin.kind
    if (mode === 'full' || e.props.isExpanded || !AGENT_ORIGINS.includes(kind)) return next(e)
    const { Text } = $.ui.resolve(e)
    const width = Math.max(40, e.viewport?.columns ?? 100)
    return (
      <Text dimColor wrap="truncate-end">
        {compactLine(e.props.text, kind, e.props.from?.name, e.props.task, width)}
      </Text>
    )
  })

  // The status band above the prompt: one request's overall progress.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || (await read($, isBandHidden))) return next(e)
    const items = await read($, requests)
    const request = items[items.length - 1]
    if (request === undefined) return next(e)
    const at = Math.max(await read($, now), request.endedAt ?? request.startedAt)
    if (request.endedAt !== null && at - request.endedAt > BAND_LINGER_MS) return next(e)

    const { Box, Text, Button } = $.ui.resolve(e)
    const list = await read($, runs)
    const fleet = await read($, plan)
    const mine = list.filter(run => run.requestId === request.id && !isReplaced(run, list))
    const phase = phaseOf(request, list)
    const percent = requestPercent(request, list, fleet)
    const workers = mine.filter(run => run.role === 'worker' || run.role === 'other')
    const expected = Math.max(workers.length, request.expectedWorkers ?? fleet.models.length)
    const workersDone = workers.filter(run => run.status !== 'running').length
    const tokens = mine.reduce((sum, run) => sum + (run.tokens ?? 0), 0)
    const waves = wavesOf(request.jobs ?? [])
    const lastWave = Math.max(0, ...waves.values())
    const runningWave = Math.max(
      0,
      ...workers
        .filter(run => run.status === 'running' && run.job != null)
        .map(run => waves.get(run.job!) ?? 0),
    )
    const width = Math.max(40, e.props.bodyColumns)
    const barWidth = Math.max(10, Math.min(30, width - 50))
    const color = phase === 'done' ? 'success' : phase === 'stopped' ? 'warning' : 'claude'
    const budget = fleet.budgetUsd ? ` of ${usdText(fleet.budgetUsd)}` : ''
    const phaseText =
      phase === 'stopped' && (request.budgetLevel ?? 0) >= 2
        ? 'Stopped at budget'
        : PHASE_LABEL[phase]
    const mem = await read($, memory)
    const stuck = mine.filter(run => run.status === 'running' && run.stalledAt != null).length
    const pendingWorktrees = (await read($, worktrees)).filter(
      one => one.requestId === request.id && (one.status === 'ready' || one.status === 'conflict'),
    ).length
    const facts = [
      phaseText,
      `workers ${workersDone}/${expected || '?'}`,
      ...(lastWave > 1 ? [`wave ${runningWave || '–'}/${lastWave}`] : []),
      elapsedText(request.startedAt, request.endedAt ?? at),
      ...(tokens > 0 ? [tokensText(tokens)] : []),
      ...(request.cost ? [`${usdText(request.cost)}${budget}`] : []),
      ...(pendingWorktrees ? [`${pendingWorktrees} worktree(s) to merge`] : []),
      ...(stuck ? [`${stuck} stuck?`] : []),
      ...(mem?.isLow && request.endedAt === null
        ? [`LOW MEMORY ${memText(mem.availMb)} free`]
        : []),
    ].join(' · ')

    return (
      <Box flexDirection="column">
        <Box>
          <Text bold>Fleet </Text>
          <Text>{fit(request.title, Math.max(12, width - barWidth - 30))} </Text>
          <Text color={color}>
            {bar(percent, barWidth)} {String(percent).padStart(3)}%
          </Text>
        </Box>
        <Box>
          <Text
            color={
              (request.budgetLevel ?? 0) >= 2 || (mem?.isLow && request.endedAt === null)
                ? 'error'
                : stuck
                  ? 'warning'
                  : color
            }
          >
            {facts}{' '}
          </Text>
          {phase !== 'done' && phase !== 'stopped' && (
            <Button key="band-stop" label="Stop all" onPress={() => stopRequest($, request)} />
          )}
          <Button
            key="band-hide"
            label="Hide"
            onPress={() => update($, isBandHidden, () => true)}
          />
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const Input = 'Input' in ui ? ui.Input : null
    const fleet = await read($, plan)
    const list = await read($, runs)
    const items = await read($, requests)
    const at = Math.max(await read($, now), ...list.map(run => run.endedAt ?? run.startedAt))
    const width = Math.max(30, e.props.bodyColumns)
    const rows = Math.max(10, e.props.scroll?.bodyRows ?? e.viewport?.rows ?? 30)
    const theme = themeOf(fleet)
    const showHelp = await read($, isHelpOpen)
    const showHistory = await read($, isHistoryOpen)
    const projectOff = await read($, isProjectOff)
    const peeked = await read($, peek)
    const root = await projectRoot($)
    const pastHere = showHistory
      ? (await read($, history))
          .filter(one => one.project === root)
          .slice(-8)
          .reverse()
      : []
    const ledger = (await read($, worktrees)).filter(one => one.repoRoot === root)
    const unmerged = ledger.filter(one => UNMERGED.includes(one.status))
    const ink = theme.text
    const planner = plannerOf(fleet)
    const reviewer = reviewerOf(fleet)
    const designer = designerOf(fleet)
    const researcher = researcherOf(fleet)
    const security = securityOf(fleet)
    const mem = await read($, memory)
    const memLimit = mem ? memoryLimitMb(fleet, mem.totalMb) : null
    const stallMinutes = stallMinutesOf(fleet)

    const resize = (delta: number) =>
      savePlan($, current => {
        const count = Math.min(MAX_AGENTS, Math.max(1, current.models.length + delta))
        const models = Array.from({ length: count }, (_, i) => current.models[i] ?? 'inherit')
        return { ...current, models }
      })
    const toggleLead = (key: FleetLeadKey) =>
      savePlan($, current => {
        const lead = leadOf(current, key)
        return { ...current, [key]: { ...lead, isEnabled: !lead.isEnabled } }
      })
    const cycleLead = (key: FleetLeadKey) =>
      savePlan($, current => {
        const lead = leadOf(current, key)
        return { ...current, [key]: { ...lead, model: nextLeadModel(lead.model) } }
      })
    const cycleTheme = () =>
      savePlan($, current => {
        const index = THEME_KEYS.indexOf(current.theme ?? DEFAULT_THEME)
        return { ...current, theme: THEME_KEYS[(index + 1) % THEME_KEYS.length] ?? 'default' }
      })
    const toggleProject = async () => {
      $.ui.toast(await setProjectUse($, projectOff))
    }
    const openPeek = async (run: FleetRun) => {
      if (peeked?.runId === run.id) {
        await update($, peek, () => null)
        return
      }
      const fresh = await peekRun($, run)
      await update($, peek, () => fresh)
    }

    // Rows are laid out to the pane's width, so nothing wraps: what does not fit on the first
    // line moves to the lines under it, and every line is cut at the edge rather than wrapped.
    const inner = Math.max(30, width - 6)
    const descWidth = Math.max(8, inner - 38)
    const runRow = (run: FleetRun) => {
      const percent = percentOf(run)
      const replaced = isReplaced(run, list)
      const detail =
        run.status === 'paused'
          ? run.pauseReason === 'memory'
            ? 'paused: memory is low — free memory, then resume'
            : 'paused — press resume to continue'
          : run.status === 'running'
            ? (run.stalledAt != null
                ? `STUCK? silent ${elapsedText(run.lastActivityAt ?? run.startedAt, at)} · `
                : '') +
              (run.pauseRequested ? 'pausing at the next tool call · ' : '') +
              (run.progress?.step || run.lastTool || 'starting')
            : replaced
              ? 'replaced by rerun'
              : run.tokens === null
                ? run.status
                : tokensText(run.tokens)
      return (
        <Box flexDirection="column">
          <Box>
            <Text color={STATUS_COLOR[run.status]} dimColor={replaced}>
              {'  '}
              {GLYPH[run.status]}{' '}
            </Text>
            <Text
              color={ROLE_COLOR[run.role ?? 'worker'] ?? STATUS_COLOR[run.status]}
              dimColor={replaced}
              bold={run.role !== undefined && run.role in ROLE_COLOR}
            >
              {fit(roleLabel(run), 8)} {fit(run.description, descWidth)}{' '}
            </Text>
            <Text color={STATUS_COLOR[run.status]} dimColor={replaced} wrap="truncate-end">
              {fit(shortModel(run.model), 10)} {fit(percent === null ? '—' : `${percent}%`, 4)}{' '}
              {fit(elapsedText(run.startedAt, run.endedAt ?? at), 6)}
            </Text>
          </Box>
          <Box columnGap={1}>
            <Text
              color={
                run.stalledAt != null && run.status === 'running'
                  ? 'warning'
                  : STATUS_COLOR[run.status]
              }
              dimColor={!(run.stalledAt != null && run.status === 'running')}
              wrap="truncate-end"
            >
              {`${NB.repeat(5)}${fit(`${detail} · ${run.tools} tools`, Math.max(10, inner - 30))}`}
            </Text>
            <Button
              key={`peek-${run.id}`}
              dimColor
              plain
              label={peeked?.runId === run.id ? 'close' : 'peek'}
              onPress={() => openPeek(run)}
            />
            {run.status === 'running' || run.status === 'paused' ? (
              <Button
                key={`pause-${run.id}`}
                dimColor
                plain
                label={
                  run.status === 'paused' ? 'resume' : run.pauseRequested ? 'pausing' : 'pause'
                }
                onPress={() =>
                  run.status === 'paused' ? resumeRun($, run, rerunQueue) : pauseRun($, run)
                }
              />
            ) : null}
            {run.status === 'running' || run.status === 'paused' ? (
              <Button
                key={`stop-${run.id}`}
                dimColor
                plain
                label="stop"
                onPress={() => stopRun($, run)}
              />
            ) : null}
          </Box>
          {run.task ? (
            <Text color={ink} wrap="truncate-end">
              {'      ↳ '}
              {run.task}
            </Text>
          ) : null}
        </Box>
      )
    }

    const peekRunRecord = peeked ? list.find(run => run.id === peeked.runId) : undefined
    const peekPanel = peeked && peekRunRecord && (
      <Box flexDirection="column" borderStyle="round" borderColor="claude" paddingX={1}>
        <Text color={ink} bold>
          Peek · {roleLabel(peekRunRecord)}: {peekRunRecord.description}
        </Text>
        {peeked.tool ? <Text color={ink}>Last tool: {peeked.tool}</Text> : null}
        {peekRunRecord.outputPath ? (
          <Text color={ink}>Result file: {peekRunRecord.outputPath}</Text>
        ) : null}
        <Text color={ink} wrap="wrap">
          {peeked.text}
        </Text>
        {peekRunRecord.status !== 'running' && peekRunRecord.prompt && Input !== null && (
          <Input
            key={`rerun-${peekRunRecord.id}`}
            label="Rerun with a note: "
            placeholder="e.g. cut it to 6,000 words; verify the DORA facts"
            submitLabel="rerun"
            onSubmit={(note: string) => rerunRun($, peekRunRecord, note, rerunQueue)}
          />
        )}
      </Box>
    )

    // The latest request in full; earlier ones as one line each; agents of no request last.
    const latest = items[items.length - 1]
    const earlier = items.slice(0, -1).reverse()
    const loose = list.filter(run => !run.requestId || !items.some(r => r.id === run.requestId))
    const room = Math.max(
      2,
      Math.floor(
        (rows -
          fleet.models.length -
          24 -
          earlier.length -
          unmerged.length -
          (showHelp ? HELP_LINES.length + 2 : 0) -
          (peeked ? 10 : 0) -
          (showHistory ? 10 : 0)) /
          3,
      ),
    )
    const latestRuns = latest ? list.filter(run => run.requestId === latest.id).slice(-room) : []

    const requestLine = (request: FleetRequest, isLatest: boolean) => {
      const mine = list.filter(run => run.requestId === request.id)
      const phase = phaseOf(request, list)
      const tokens = mine.reduce((sum, run) => sum + (run.tokens ?? 0), 0)
      const percent = requestPercent(request, list, fleet)
      const color = phase === 'done' ? 'success' : phase === 'stopped' ? 'warning' : 'claude'
      const isRunning = isLatest && phase !== 'done' && phase !== 'stopped'
      const isPaused = phase === 'paused'
      const barWidth = Math.max(8, Math.min(20, inner - 60))
      const facts = [
        PHASE_LABEL[phase],
        `${mine.length} agents`,
        elapsedText(request.startedAt, request.endedAt ?? at),
        ...(tokens > 0 ? [tokensText(tokens)] : []),
        ...(request.cost ? [usdText(request.cost)] : []),
      ].join(' · ')
      return (
        <Box flexDirection="column">
          <Box>
            <Text color={color} bold={isLatest} wrap="truncate-end">
              {phase === 'done' ? '✓' : phase === 'stopped' ? '■' : '▶'}{' '}
              {fit(request.title, Math.max(12, inner - (isRunning ? 28 : 2)))}
            </Text>
            {isRunning && (
              <Button
                key="pause-all"
                hotkey="x"
                label={isPaused ? 'Resume all' : 'Pause all'}
                onPress={async () => {
                  const mine = (await read($, runs)).filter(run => run.requestId === request.id)
                  for (const run of mine) {
                    if (isPaused) await resumeRun($, run, rerunQueue)
                    else await pauseRun($, run)
                  }
                }}
              />
            )}
            {isRunning && <Text>{NB}</Text>}
            {isRunning && (
              <Button
                key="stop-all"
                hotkey="s"
                label="Stop all"
                onPress={() => stopRequest($, request)}
              />
            )}
          </Box>
          <Text color={color} wrap="truncate-end">
            {'  '}
            {bar(percent, barWidth)} {String(percent).padStart(3)}% {facts}
          </Text>
          {isLatest && request.runDir ? (
            <Text color={ink} wrap="truncate-end">
              {'  '}Run folder: {request.runDir}
            </Text>
          ) : null}
        </Box>
      )
    }

    const onOff = (isOn: boolean) => (isOn ? '● on' : '○ off')
    const pick = (label: string) => `${label} ▾`
    // A bordered section with a bold title; the border takes the colour scheme's line colour.
    const card = (title: string, titleColor: string, body: unknown, extra?: unknown) => (
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={theme.line}
        paddingX={1}
        marginTop={1}
      >
        <Box columnGap={1}>
          <Text color={titleColor} bold>
            {title}
          </Text>
          {extra as never}
        </Box>
        {body as never}
      </Box>
    )
    const leadRow = (
      key: FleetLeadKey,
      name: string,
      lead: FleetLead,
      keys: [string, string],
      what: string,
    ) => (
      <Box columnGap={1}>
        <Text color={ROLE_COLOR[key]} bold>
          {fit(name, 10)}
        </Text>
        <Button
          key={key}
          hotkey={keys[0]}
          variant={lead.isEnabled ? 'primary' : 'secondary'}
          label={onOff(lead.isEnabled)}
          onPress={() => toggleLead(key)}
        />
        <Button
          key={`${key}-model`}
          hotkey={keys[1]}
          variant="primary"
          label={pick(modelLabel(lead.model))}
          onPress={() => cycleLead(key)}
        />
        <Text color={ink} dimColor wrap="truncate-end">
          {what}
        </Text>
      </Box>
    )
    const slotRows: number[][] = []
    fleet.models.forEach((_, i) => {
      if (i % 3 === 0) slotRows.push([])
      slotRows[slotRows.length - 1]!.push(i)
    })

    return (
      <Box
        flexDirection="column"
        width={width}
        minHeight={rows}
        paddingX={1}
        {...(theme.bg ? { backgroundColor: theme.bg } : {})}
      >
        <Box columnGap={1}>
          <Text color={ink} bold>
            Fleet
          </Text>
          <Button
            key="toggle"
            hotkey="t"
            variant={fleet.isEnabled ? 'primary' : 'secondary'}
            label={fleet.isEnabled ? '● on' : '○ off'}
            onPress={() => savePlan($, current => ({ ...current, isEnabled: !current.isEnabled }))}
          />
          <Button
            key="project"
            hotkey="u"
            variant={projectOff ? 'primary' : 'secondary'}
            label={projectOff ? '☑ skip this project' : '☐ skip this project'}
            onPress={toggleProject}
          />
          <Button
            key="help"
            hotkey="h"
            variant="secondary"
            label={showHelp ? '? hide help' : '? help'}
            onPress={() => update($, isHelpOpen, open => !open)}
          />
          <Button
            key="theme"
            hotkey="b"
            variant="secondary"
            label={`◐ ${theme.label}`}
            onPress={cycleTheme}
          />
        </Box>
        <Text
          color={fleet.isEnabled && !projectOff ? 'success' : 'warning'}
          wrap="truncate-end"
        >
          {!fleet.isEnabled
            ? 'Off everywhere: the settings below are not applied and agents run unmanaged (t).'
            : projectOff
              ? 'On, but skipped in this project: nothing below is applied here (u).'
              : 'On in this project.'}
        </Text>

        {card(
          'Lead agents',
          ink,
          <>
            {leadRow(
              'researcher',
              'Researcher',
              researcher,
              ['i', 'j'],
              'web research on what exists, before the plan',
            )}
            {leadRow(
              'planner',
              'Planner',
              planner,
              ['p', 'o'],
              'thinks first, plans jobs and waves',
            )}
            {leadRow(
              'reviewer',
              'Reviewer',
              reviewer,
              ['r', 'e'],
              `checks the result · ${fleet.reviewWhen === 'auto' ? 'when it pays' : 'every request'} · ${fleet.reviewDepth === 'quick' ? 'quick' : 'full'}`,
            )}
            {leadRow(
              'designer',
              'Designer',
              designer,
              ['d', 'n'],
              'polishes into files, uploads nothing',
            )}
            {leadRow(
              'security',
              'Security',
              security,
              ['k', 'z'],
              'security review of what was built, last',
            )}
          </>,
        )}

        {card(
          `Workers · ${fleet.models.length}`,
          ink,
          <>
            <Box columnGap={1}>
              <Button
                key="fewer"
                hotkey="f"
                variant="secondary"
                label="−"
                onPress={() => resize(-1)}
              />
              <Button
                key="more"
                hotkey="m"
                variant="secondary"
                label="+"
                onPress={() => resize(1)}
              />
              <Text color={ink} dimColor>
                count
              </Text>
              <Button
                key="auto"
                hotkey="a"
                variant="primary"
                label={pick(fleet.isAutoSize ? 'chosen per task' : 'always all')}
                onPress={() =>
                  savePlan($, current => ({ ...current, isAutoSize: !current.isAutoSize }))
                }
              />
            </Box>
            {slotRows.map(row => (
              <Box columnGap={3} marginTop={1}>
                {row.map(i => (
                  <Box columnGap={1}>
                    <Text color={ink}>{`Agent ${i + 1}`}</Text>
                    <Button
                      key={`slot-${i}`}
                      hotkey={i < 9 ? String(i + 1) : undefined}
                      variant="primary"
                      label={pick(modelLabel(fleet.models[i] ?? 'inherit'))}
                      onPress={() =>
                        savePlan($, current => ({
                          ...current,
                          models: current.models.map((m, j) => (j === i ? nextModel(m) : m)),
                        }))
                      }
                    />
                  </Box>
                ))}
              </Box>
            ))}
          </>,
        )}

        {card(
          'Options',
          ink,
          <>
            <Box columnGap={1}>
              <Text color={ink}>Files</Text>
              <Button
                key="files"
                hotkey="l"
                variant={isFileHandoffOn(fleet) ? 'primary' : 'secondary'}
                label={onOff(isFileHandoffOn(fleet))}
                onPress={() =>
                  savePlan($, current => ({ ...current, isFileHandoff: !isFileHandoffOn(current) }))
                }
              />
              <Text color={ink}> Worktrees</Text>
              <Button
                key="worktrees"
                hotkey="w"
                variant={isWorktreesOn(fleet) ? 'primary' : 'secondary'}
                label={onOff(isWorktreesOn(fleet))}
                onPress={async () => $.ui.toast(await setWorktreesMode($, !isWorktreesOn(fleet)))}
              />
              <Text color={ink}> Messages</Text>
              <Button
                key="messages"
                hotkey="v"
                variant="primary"
                label={pick(fleet.messages ?? 'full')}
                onPress={() =>
                  savePlan($, current => {
                    const order = ['full', 'compact', 'quiet'] as const
                    const at = order.indexOf(current.messages ?? 'full')
                    return { ...current, messages: order[(at + 1) % order.length] }
                  })
                }
              />
            </Box>
            <Text color={ink} dimColor wrap="truncate-end">
              {`Budget ${
                fleet.budgetUsd
                  ? `${usdText(fleet.budgetUsd)} per request · ${fleet.budgetAction ?? 'warn'} at the limit`
                  : 'none'
              }  ·  notify ${fleet.notify ?? 'all'}  ·  set with /fleet budget, /fleet notify`}
            </Text>
            <Text color={mem?.isLow ? 'error' : ink} dimColor={!mem?.isLow} wrap="truncate-end">
              {`Memory ${
                fleet.memMinFreeMb === null
                  ? 'guard off'
                  : `keep ${memLimit !== null ? memText(memLimit) : fleet.memMinFreeMb != null ? memText(fleet.memMinFreeMb) : 'a tenth'} free · ${fleet.memAction ?? 'pause'} when low` +
                    (mem ? ` · ${memText(mem.availMb)} free now` : '')
              }  ·  small requests ${isQuickDirectOn(fleet) ? 'direct' : 'to the fleet'}  ·  stuck ${
                stallMinutes === null
                  ? 'check off'
                  : `after ${stallMinutes}m · ${stallActionOf(fleet)}`
              }  ·  /fleet memory, /fleet stuck`}
            </Text>
          </>,
        )}

        {showHelp &&
          card(
            'Commands',
            ink,
            <>
              {HELP_LINES.map(line => (
                <Text color={ink} wrap="truncate-end">
                  {line}
                </Text>
              ))}
            </>,
          )}

        {card(
          'Progress',
          ink,
          <>
            {items.length === 0 && loose.length === 0 && (
              <Text color={ink} dimColor>
                No subagents yet. Send Claude a task while the fleet is on.
              </Text>
            )}
            {latest !== undefined && requestLine(latest, true)}
            {latestRuns.map(run => (
              <Box flexDirection="column" marginTop={1}>
                {runRow(run)}
              </Box>
            ))}
            {peekPanel}
            {earlier.length > 0 && <Text color={ink}>{NB}</Text>}
            {earlier.map(request => requestLine(request, false))}
            {loose.length > 0 && (
              <Text color={ink} bold>
                Other agents
              </Text>
            )}
            {loose.slice(-5).map(runRow)}
          </>,
          [
            <Button
              key="clear"
              variant="secondary"
              hotkey="c"
              label="✕ clear finished"
              onPress={async () => {
                await update($, runs, keep => keep.filter(run => run.status === 'running'))
                await update($, requests, keep => keep.filter(request => request.endedAt === null))
                await update($, peek, () => null)
                await refreshStatus($)
              }}
            />,
            <Button
              key="history"
              hotkey="y"
              variant="secondary"
              label={showHistory ? '◷ hide history' : '◷ history'}
              onPress={() => update($, isHistoryOpen, open => !open)}
            />,
          ],
        )}

        {showHistory &&
          card(
            'History · this project',
            ink,
            <>
              {pastHere.length === 0 && (
                <Text color={ink} dimColor>
                  No finished requests here yet.
                </Text>
              )}
              {pastHere.map(one => (
                <Box columnGap={1}>
                  <Text color={one.outcome === 'done' ? 'success' : 'warning'} wrap="truncate-end">
                    {one.outcome === 'done' ? '✓' : '■'}{' '}
                    {new Date(one.endedAt).toISOString().slice(5, 16).replace('T', ' ')}{' '}
                    {fit(one.title, Math.max(12, inner - 44))}{' '}
                    {fit(elapsedText(one.startedAt, one.endedAt), 6)} {fit(`${one.agents} ag`, 5)}{' '}
                    {one.cost ? usdText(one.cost) : ''}
                  </Text>
                  {one.runDir ? (
                    <Button
                      key={`open-${one.id}`}
                      dimColor
                      plain
                      label="open"
                      onPress={() => openFolder($, one.runDir!)}
                    />
                  ) : null}
                </Box>
              ))}
            </>,
          )}

        {unmerged.length > 0 &&
          card(
            'Worktrees with unmerged work',
            'warning',
            <>
              {unmerged.map(one => (
                <Text color={one.status === 'conflict' ? 'error' : ink} wrap="truncate-end">
                  • {fit(one.label, 8)} {fit(WORKTREE_LABEL[one.status], 15)} {one.commits}{' '}
                  commit(s) · {one.branch}
                  {one.note ? ` · ${one.note}` : ''}
                </Text>
              ))}
            </>,
            <Button
              key="merge"
              hotkey="g"
              variant="primary"
              label="⇢ merge finished"
              onPress={async () => $.ui.toast((await mergeWorktrees($)).split('\n')[0] ?? '')}
            />,
          )}

        <Box marginTop={1}>
          <Text color={ink} dimColor wrap="truncate-end">
            Agent fleet {VERSION} · {COPYRIGHT} · press a ▾ button (or its number key) to change it
          </Text>
        </Box>
      </Box>
    )
  })
}
