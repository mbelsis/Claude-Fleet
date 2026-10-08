import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type {
  FleetLead,
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
  THEMES,
  themeOf,
  tokensText,
  usdText,
  wavesOf,
  worktreeGuard,
  worktreeNote,
} from './lib'
import type { Phase } from './lib'

// The pure logic lives in ./lib; tests and other plugins import it from here too.
export * from './lib'

const PANE = 'agent-fleet'
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

const GLYPH = { running: '●', done: '✓', failed: '✗', stopped: '■' } as const
// Theme keys, so status colours follow the person's light or dark theme.
const STATUS_COLOR = {
  running: 'claude',
  done: 'success',
  failed: 'error',
  stopped: 'warning',
} as const
const PHASE_LABEL: Record<Phase, string> = {
  planning: 'Planning',
  working: 'Workers running',
  combining: 'Combining results',
  reviewing: 'Reviewing',
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
async function stopRun($: EngineInterface, run: FleetRun): Promise<void> {
  const answer = await $.tool.call({
    tool: 'TaskStop',
    task_id: run.id,
    consent: `The user pressed "Stop" for the fleet agent "${run.description}".`,
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

async function stopRequest($: EngineInterface, request: FleetRequest): Promise<void> {
  const list = await read($, runs)
  const running = list.filter(run => run.requestId === request.id && run.status === 'running')
  for (const run of running) await stopRun($, run)
  const at = await $.clock.now()
  await setRequest($, request.id, one =>
    one.endedAt === null ? { ...one, endedAt: at, outcome: 'stopped' } : one,
  )
}

/** Creates the worktree and branch one worker edits in, cut from the request's base commit. */
async function createWorktree(
  $: EngineInterface,
  request: FleetRequest,
  job: number,
  label: string,
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
    one => one.requestId === request.id && one.job === job && one.status === 'active',
  )
  if (existing) return existing
  const home = await homeDir($)
  const repoName = slugOf(repo.root.split('/').pop() ?? 'repo')
  const branch = `fleet/${request.id}/job-${job}`
  const path = `${home}/.claude/fleet-worktrees/${repoName}/${request.id}-job-${job}`
  const added = await git($, ['worktree', 'add', '-b', branch, path, baseCommit], repo.root)
  if (added.exitCode !== 0) return added.stderr.trim() || 'git worktree add failed'
  const worktree: FleetWorktree = {
    id: `${request.id}-job-${job}`,
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

/** Starts a finished agent again with the same brief and the person's note. */
async function rerunRun(
  $: EngineInterface,
  run: FleetRun,
  note: string,
  queue: Map<string, FleetRun>,
): Promise<void> {
  if (!run.prompt) {
    $.ui.toast(
      'Agent fleet: this agent started before reruns were possible; its brief was not kept.',
    )
    return
  }
  const description = `${run.description.replace(/ \(rerun\)$/, '')} (rerun)`
  queue.set(description, run)
  const wt = run.worktreeId
    ? (await read($, worktrees)).find(one => one.id === run.worktreeId)
    : undefined
  const extra = note.trim() ? `\n\nNote from the user for this rerun: ${note.trim()}` : ''
  const started = await $.agent.spawn({
    prompt: run.prompt + extra,
    description,
    subagentType: run.type,
    model: run.model,
    ...(wt && UNMERGED.includes(wt.status) ? { cwd: wt.path } : {}),
  })
  if (started.deny !== undefined) {
    queue.delete(description)
    $.ui.toast(`Agent fleet: rerun refused: ${started.deny}`)
  }
}

/** Keeps a request's live cost and acts on its budget. */
async function tickBudget($: EngineInterface): Promise<void> {
  const request = await openRequest($)
  if (request === undefined || request.costAtStart == null) return
  const usd = (await $.session.usage()).cost?.usd
  if (usd === undefined) return
  const cost = Math.max(0, usd - request.costAtStart)
  const fleet = await read($, plan)
  const level = budgetLevel(cost, fleet.budgetUsd)
  if (Math.abs(cost - (request.cost ?? 0)) >= 0.01 || level > (request.budgetLevel ?? 0)) {
    await setRequest($, request.id, one => ({
      ...one,
      cost,
      budgetLevel: Math.max(level, one.budgetLevel ?? 0),
    }))
  }
  if (level > (request.budgetLevel ?? 0) && fleet.budgetUsd) {
    if (level === 1) {
      $.ui.toast(
        `Agent fleet: "${request.title}" has used 80% of its ${usdText(fleet.budgetUsd)} budget.`,
      )
    } else if (fleet.budgetAction === 'stop') {
      $.ui.toast(
        `Agent fleet: budget ${usdText(fleet.budgetUsd)} reached — stopping "${request.title}".`,
      )
      await stopRequest($, request)
    } else {
      $.ui.toast(
        `Agent fleet: "${request.title}" has reached its ${usdText(fleet.budgetUsd)} budget.`,
      )
    }
  }
}

export const register: Register = on => {
  // Slots the main loop has handed out since the person's last prompt, when no job is named.
  let slotCursor = 0
  // Reruns waiting for their agent.spawn, by description.
  const rerunQueue = new Map<string, FleetRun>()
  let ticks = 0

  on('session.start', async ($, e, next) => {
    const saved = (await $.store.get('plan')) as FleetPlan | undefined
    if (saved !== undefined && Array.isArray(saved.models)) {
      await update($, plan, () => saved)
    }
    const root = await projectRoot($)
    const offList = ((await $.store.get('projects-off')) as string[] | undefined) ?? []
    await update($, isProjectOff, () => offList.includes(root))
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
    await $.tool.register(PROGRESS_SPEC)
    $.clock.every(1000, async () => {
      ticks += 1
      const list = await read($, runs)
      const open = await openRequest($)
      if (open !== undefined || list.some(run => run.status === 'running')) {
        const at = await $.clock.now()
        await update($, now, () => at)
      }
      if (open !== undefined && ticks % 3 === 0) await tickBudget($)
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
    if (head === 'planner' || head === 'reviewer') {
      const current = await read($, plan)
      const lead = head === 'planner' ? plannerOf(current) : reviewerOf(current)
      let chosen: FleetLead | null = null
      if (word === 'on' || word === 'off') chosen = { ...lead, isEnabled: word === 'on' }
      else if (isModel(word)) chosen = { isEnabled: true, model: word }
      if (chosen === null)
        return { text: `Use /fleet ${head} on | off | ${LEAD_MODELS.join(' | ')}` }
      const value = chosen
      await savePlan($, plan0 => ({ ...plan0, [head]: value }))
      const name = head === 'planner' ? 'Lead planner' : 'Reviewer'
      return {
        text: value.isEnabled
          ? `${name} on, running on ${modelLabel(value.model)}.`
          : `${name} off.`,
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
    if (head === 'worktrees') {
      if (word === 'on' || word === 'off') {
        return { text: await setWorktreesMode($, word === 'on') }
      }
      return { text: await worktreeReport($) }
    }
    if (arg === 'merge') return { text: await mergeWorktrees($) }
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
    if (arg === 'help') return { text: ['Agent fleet commands:', ...HELP_LINES].join('\n') }
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

    slotCursor = 0
    const at = await $.clock.now()
    const firstLine = e.text.trim().split('\n')[0] ?? ''
    const title = firstLine.length > 60 ? `${firstLine.slice(0, 59)}…` : firstLine || 'Request'
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

    return {
      sections: [
        ...composed.sections,
        { id: 'agent-fleet:plan', text: planText(fleet), scope: 'session' as const },
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
    const rerunOf = rerunQueue.get(e.description)
    if (rerunOf) rerunQueue.delete(e.description)
    const role: FleetRole = rerunOf
      ? (rerunOf.role ?? 'worker')
      : e.subagentType === PLANNER_TYPE
        ? 'planner'
        : e.subagentType === REVIEWER_TYPE
          ? 'reviewer'
          : active && isMain
            ? 'worker'
            : 'other'
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

    if (role === 'planner') {
      // The planner takes no worker slot: it runs on its own model and is told the slots.
      const planner = plannerOf(fleet)
      const howMany = fleet.isAutoSize
        ? `You choose how many jobs to write: between 1 and ${fleet.models.length}, as many as ` +
          'the task really divides into. Job N goes to Agent N.'
        : `Write exactly ${fleet.models.length} jobs. Job N goes to Agent N.`
      input = {
        ...e,
        prompt: `${e.prompt}\n\nWorker slots (${fleet.models.length}):\n${slotLines(fleet).join('\n')}\n${howMany}`,
      }
      if (planner.model !== 'inherit') input = { ...input, model: planner.model }
    } else if (role === 'reviewer') {
      const reviewer = reviewerOf(fleet)
      const files = request?.runDir
        ? `\n\nThe run folder ${request.runDir} holds the plan (plan.md), each worker's result ` +
          '(job-N.md) and the combined result (combined.md) when it is long; read them there.'
        : ''
      input = { ...e, prompt: e.prompt + files }
      if (reviewer.model !== 'inherit') input = { ...input, model: reviewer.model }
    } else if (role === 'worker' && !rerunOf) {
      const mine = list.filter(
        run => run.requestId === requestId && run.role === 'worker' && !isReplaced(run, list),
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
      if (mine.length >= fleet.models.length) {
        return {
          deny:
            `The agent fleet allows ${fleet.models.length} workers per request and all are in ` +
            'use. Finish with the agents already running, or the user can change it with /fleet.',
        }
      }
      const taken = new Set(mine.map(run => run.slot))
      slot =
        job !== null && job <= fleet.models.length && !taken.has(job - 1)
          ? job - 1
          : (Array.from({ length: fleet.models.length }, (_, i) => i).find(i => !taken.has(i)) ??
            slotCursor)
      slotCursor = Math.max(slotCursor, slot + 1)
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

    const started = await next(input)
    if (started.deny === undefined && started.agentId !== undefined) {
      const run: FleetRun = {
        id: started.agentId,
        description:
          role === 'planner'
            ? `Planner: ${e.description || 'plan'}`
            : role === 'reviewer'
              ? `Reviewer: ${e.description || 'review'}`
              : e.description || e.subagentType,
        type: e.subagentType,
        model: started.model,
        slot,
        status: 'running',
        startedAt: await $.clock.now(),
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

    return started
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: /^mcp__agent-fleet__progress$/ }, async ($, e) => {
    const agentId = e.agentId
    const progress = progressFrom(e as Record<string, unknown>)
    if (agentId === undefined) return { result: 'Only fleet subagents report progress.' }
    if (progress === null) return { result: 'Give done and total as whole numbers, total ≥ 1.' }
    await update($, runs, list =>
      list.map(run => (run.id === agentId ? { ...run, progress } : run)),
    )
    return { result: 'Progress recorded.' }
  })

  on('tool.call', async ($, e, next) => {
    const agentId = e.agentId
    const tool = String(e.tool)
    if (agentId === undefined || tool === PROGRESS_TOOL) return next(e)
    const list = await read($, runs)
    const run = list.find(one => one.id === agentId)
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
      await update($, runs, items =>
        items.map(one =>
          one.id === agentId
            ? {
                ...one,
                tools: one.tools + 1,
                lastTool: tool,
                steps: stepsAfter(one.steps ?? NO_STEPS, tool, e as Record<string, unknown>),
              }
            : one,
        ),
      )
    }
    return next(e)
  }).catch(($, e, next) => next(e))

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
            ? { ...one, status: one.status === 'stopped' ? 'stopped' : status, endedAt: at, tokens }
            : one,
        ),
      )
      if (run?.role === 'planner' && run.requestId && status === 'done') {
        // The plan is kept in the run folder, and its jobs and waves steer the workers.
        const jobs = jobsOf(e.answer)
        const request = (await read($, requests)).find(one => one.id === run.requestId)
        if (request?.runDir) await $.fs.write(`${request.runDir}/plan.md`, e.answer)
        if (jobs.length > 0) {
          const isAuto = (await read($, plan)).isAutoSize === true
          await setRequest($, run.requestId, one => ({
            ...one,
            jobs,
            expectedWorkers: isAuto ? jobs.length : one.expectedWorkers,
          }))
        }
      }
      if (run?.worktreeId) {
        const wt = (await read($, worktrees)).find(one => one.id === run.worktreeId)
        if (wt && wt.status === 'active') await finishWorktree($, wt)
      }
      if (run?.rerunOf && status === 'done') {
        // A rerun the person started has no caller waiting; its answer goes to the conversation.
        await $.prompt.submit({
          text:
            `[Agent fleet] The user reran "${run.description}". Its new result` +
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
      if (!mine.some(run => run.status === 'running')) {
        await setRequest($, open.id, one => ({
          ...one,
          endedAt: at,
          outcome: e.reason === 'aborted' ? 'stopped' : 'done',
        }))
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
    const pendingWorktrees = (await read($, worktrees)).filter(
      one => one.requestId === request.id && (one.status === 'ready' || one.status === 'conflict'),
    ).length
    const facts = [
      PHASE_LABEL[phase],
      `workers ${workersDone}/${expected || '?'}`,
      ...(lastWave > 1 ? [`wave ${runningWave || '–'}/${lastWave}`] : []),
      elapsedText(request.startedAt, request.endedAt ?? at),
      ...(tokens > 0 ? [tokensText(tokens)] : []),
      ...(request.cost ? [`${usdText(request.cost)}${budget}`] : []),
      ...(pendingWorktrees ? [`${pendingWorktrees} worktree(s) to merge`] : []),
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
          <Text color={(request.budgetLevel ?? 0) >= 2 ? 'error' : color}>{facts} </Text>
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
    const projectOff = await read($, isProjectOff)
    const peeked = await read($, peek)
    const root = await projectRoot($)
    const ledger = (await read($, worktrees)).filter(one => one.repoRoot === root)
    const unmerged = ledger.filter(one => UNMERGED.includes(one.status))
    const ink = theme.text
    const planner = plannerOf(fleet)
    const reviewer = reviewerOf(fleet)

    const resize = (delta: number) =>
      savePlan($, current => {
        const count = Math.min(MAX_AGENTS, Math.max(1, current.models.length + delta))
        const models = Array.from({ length: count }, (_, i) => current.models[i] ?? 'inherit')
        return { ...current, models }
      })
    const toggleLead = (key: 'planner' | 'reviewer') =>
      savePlan($, current => {
        const lead = key === 'planner' ? plannerOf(current) : reviewerOf(current)
        return { ...current, [key]: { ...lead, isEnabled: !lead.isEnabled } }
      })
    const cycleLead = (key: 'planner' | 'reviewer') =>
      savePlan($, current => {
        const lead = key === 'planner' ? plannerOf(current) : reviewerOf(current)
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

    const descWidth = Math.max(10, width - 66)
    const runRow = (run: FleetRun) => {
      const percent = percentOf(run)
      const replaced = isReplaced(run, list)
      const detail =
        run.status === 'running'
          ? run.progress?.step || run.lastTool || 'starting'
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
              {GLYPH[run.status]} {fit(roleLabel(run), 9)} {fit(run.description, descWidth)}{' '}
              {fit(shortModel(run.model), 11)} {fit(percent === null ? '—' : `${percent}%`, 5)}{' '}
              {fit(elapsedText(run.startedAt, run.endedAt ?? at), 6)} {fit(`${run.tools} tools`, 9)}{' '}
              {fit(detail, 18)}
            </Text>
            <Button
              key={`peek-${run.id}`}
              dimColor
              plain
              label={peeked?.runId === run.id ? 'close' : 'peek'}
              onPress={() => openPeek(run)}
            />
            {run.status === 'running' && (
              <>
                <Text> </Text>
                <Button
                  key={`stop-${run.id}`}
                  dimColor
                  plain
                  label="stop"
                  onPress={() => stopRun($, run)}
                />
              </>
            )}
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
          20 -
          earlier.length -
          unmerged.length -
          (showHelp ? HELP_LINES.length + 2 : 0) -
          (peeked ? 10 : 0)) /
          2,
      ),
    )
    const latestRuns = latest ? list.filter(run => run.requestId === latest.id).slice(-room) : []

    const requestLine = (request: FleetRequest, isLatest: boolean) => {
      const mine = list.filter(run => run.requestId === request.id)
      const phase = phaseOf(request, list)
      const tokens = mine.reduce((sum, run) => sum + (run.tokens ?? 0), 0)
      const percent = requestPercent(request, list, fleet)
      const color = phase === 'done' ? 'success' : phase === 'stopped' ? 'warning' : 'claude'
      return (
        <Box flexDirection="column">
          <Box>
            <Text color={color} bold={isLatest}>
              {phase === 'done' ? '✓' : phase === 'stopped' ? '■' : '▶'}{' '}
              {fit(request.title, Math.max(12, width - 70))} {bar(percent, 12)}{' '}
              {String(percent).padStart(3)}% {fit(PHASE_LABEL[phase], 17)} {mine.length} agents ·{' '}
              {elapsedText(request.startedAt, request.endedAt ?? at)}
              {tokens > 0 ? ` · ${tokensText(tokens)}` : ''}
              {request.cost ? ` · ${usdText(request.cost)}` : ''}
            </Text>
            {isLatest && phase !== 'done' && phase !== 'stopped' && (
              <Button
                key="stop-all"
                hotkey="s"
                label="Stop all"
                onPress={() => stopRequest($, request)}
              />
            )}
          </Box>
          {isLatest && request.runDir ? (
            <Text color={ink} wrap="truncate-end">
              {'  '}Run folder: {request.runDir}
            </Text>
          ) : null}
        </Box>
      )
    }

    return (
      <Box
        flexDirection="column"
        width={width}
        minHeight={rows}
        paddingX={1}
        {...(theme.bg ? { backgroundColor: theme.bg } : {})}
      >
        <Box>
          <Text color={ink} bold>
            Plan{' '}
          </Text>
          <Button
            key="toggle"
            hotkey="t"
            variant="primary"
            label={fleet.isEnabled ? 'On' : 'Off'}
            onPress={() => savePlan($, current => ({ ...current, isEnabled: !current.isEnabled }))}
          />
          <Text color={ink}> this project: </Text>
          <Button
            key="project"
            hotkey="u"
            variant="primary"
            label={projectOff ? 'off' : 'on'}
            onPress={toggleProject}
          />
          <Text color={ink}> </Text>
          <Button
            key="help"
            hotkey="h"
            variant="primary"
            label={showHelp ? 'hide help' : 'help'}
            onPress={() => update($, isHelpOpen, open => !open)}
          />
          <Text color={ink}> </Text>
          <Button
            key="theme"
            hotkey="b"
            variant="primary"
            label={`colours: ${theme.label}`}
            onPress={cycleTheme}
          />
        </Box>
        <Box>
          <Text color={ink}>Planner: </Text>
          <Button
            key="planner"
            hotkey="p"
            variant="primary"
            label={planner.isEnabled ? 'On' : 'Off'}
            onPress={() => toggleLead('planner')}
          />
          <Text color={ink}> </Text>
          <Button
            key="planner-model"
            hotkey="o"
            variant="primary"
            label={modelLabel(planner.model)}
            onPress={() => cycleLead('planner')}
          />
          <Text color={ink}> thinks first, plans jobs and waves</Text>
        </Box>
        <Box>
          <Text color={ink}>Reviewer: </Text>
          <Button
            key="reviewer"
            hotkey="r"
            variant="primary"
            label={reviewer.isEnabled ? 'On' : 'Off'}
            onPress={() => toggleLead('reviewer')}
          />
          <Text color={ink}> </Text>
          <Button
            key="reviewer-model"
            hotkey="e"
            variant="primary"
            label={modelLabel(reviewer.model)}
            onPress={() => cycleLead('reviewer')}
          />
          <Text color={ink}> checks the combined result last</Text>
        </Box>
        <Box>
          <Text color={ink}>Workers: {fleet.models.length} </Text>
          <Button key="fewer" hotkey="f" variant="primary" label="−" onPress={() => resize(-1)} />
          <Button key="more" hotkey="m" variant="primary" label="+" onPress={() => resize(1)} />
          <Text color={ink}> count: </Text>
          <Button
            key="auto"
            hotkey="a"
            variant="primary"
            label={fleet.isAutoSize ? 'chosen per task' : 'always all'}
            onPress={() =>
              savePlan($, current => ({ ...current, isAutoSize: !current.isAutoSize }))
            }
          />
        </Box>
        {fleet.models.map((model, i) => (
          <Box>
            <Text color={ink}> Agent {i + 1}: </Text>
            <Button
              key={`slot-${i}`}
              hotkey={i < 9 ? String(i + 1) : undefined}
              variant="primary"
              label={modelLabel(model)}
              onPress={() =>
                savePlan($, current => ({
                  ...current,
                  models: current.models.map((m, j) => (j === i ? nextModel(m) : m)),
                }))
              }
            />
          </Box>
        ))}
        <Box>
          <Text color={ink}>Files: </Text>
          <Button
            key="files"
            hotkey="l"
            variant="primary"
            label={isFileHandoffOn(fleet) ? 'on' : 'off'}
            onPress={() =>
              savePlan($, current => ({ ...current, isFileHandoff: !isFileHandoffOn(current) }))
            }
          />
          <Text color={ink}> worktrees: </Text>
          <Button
            key="worktrees"
            hotkey="w"
            variant="primary"
            label={isWorktreesOn(fleet) ? 'on' : 'off'}
            onPress={async () => $.ui.toast(await setWorktreesMode($, !isWorktreesOn(fleet)))}
          />
          <Text color={ink}>
            {' '}
            budget:{' '}
            {fleet.budgetUsd
              ? `${usdText(fleet.budgetUsd)} · ${fleet.budgetAction ?? 'warn'}`
              : 'none'}{' '}
            (/fleet budget)
          </Text>
        </Box>
        <Text color={ink}>Press a model (or its number key) to change it.</Text>
        {showHelp && <Text color={ink}> </Text>}
        {showHelp && (
          <Text color={ink} bold>
            Commands
          </Text>
        )}
        {showHelp && HELP_LINES.map(line => <Text color={ink}>{line}</Text>)}
        <Text color={ink}> </Text>
        <Box>
          <Text color={ink} bold>
            Progress{' '}
          </Text>
          <Button
            key="clear"
            variant="primary"
            hotkey="c"
            label="Clear finished"
            onPress={async () => {
              await update($, runs, keep => keep.filter(run => run.status === 'running'))
              await update($, requests, keep => keep.filter(request => request.endedAt === null))
              await update($, peek, () => null)
              await refreshStatus($)
            }}
          />
          {projectOff && <Text color="warning"> the fleet is off for this project</Text>}
        </Box>
        {items.length === 0 && loose.length === 0 && <Text color={ink}>No subagents yet.</Text>}
        {latest !== undefined && requestLine(latest, true)}
        {latestRuns.map(runRow)}
        {peekPanel}
        {earlier.map(request => requestLine(request, false))}
        {loose.length > 0 && <Text color={ink}>Other agents</Text>}
        {loose.slice(-5).map(runRow)}
        {unmerged.length > 0 && <Text color={ink}> </Text>}
        {unmerged.length > 0 && (
          <Box>
            <Text color={ink} bold>
              Worktrees with unmerged work{' '}
            </Text>
            <Button
              key="merge"
              hotkey="g"
              variant="primary"
              label="Merge finished"
              onPress={async () => $.ui.toast((await mergeWorktrees($)).split('\n')[0] ?? '')}
            />
          </Box>
        )}
        {unmerged.map(one => (
          <Text color={one.status === 'conflict' ? 'error' : ink} wrap="truncate-end">
            {'  '}• {fit(one.label, 8)} {fit(WORKTREE_LABEL[one.status], 15)} {one.commits}{' '}
            commit(s) · {one.branch}
            {one.note ? ` · ${one.note}` : ''}
          </Text>
        ))}
      </Box>
    )
  })
}
