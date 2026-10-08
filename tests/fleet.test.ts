import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import type { FleetRequest, FleetRun, FleetSteps } from '../types'

import {
  nextModel,
  parsePlan,
  percentOf,
  bar,
  jobCountOf,
  phaseOf,
  PLANNER_TYPE,
  progressFrom,
  requestPercent,
  REVIEWER_TYPE,
  planText,
  PROGRESS_NOTE,
  promptReminder,
  shortModel,
  stepsAfter,
  taskOf,
  themeOf,
  budgetLevel,
  jobOfPrompt,
  jobsOf,
  wavesOf,
  worktreeGuard,
  deliverableOf,
  designerGuard,
  DESIGNER_TYPE,
  titleOf,
} from '../hooks/register'

// The kit's `$` takes an event's full input; the plugin's calls take the short form.
const OFF = { isEnabled: false, models: [] }

test('parses a count and one model per agent', async () => {
  expect(parsePlan('3 opus sonnet haiku', OFF)).toEqual({
    isEnabled: true,
    models: ['opus', 'sonnet', 'haiku'],
  })
})

test('one model applies to every agent', async () => {
  expect(parsePlan('4 haiku', OFF)).toEqual({
    isEnabled: true,
    models: ['haiku', 'haiku', 'haiku', 'haiku'],
  })
})

test('refuses a bad count or an unknown model', async () => {
  expect(typeof parsePlan('0', OFF)).toBe('string')
  expect(typeof parsePlan('2 gpt', OFF)).toBe('string')
})

test('the plan text names each agent and its model', async () => {
  const text = planText({ isEnabled: true, models: ['opus', 'inherit'] })
  expect(text).toContain('exactly 2')
  expect(text).toContain('Agent 1: opus')
  expect(text).toContain('Agent 2: same model as you')
})

test('spawns get the planned models in order, and extras are refused', async ($, on) => {
  mock.store(on)
  mock.clock(on)
  let started = 0
  on('agent.spawn', (_$, e) => ({ model: e.model ?? 'parent', agentId: `agent-${++started}` }))

  await $.command.run({ command: 'fleet', args: '2 opus haiku' } as never)

  const first = await $.agent.spawn({ prompt: 'a', description: 'first' } as never)
  const second = await $.agent.spawn({ prompt: 'b', description: 'second' } as never)
  const third = await $.agent.spawn({ prompt: 'c', description: 'third' } as never)

  expect(first.model).toBe('opus')
  expect(second.model).toBe('haiku')
  expect(third.deny).toBeDefined()
  expect(started).toBe(2)
})

test('spawns pass through untouched while the plan is off', async ($, on) => {
  mock.store(on)
  mock.clock(on)
  on('agent.spawn', (_$, e) => ({ model: e.model ?? 'parent', agentId: 'agent-x' }))

  await $.command.run({ command: 'fleet', args: 'off' } as never)
  const spawned = await $.agent.spawn({ prompt: 'a', description: 'free' } as never)

  expect(spawned.model).toBe('parent')
})

test('pressing an agent moves it to the next model', async ($, on) => {
  mock.store(on)
  mock.clock(on)
  await $.command.run({ command: 'fleet', args: '2 haiku' } as never)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'agent-fleet',
      surface,
      component: 'Pane',
      requestId: 'agent-fleet',
      props: { bodyColumns: 80 },
      viewport: { columns: 120, rows: 40 },
    } as never)
    expect((await ui.find({ key: 'slot-0' }))?.text).toContain('haiku')
    await ui.press({ key: 'slot-0' })
    expect((await ui.find({ key: 'slot-0' }))?.text).toContain('fable')
    expect((await ui.find({ key: 'slot-1' }))?.text).toContain('haiku')
    await ui.unmount()
    await $.command.run({ command: 'fleet', args: '2 haiku' } as never)
  }
})

test('models cycle back to the start', async () => {
  expect(nextModel('fable')).toBe('inherit')
  expect(nextModel('inherit')).toBe('opus')
})

test('model ids are shown by family and version', async () => {
  expect(shortModel('claude-sonnet-5-5')).toBe('sonnet 5.5')
  expect(shortModel('claude-opus-5-5')).toBe('opus 5.5')
  expect(shortModel('claude-haiku-4-5-20251001')).toBe('haiku 4.5')
  expect(shortModel('claude-fable-5-1')).toBe('fable 5.1')
  expect(shortModel('haiku')).toBe('haiku')
})

const EMPTY: FleetSteps = {
  todoDone: 0,
  todoTotal: 0,
  created: 0,
  completedIds: [],
  deletedIds: [],
}

test('a TodoWrite list gives the completion percentage', async () => {
  const steps = stepsAfter(EMPTY, 'TodoWrite', {
    todos: [
      { content: 'a', status: 'completed', activeForm: 'a' },
      { content: 'b', status: 'in_progress', activeForm: 'b' },
      { content: 'c', status: 'pending', activeForm: 'c' },
      { content: 'd', status: 'pending', activeForm: 'd' },
    ],
  })
  expect(percentOf({ status: 'running', steps })).toBe(25)
})

test('TaskCreate and TaskUpdate count once per task, and deleted tasks drop out', async () => {
  let steps = EMPTY
  for (let i = 0; i < 4; i++)
    steps = stepsAfter(steps, 'TaskCreate', { subject: 's', description: 'd' })
  steps = stepsAfter(steps, 'TaskUpdate', { taskId: '1', status: 'completed' })
  steps = stepsAfter(steps, 'TaskUpdate', { taskId: '1', status: 'completed' })
  expect(percentOf({ status: 'running', steps })).toBe(25)
  steps = stepsAfter(steps, 'TaskUpdate', { taskId: '4', status: 'deleted' })
  expect(percentOf({ status: 'running', steps })).toBe(33)
})

test('no list shows no figure while running, and a finished agent is 100%', async () => {
  expect(percentOf({ status: 'running', steps: EMPTY })).toBe(null)
  expect(percentOf({ status: 'done', steps: EMPTY })).toBe(100)
  expect(stepsAfter(EMPTY, 'Read', { file_path: 'x' })).toEqual(EMPTY)
})

test('planned agents are asked to keep a task list', async ($, on) => {
  mock.store(on)
  mock.clock(on)
  let prompt = ''
  on('agent.spawn', (_$, e) => ((prompt = e.prompt), { model: 'm', agentId: 'agent-p' }))

  await $.command.run({ command: 'fleet', args: '1 haiku' } as never)
  await $.agent.spawn({ prompt: 'Write it.', description: 'p' } as never)

  expect(prompt).toBe('Write it.' + PROGRESS_NOTE)
})

test('the reminder beside each prompt asks for exactly N agents, slot by slot', async () => {
  const text = promptReminder({
    isEnabled: true,
    models: ['sonnet', 'sonnet', 'opus', 'inherit'],
    planner: { isEnabled: false, model: 'opus' },
  })
  expect(text).toContain('exactly 4 subtasks')
  expect(text).toContain('launch 4 Agent calls together')
  expect(text).toContain('Agent 3: opus')
  expect(text).toContain('Agent 4: same model as you')
})

test('with the planner on, the reminder sends the request to the planner first', async () => {
  const text = promptReminder({ isEnabled: true, models: ['sonnet', 'haiku'] })
  expect(text).toContain('subagent_type "agent-fleet:planner"')
  expect(text).toContain('exactly 2 job briefs')
  expect(text).toContain('launch the workers wave by wave')
})

test('the planner takes no worker slot, runs on its own model and is told the slots', async ($, on) => {
  mock.store(on)
  mock.clock(on)
  const seen: { type: string; model?: string; prompt: string }[] = []
  on('agent.spawn', (_$, e) => {
    seen.push({ type: e.subagentType, model: e.model, prompt: e.prompt })
    return { model: e.model ?? 'parent', agentId: `agent-${seen.length}` }
  })

  await $.command.run({ command: 'fleet', args: '2 sonnet haiku' } as never)
  await $.command.run({ command: 'fleet', args: 'planner opus' } as never)

  const planner = await $.agent.spawn({
    prompt: 'Write an article.',
    description: 'plan',
    subagentType: PLANNER_TYPE,
  } as never)
  const first = await $.agent.spawn({ prompt: 'Job 1', description: 'w1' } as never)
  const second = await $.agent.spawn({ prompt: 'Job 2', description: 'w2' } as never)

  expect(planner.model).toBe('opus')
  expect(seen[0]?.prompt).toContain('Worker slots (2):')
  expect(seen[0]?.prompt).toContain('Agent 2: haiku')
  expect(first.model).toBe('sonnet')
  expect(second.model).toBe('haiku')
})

test('/fleet planner off leaves the plan without a planner step', async ($, on) => {
  mock.store(on)
  mock.clock(on)
  await $.command.run({ command: 'fleet', args: '3 sonnet' } as never)
  const answer = await $.command.run({ command: 'fleet', args: 'planner off' } as never)
  expect(answer.text).toBe('Lead planner off.')
})

const REQUEST: FleetRequest = {
  id: 'r1',
  title: 'Write an article',
  startedAt: 0,
  endedAt: null,
  expectedWorkers: 2,
  outcome: 'open',
}
const run = (over: Partial<FleetRun>): FleetRun => ({
  id: 'x',
  description: 'd',
  type: 'general-purpose',
  model: 'claude-sonnet-5-5',
  slot: null,
  status: 'running',
  startedAt: 0,
  endedAt: null,
  tools: 0,
  lastTool: null,
  tokens: null,
  steps: EMPTY,
  role: 'worker',
  requestId: 'r1',
  progress: null,
  ...over,
})
const FLEET = { isEnabled: true, models: ['sonnet', 'opus'] as ('sonnet' | 'opus')[] }

test('the progress tool input becomes a clamped report', async () => {
  expect(progressFrom({ done: 2, total: 4, step: 'checking sources' })).toEqual({
    done: 2,
    total: 4,
    step: 'checking sources',
  })
  expect(progressFrom({ done: 9, total: 4 })).toEqual({ done: 4, total: 4, step: '' })
  expect(progressFrom({ done: 1, total: 0 })).toBe(null)
  expect(percentOf(run({ progress: { done: 1, total: 4, step: '' } }))).toBe(25)
})

test("a planner's answer gives the number of jobs", async () => {
  expect(jobCountOf('## Plan\nx\n## Job 1: a\nb\n## Job 2: c\n## How to combine')).toBe(2)
  expect(jobCountOf('no jobs here')).toBe(0)
})

test('a request moves through planning, working, combining and done', async () => {
  const planner = run({ id: 'p', role: 'planner' })
  expect(phaseOf(REQUEST, [planner])).toBe('planning')
  const workers = [run({ id: 'w1' }), run({ id: 'w2', status: 'done' })]
  expect(phaseOf(REQUEST, [{ ...planner, status: 'done' }, ...workers])).toBe('working')
  const done = workers.map(w => ({ ...w, status: 'done' as const }))
  expect(phaseOf(REQUEST, [{ ...planner, status: 'done' }, ...done])).toBe('combining')
  expect(phaseOf({ ...REQUEST, endedAt: 5, outcome: 'done' }, done)).toBe('done')
  expect(phaseOf({ ...REQUEST, endedAt: 5, outcome: 'stopped' }, done)).toBe('stopped')
})

test('overall progress weighs planner, each worker and the combining step', async () => {
  const planner = run({ id: 'p', role: 'planner', status: 'done' })
  const half = run({ id: 'w1', progress: { done: 1, total: 2, step: '' } })
  const done = run({ id: 'w2', status: 'done' })
  // planner 1 + workers 0.5 + 1, out of planner + 2 workers + combining = 4 shares
  expect(requestPercent(REQUEST, [planner, half, done], FLEET)).toBe(63)
  expect(requestPercent({ ...REQUEST, endedAt: 9, outcome: 'done' }, [], FLEET)).toBe(100)
})

test('the bar fills in proportion', async () => {
  expect(bar(50, 10)).toBe('█████░░░░░')
  expect(bar(0, 4)).toBe('░░░░')
  expect(bar(140, 4)).toBe('████')
})

test('with automatic sizing the texts ask for between 1 and N', async () => {
  const fleet = { isEnabled: true, models: ['sonnet', 'sonnet', 'opus'], isAutoSize: true } as const
  expect(promptReminder({ ...fleet, models: [...fleet.models] })).toContain(
    'between 1 and 3 job briefs',
  )
  expect(
    promptReminder({
      ...fleet,
      models: [...fleet.models],
      planner: { isEnabled: false, model: 'opus' },
    }),
  ).toContain('between 1 and 3 subtasks')
})

test('the reviewer is asked for last, and runs on its own model without a slot', async ($, on) => {
  mock.store(on)
  mock.clock(on)
  const models: (string | undefined)[] = []
  on(
    'agent.spawn',
    (_$, e) => (models.push(e.model), { model: e.model ?? 'parent', agentId: `a${models.length}` }),
  )

  await $.command.run({ command: 'fleet', args: '1 haiku' } as never)
  await $.command.run({ command: 'fleet', args: 'planner off' } as never)
  await $.command.run({ command: 'fleet', args: 'reviewer sonnet' } as never)
  const worker = await $.agent.spawn({ prompt: 'w', description: 'w' } as never)
  const reviewer = await $.agent.spawn({
    prompt: 'draft',
    description: 'r',
    subagentType: REVIEWER_TYPE,
  } as never)

  expect(worker.model).toBe('haiku')
  expect(reviewer.model).toBe('sonnet')
  expect(reviewer.deny).toBeUndefined()
})

test('a worker reports progress through the fleet tool', async ($, on) => {
  mock.store(on)
  mock.clock(on)
  on('agent.spawn', () => ({ model: 'm', agentId: 'agent-r' }))
  await $.command.run({ command: 'fleet', args: '1 haiku' } as never)
  await $.agent.spawn({ prompt: 'w', description: 'w' } as never)

  const answer = await $.tool.call({
    tool: 'mcp__agent-fleet__progress',
    agentId: 'agent-r',
    done: 1,
    total: 3,
    step: 'drafting',
  } as never)
  expect((answer as { result?: unknown }).result).toBe('Progress recorded.')
})

test('/fleet stop stops each running agent through TaskStop', async ($, on) => {
  mock.store(on)
  mock.clock(on)
  const stopped: string[] = []
  on('agent.spawn', () => ({ model: 'm', agentId: `agent-${stopped.length}-${Math.random()}` }))
  on('tool.call', { tool: 'TaskStop' }, (_$, e) => {
    stopped.push(String((e as { task_id?: string }).task_id))
    return { result: 'stopped' }
  })
  await $.command.run({ command: 'fleet', args: '2 haiku' } as never)
  const a = await $.agent.spawn({ prompt: 'a', description: 'a' } as never)
  const b = await $.agent.spawn({ prompt: 'b', description: 'b' } as never)

  const answer = await $.command.run({ command: 'fleet', args: 'stop' } as never)

  expect(answer.text).toBe('Stopped the running fleet agents.')
  expect(stopped.sort()).toEqual([a.agentId, b.agentId].sort())
})

test('the pane draws on every surface with a colour scheme', async ($, on) => {
  mock.store(on)
  mock.clock(on)
  await $.command.run({ command: 'fleet', args: 'theme navy' } as never)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'agent-fleet',
      surface,
      component: 'Pane',
      requestId: 'agent-fleet',
      props: { bodyColumns: 90 },
      viewport: { columns: 120, rows: 40 },
    } as never)
    expect((await ui.find({ key: 'theme' }))?.text).toContain('navy')
    await ui.press({ key: 'theme' })
    expect((await ui.find({ key: 'theme' }))?.text).toContain('slate')
    await ui.unmount()
    await $.command.run({ command: 'fleet', args: 'theme navy' } as never)
  }
})

test("a planner brief's title and goal become the agent's task line", async () => {
  const brief = [
    '## Job 2: Policy, third-party risk, audit and findings chapters',
    '',
    '**Goal.** Write chapters 4.4, 4.5, 4.6 and 4.7 of a standalone specification. Do not research.',
  ].join('\n')
  expect(taskOf(brief)).toBe(
    'Policy, third-party risk, audit and findings chapters: Write chapters 4.4, 4.5, 4.6 and 4.7 of a standalone specification.',
  )
  expect(taskOf('Read README.md and summarise it. Then stop.')).toBe(
    'Read README.md and summarise it.',
  )
})

test('/fleet lists every parameter, and navy is the default colour scheme', async ($, on) => {
  mock.store(on)
  mock.clock(on)
  const help = await $.command.run({ command: 'fleet', args: 'help' } as never)
  for (const word of ['planner', 'reviewer', 'auto', 'theme', 'stop', 'clear']) {
    expect(help.text).toContain(`/fleet ${word}`)
  }
  expect(themeOf({ isEnabled: true, models: ['opus'] }).label).toBe('navy')
})

// ---- waves, slots, budget, project switch, worktrees ----

test('a planner answer gives jobs with their dependencies, in waves', async () => {
  const jobs = jobsOf(
    [
      '## Plan',
      'x',
      '## Job 1: Schema',
      '## Job 2: API (after 1)',
      '## Job 3: UI (after 1, 2)',
      '## Job 4: Docs',
    ].join('\n'),
  )
  expect(jobs).toEqual([
    { n: 1, title: 'Schema', after: [] },
    { n: 2, title: 'API', after: [1] },
    { n: 3, title: 'UI', after: [1, 2] },
    { n: 4, title: 'Docs', after: [] },
  ])
  const waves = wavesOf(jobs)
  expect([waves.get(1), waves.get(2), waves.get(3), waves.get(4)]).toEqual([1, 2, 3, 1])
  expect(jobOfPrompt('## Job 3: UI (after 1, 2)\n\nGoal…')).toBe(3)
  expect(taskOf('## Job 2: API (after 1)\n\n**Goal.** Build the endpoints. More.')).toBe(
    'API: Build the endpoints.',
  )
})

test('budget levels warn at 80% and stop at the limit', async () => {
  expect(budgetLevel(3, 5)).toBe(0)
  expect(budgetLevel(4, 5)).toBe(1)
  expect(budgetLevel(5.2, 5)).toBe(2)
  expect(budgetLevel(99, null)).toBe(0)
})

test('a worktree agent may not write outside its worktree or touch branches', async () => {
  const wt = '/home/u/.claude/fleet-worktrees/app/r1-job-1'
  const run = '/home/u/.claude/fleet-runs/app/x'
  const guard = (tool: string, input: Record<string, unknown>) =>
    worktreeGuard(tool, input, wt, '/repo', run)
  expect(guard('Edit', { file_path: `${wt}/src/a.ts` })).toBe(null)
  expect(guard('Write', { file_path: `${run}/job-1.md` })).toBe(null)
  expect(guard('Edit', { file_path: '/repo/src/a.ts' })).toContain('may not write')
  expect(guard('Write', { file_path: `${wt}/../../repo/a.ts` })).toContain('may not write')
  expect(guard('Bash', { command: 'git commit -am "x"' })).toBe(null)
  expect(guard('Bash', { command: 'cd /repo && npm test' })).toContain('may not touch')
  for (const command of [
    'git push',
    'git checkout main',
    'git reset --hard HEAD~1',
    'git stash',
    'git branch -D x',
    'git merge main',
  ]) {
    expect(guard('Bash', { command })).toContain('not allowed')
  }
})

/** Answers the session, environment and file calls a request needs in a test. */
function host(on: On, gitCalls: string[][], conflictOn?: string) {
  on('session.repo', () => ({ value: { root: '/repo', remote: null, internal: false } }) as never)
  on('session.root', () => ({ value: '/repo' }) as never)
  on('env.get', () => ({ value: '/home/u' }) as never)
  on('fs.write', () => ({ value: undefined }) as never)
  on(
    'session.usage',
    () => ({ value: { startedAt: 0, context: {}, rateLimits: [], cost: { usd: 1 } } }) as never,
  )
  on('process.run', (_$, e) => {
    const argv = (e as { argv: string[] }).argv
    gitCalls.push(argv)
    const sub = argv.slice(1).join(' ')
    const ok = (stdout = '') => ({
      value: {
        exitCode: 0,
        stdout,
        stderr: '',
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    })
    const fail = (stderr = 'failed') => ({
      value: {
        exitCode: 1,
        stdout: '',
        stderr,
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    })
    if (sub === 'rev-parse HEAD') return ok('abc123\n') as never
    if (sub === 'rev-parse --abbrev-ref HEAD') return ok('main\n') as never
    if (sub.startsWith('rev-parse -q --verify MERGE_HEAD')) return fail() as never
    if (sub.startsWith('rev-list --count')) return ok('2\n') as never
    if (sub.startsWith('merge-base --is-ancestor')) return fail() as never
    if (sub.startsWith('merge --no-ff') && conflictOn && sub.endsWith(conflictOn))
      return fail('CONFLICT') as never
    if (sub.startsWith('diff --name-only')) return ok('src/a.ts\n') as never
    return ok() as never
  })
}

const composer = (text: string) => ({ text, origin: { kind: 'composer' }, wait: false }) as never

test('jobs take their own slot, and a later wave waits for the jobs it needs', async ($, on) => {
  mock.store(on)
  mock.clock(on)
  host(on, [])
  let n = 0
  on('agent.spawn', (_$, e) => ({ model: e.model ?? 'parent', agentId: `a${++n}` }))
  on('turn.complete', (_$, e) => ({ text: (e as { answer: string }).answer }))
  on('prompt.submit', (_$, e) => e as never)
  await $.command.run({ command: 'fleet', args: '3 sonnet haiku opus' } as never)
  await $.prompt.submit(composer('Build the feature'))

  const planner = await $.agent.spawn({
    prompt: 'Plan it',
    description: 'plan',
    subagentType: PLANNER_TYPE,
  } as never)
  await $.turn.complete({
    answer: '## Job 1: Schema\n## Job 2: API (after 1)\n## Job 3: UI',
    agentId: planner.agentId,
    reason: 'answer',
    durationMs: 1,
    isAborted: false,
    turnId: 't',
  } as never)

  const early = await $.agent.spawn({
    prompt: '## Job 2: API (after 1)\nGoal.',
    description: 'api',
  } as never)
  expect(early.deny).toContain('runs after job 1')
  const ui = await $.agent.spawn({ prompt: '## Job 3: UI\nGoal.', description: 'ui' } as never)
  expect(ui.model).toBe('opus')
  const schema = await $.agent.spawn({
    prompt: '## Job 1: Schema\nGoal.',
    description: 'schema',
  } as never)
  expect(schema.model).toBe('sonnet')
  await $.turn.complete({
    answer: 'done',
    agentId: schema.agentId,
    reason: 'answer',
    durationMs: 1,
    isAborted: false,
    turnId: 't',
  } as never)
  const api = await $.agent.spawn({
    prompt: '## Job 2: API (after 1)\nGoal.',
    description: 'api',
  } as never)
  expect(api.model).toBe('haiku')
})

test('/fleet use off switches the fleet off for this project only', async ($, on) => {
  mock.store(on)
  mock.clock(on)
  host(on, [])
  on('agent.spawn', (_$, e) => ({ model: e.model ?? 'parent', agentId: 'x' }))
  await $.command.run({ command: 'fleet', args: '1 haiku' } as never)
  const off = await $.command.run({ command: 'fleet', args: 'use off' } as never)
  expect(off.text).toContain('off for /repo')
  const spawned = await $.agent.spawn({ prompt: 'p', description: 'd' } as never)
  expect(spawned.model).toBe('parent')
  await $.command.run({ command: 'fleet', args: 'use on' } as never)
  const again = await $.agent.spawn({ prompt: 'p', description: 'd2' } as never)
  expect(again.model).toBe('haiku')
})

test('worktrees: each worker gets one, merges stop at the first conflict and nothing is forced', async ($, on) => {
  mock.store(on)
  mock.clock(on)
  const gitCalls: string[][] = []
  host(on, gitCalls, 'fleet/r0/job-2')
  let n = 0
  const cwds: (string | undefined)[] = []
  on(
    'agent.spawn',
    (_$, e) => (cwds.push(e.cwd), { model: e.model ?? 'parent', agentId: `w${++n}` }),
  )
  on('turn.complete', (_$, e) => ({ text: (e as { answer: string }).answer }))
  on('prompt.submit', (_$, e) => e as never)
  await $.command.run({ command: 'fleet', args: '2 sonnet' } as never)
  await $.command.run({ command: 'fleet', args: 'planner off' } as never)
  await $.command.run({ command: 'fleet', args: 'worktrees on' } as never)
  await $.prompt.submit(composer('Change the code'))

  const one = await $.agent.spawn({ prompt: '## Job 1: A\nGoal.', description: 'a' } as never)
  const two = await $.agent.spawn({ prompt: '## Job 2: B\nGoal.', description: 'b' } as never)
  expect(cwds[0]).toBe('/home/u/.claude/fleet-worktrees/repo/r0-job-1')
  expect(cwds[1]).toBe('/home/u/.claude/fleet-worktrees/repo/r0-job-2')
  for (const agent of [one, two]) {
    await $.turn.complete({
      answer: 'ok',
      agentId: agent.agentId,
      reason: 'answer',
      durationMs: 1,
      isAborted: false,
      turnId: 't',
    } as never)
  }

  const merged = await $.command.run({ command: 'fleet', args: 'merge' } as never)
  expect(merged.text).toContain('✓ job 1: merged')
  expect(merged.text).toContain('✗ job 2 conflicts')
  expect(merged.text).toContain('src/a.ts')
  const flat = gitCalls.map(argv => argv.join(' '))
  expect(flat).toContain('git merge --abort')
  expect(
    flat.some(c => c.includes('--force') || c.includes('branch -D') || c.includes('stash')),
  ).toBe(false)
  const list = await $.command.run({ command: 'fleet', args: 'worktrees' } as never)
  expect(list.text).toContain('CONFLICT')
})

test('the pane buttons switch worktrees and the project on and off', async ($, on) => {
  mock.store(on)
  mock.clock(on)
  host(on, [])
  on('ui.toast', () => ({ value: undefined }) as never)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'agent-fleet',
      surface,
      component: 'Pane',
      requestId: 'agent-fleet',
      props: { bodyColumns: 100 },
      viewport: { columns: 140, rows: 50 },
    } as never)
    expect((await ui.find({ key: 'worktrees' }))?.text).toContain('off')
    await ui.press({ key: 'worktrees' })
    expect((await ui.find({ key: 'worktrees' }))?.text).toContain('on')
    await ui.press({ key: 'worktrees' })
    expect((await ui.find({ key: 'worktrees' }))?.text).toContain('off')
    expect((await ui.find({ key: 'project' }))?.text).toContain('on')
    await ui.press({ key: 'project' })
    expect((await ui.find({ key: 'project' }))?.text).toContain('off')
    await ui.press({ key: 'project' })
    await ui.unmount()
  }
})

test('budget "stop": at the limit the request stops and no further agent starts', async ($, on) => {
  mock.store(on)
  mock.clock(on)
  let usd = 1
  on(
    'session.usage',
    () => ({ value: { startedAt: 0, context: {}, rateLimits: [], cost: { usd } } }) as never,
  )
  on('session.repo', () => ({ value: null }) as never)
  on('session.root', () => ({ value: '/repo' }) as never)
  on('env.get', () => ({ value: '/home/u' }) as never)
  on('fs.write', () => ({ value: undefined }) as never)
  on('ui.toast', () => ({ value: undefined }) as never)
  on('prompt.submit', (_$, e) => e as never)
  const stopped: string[] = []
  on('tool.call', { tool: 'TaskStop' }, (_$, e) => {
    stopped.push(String((e as { task_id?: string }).task_id))
    return { result: 'stopped' }
  })
  let n = 0
  on('agent.spawn', (_$, e) => ({ model: e.model ?? 'parent', agentId: `b${++n}` }))
  await $.command.run({ command: 'fleet', args: '2 haiku' } as never)
  await $.command.run({ command: 'fleet', args: 'planner off' } as never)
  await $.command.run({ command: 'fleet', args: 'budget 0.5' } as never)
  await $.command.run({ command: 'fleet', args: 'budget stop' } as never)
  await $.prompt.submit(composer('Do the work'))

  const first = await $.agent.spawn({ prompt: 'a', description: 'a' } as never)
  expect(first.deny).toBeUndefined()
  usd = 1.6 // the request has now cost $0.60
  const second = await $.agent.spawn({ prompt: 'b', description: 'b' } as never)
  expect(second.deny).toContain('budget of $0.50')
  expect(stopped).toEqual([first.agentId])

  await $.prompt.submit(composer('Next request'))
  const fresh = await $.agent.spawn({ prompt: 'c', description: 'c' } as never)
  expect(fresh.deny).toBeUndefined()
})

test('reaching the budget leaves a transcript line and tells Claude why', async ($, on) => {
  mock.store(on)
  mock.clock(on)
  let usd = 1
  const logs: string[] = []
  const notes: string[] = []
  on(
    'session.usage',
    () => ({ value: { startedAt: 0, context: {}, rateLimits: [], cost: { usd } } }) as never,
  )
  on('session.repo', () => ({ value: null }) as never)
  on('session.root', () => ({ value: '/repo' }) as never)
  on('env.get', () => ({ value: '/home/u' }) as never)
  on('fs.write', () => ({ value: undefined }) as never)
  on('ui.toast', () => ({ value: undefined }) as never)
  on(
    'ui.log',
    (_$, e) =>
      (logs.push(String((e as { text?: string }).text ?? '')), { value: undefined }) as never,
  )
  on('session.append', (_$, e, next) => {
    const content = (e as unknown as { message: { content: { text: string }[] } }).message.content
    notes.push(content.map(block => block.text).join(''))
    return next(e)
  })
  on('prompt.submit', (_$, e) => e as never)
  on('tool.call', { tool: 'TaskStop' }, () => ({ result: 'stopped' }))
  on('agent.spawn', (_$, e) => ({ model: e.model ?? 'parent', agentId: 'z1' }))
  await $.command.run({ command: 'fleet', args: '1 haiku' } as never)
  await $.command.run({ command: 'fleet', args: 'planner off' } as never)
  await $.command.run({ command: 'fleet', args: 'budget 0.5' } as never)
  await $.command.run({ command: 'fleet', args: 'budget stop' } as never)
  await $.prompt.submit(composer('Work'))
  await $.agent.spawn({ prompt: 'a', description: 'a' } as never)
  usd = 1.7
  const refused = await $.agent.spawn({ prompt: 'b', description: 'b' } as never)

  expect(refused.deny).toContain('spent')
  expect(
    logs.some(line => line.includes('reached its $0.50 budget ($0.70 used) and was stopped')),
  ).toBe(true)
  expect(notes.some(note => note.includes('Do not relaunch'))).toBe(true)
})

test('a finished request goes into the history and announces itself', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  const played: string[] = []
  const banners: string[] = []
  const logs: string[] = []
  on(
    'session.usage',
    () => ({ value: { startedAt: 0, context: {}, rateLimits: [], cost: { usd: 1 } } }) as never,
  )
  on('session.repo', () => ({ value: { root: '/repo', remote: null, internal: false } }) as never)
  on('session.root', () => ({ value: '/repo' }) as never)
  on('env.get', () => ({ value: '/home/u' }) as never)
  on('fs.write', () => ({ value: undefined }) as never)
  on(
    'ui.log',
    (_$, e) => (logs.push(String((e as { text?: string }).text)), { value: undefined }) as never,
  )
  on(
    'audio.play',
    (_$, e) =>
      (played.push(String((e as unknown as { clip: { asset?: string } }).clip.asset)),
      { value: undefined }) as never,
  )
  on('process.run', (_$, e) => {
    const argv = (e as { argv: string[] }).argv
    if (argv[0] === 'osascript') banners.push(argv[2] ?? '')
    return {
      value: {
        exitCode: 0,
        stdout: '',
        stderr: '',
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    } as never
  })
  on('prompt.submit', (_$, e) => e as never)
  on('turn.complete', (_$, e) => ({ text: (e as { answer: string }).answer }))
  on('agent.spawn', (_$, e) => ({ model: e.model ?? 'parent', agentId: 'h1' }))
  await $.command.run({ command: 'fleet', args: '1 haiku' } as never)
  await $.command.run({ command: 'fleet', args: 'planner off' } as never)
  await $.prompt.submit(composer('Write the report'))
  const agent = await $.agent.spawn({ prompt: 'a', description: 'a' } as never)
  await clock.advance(45_000)
  await $.turn.complete({
    answer: 'ok',
    agentId: agent.agentId,
    reason: 'answer',
    durationMs: 1,
    isAborted: false,
    turnId: 't',
  } as never)
  await $.turn.complete({
    answer: 'done',
    reason: 'answer',
    durationMs: 1,
    isAborted: false,
    turnId: 'm',
  } as never)

  expect(played).toEqual(['fx/done.wav'])
  expect(banners[0]).toContain('Write the report')
  expect(logs.some(line => line.includes('"Write the report" finished'))).toBe(true)
  const past = await $.command.run({ command: 'fleet', args: 'history' } as never)
  expect(past.text).toContain('Write the report')
  expect(past.text).toContain('/home/u/.claude/fleet-runs/repo/')

  await $.command.run({ command: 'fleet', args: 'notify off' } as never)
  await $.prompt.submit(composer('Second report'))
  const again = await $.agent.spawn({ prompt: 'b', description: 'b' } as never)
  await clock.advance(45_000)
  await $.turn.complete({
    answer: 'ok',
    agentId: again.agentId,
    reason: 'answer',
    durationMs: 1,
    isAborted: false,
    turnId: 't2',
  } as never)
  await $.turn.complete({
    answer: 'done',
    reason: 'answer',
    durationMs: 1,
    isAborted: false,
    turnId: 'm2',
  } as never)
  expect(played).toEqual(['fx/done.wav'])
})

test("the planner's deliverable line and the designer's upload guard", async () => {
  expect(deliverableOf('## Plan\nx\n## Deliverable: slides\nA deck for the board')).toBe('slides')
  expect(deliverableOf('## Deliverable: **Report** for the CISO')).toBe('report')
  expect(deliverableOf('no line')).toBe(null)
  expect(designerGuard('Artifact')).toContain('local files only')
  expect(designerGuard('mcp__claude_ai_Claude_Docs__batch')).toContain('refused')
  expect(designerGuard('DesignSync')).toContain('refused')
  expect(designerGuard('Write')).toBe(null)
  expect(designerGuard('Skill')).toBe(null)
})

test('the designer runs on its own model, writes to the run folder and may not upload', async ($, on) => {
  mock.store(on)
  mock.clock(on)
  host(on, [])
  const prompts: string[] = []
  let n = 0
  on(
    'agent.spawn',
    (_$, e) => (prompts.push(e.prompt), { model: e.model ?? 'parent', agentId: `d${++n}` }),
  )
  on('turn.complete', (_$, e) => ({ text: (e as { answer: string }).answer }))
  on('prompt.submit', (_$, e) => e as never)
  on('tool.call', (_$, e) => ({ result: `ran ${String((e as { tool: string }).tool)}` }) as never)
  await $.command.run({ command: 'fleet', args: '1 haiku' } as never)
  await $.command.run({ command: 'fleet', args: 'designer sonnet' } as never)
  await $.prompt.submit(composer('Make a board deck'))

  const planner = await $.agent.spawn({
    prompt: 'Plan',
    description: 'plan',
    subagentType: PLANNER_TYPE,
  } as never)
  await $.turn.complete({
    answer: '## Plan\nx\n## Deliverable: slides\n## Job 1: Content',
    agentId: planner.agentId,
    reason: 'answer',
    durationMs: 1,
    isAborted: false,
    turnId: 't',
  } as never)
  const designer = await $.agent.spawn({
    prompt: 'Polish /tmp/combined.md',
    description: 'deck',
    subagentType: DESIGNER_TYPE,
  } as never)

  expect(designer.model).toBe('sonnet')
  expect(prompts.at(-1)).toContain('Deliverable type named by the planner: slides.')
  expect(prompts.at(-1)).toContain('/home/u/.claude/fleet-runs/repo/')
  expect(prompts.at(-1)).toContain('/design')
  const upload = await $.tool.call({
    tool: 'Artifact',
    agentId: designer.agentId,
    action: 'publish',
  } as never)
  expect((upload as { deny?: string }).deny).toContain('local files only')
  const write = await $.tool.call({
    tool: 'Write',
    agentId: designer.agentId,
    file_path: '/x/a.md',
    content: 'x',
  } as never)
  expect((write as { deny?: string }).deny).toBeUndefined()
})

test('a pasted-content marker never becomes the title', async () => {
  expect(
    titleOf('<pasted_content id="1846">\nCreate a 10-slide board deck\n</pasted_content>'),
  ).toBe('Create a 10-slide board deck')
  expect(titleOf('Plain request')).toBe('Plain request')
})

test('pause stops an agent at its next tool call, keeps the request open, and resume wakes it', async ($, on) => {
  mock.store(on)
  mock.clock(on)
  host(on, [])
  const stops: string[] = []
  const messages: { to: string; message: string }[] = []
  const notes: string[] = []
  let sendFails = false
  on('ui.toast', () => ({ value: undefined }) as never)
  on('ui.log', () => ({ value: undefined }) as never)
  on('session.append', (_$, e, next) => {
    const content = (e as unknown as { message: { content: { text: string }[] } }).message.content
    notes.push(content.map(block => block.text).join(''))
    return next(e)
  })
  on('tool.call', (_$, e) => {
    const call = e as unknown as { tool: string; task_id?: string; to?: string; message?: string }
    if (call.tool === 'TaskStop') stops.push(String(call.task_id))
    if (call.tool === 'SendMessage') {
      if (sendFails) return { deny: 'no such agent' } as never
      messages.push({ to: String(call.to), message: String(call.message) })
    }
    return { result: `ran ${call.tool}` } as never
  })
  on('prompt.submit', (_$, e) => e as never)
  on('turn.complete', (_$, e) => ({ text: (e as { answer: string }).answer }))
  const spawned: string[] = []
  on(
    'agent.spawn',
    (_$, e) => (
      spawned.push(e.description),
      { model: e.model ?? 'parent', agentId: `p${spawned.length}` }
    ),
  )
  await $.command.run({ command: 'fleet', args: '1 haiku' } as never)
  await $.command.run({ command: 'fleet', args: 'planner off' } as never)
  await $.prompt.submit(composer('Long task'))
  const agent = await $.agent.spawn({ prompt: 'work', description: 'worker' } as never)

  // The pause takes effect at the next tool call, not before.
  const paused = await $.command.run({ command: 'fleet', args: 'pause' } as never)
  expect(paused.text).toContain('pause at their next tool call')
  expect(stops).toEqual([])
  const refused = await $.tool.call({
    tool: 'Read',
    agentId: agent.agentId,
    file_path: '/x',
  } as never)
  expect((refused as { deny?: string }).deny).toContain('Paused by the user')
  expect(stops).toEqual([agent.agentId])
  expect(notes.some(note => note.includes('Do not relaunch it'))).toBe(true)

  // The stop ends the agent's turn as aborted; it stays paused and the request stays open.
  await $.turn.complete({
    answer: '',
    agentId: agent.agentId,
    reason: 'aborted',
    durationMs: 1,
    isAborted: true,
    turnId: 't',
  } as never)
  await $.turn.complete({
    answer: 'waiting',
    reason: 'answer',
    durationMs: 1,
    isAborted: false,
    turnId: 'm',
  } as never)
  const resumed = await $.command.run({ command: 'fleet', args: 'resume' } as never)
  expect(resumed.text).toBe('Resumed 1 agent(s).')
  expect(messages[0]?.to).toBe(agent.agentId)
  expect(messages[0]?.message).toContain('Resume your task')

  // When the agent cannot be woken, it is started again with its brief.
  await $.command.run({ command: 'fleet', args: 'pause' } as never)
  await $.tool.call({ tool: 'Read', agentId: agent.agentId, file_path: '/y' } as never)
  sendFails = true
  await $.command.run({ command: 'fleet', args: 'resume' } as never)
  expect(spawned.at(-1)).toBe('worker (rerun)')
})
