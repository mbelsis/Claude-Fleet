// The fleet's pure logic: texts, parsing and arithmetic. Nothing here touches `$`.
import type {
  FleetJob,
  FleetLead,
  FleetModel,
  FleetPlan,
  FleetProgress,
  FleetRequest,
  FleetRole,
  FleetRun,
  FleetSteps,
} from '../types'

/** Shown in the pane's footer; kept in step with .claude-plugin/plugin.json. */
export const VERSION = '0.6.0'
export const COPYRIGHT = '© Belsis Meletis'

export const MODELS: FleetModel[] = ['inherit', 'opus', 'sonnet', 'haiku', 'fable']
export const LEAD_MODELS: FleetModel[] = ['opus', 'fable', 'sonnet', 'inherit']
export const MAX_AGENTS = 10

/** The lead agents' types as the Agent tool names them: `<plugin>:<name>`. */
export const PLANNER_TYPE = 'agent-fleet:planner'
export const REVIEWER_TYPE = 'agent-fleet:reviewer'
export const DESIGNER_TYPE = 'agent-fleet:designer'
/** The progress tool as a subagent calls it: `mcp__<plugin>__<name>`. */
export const PROGRESS_TOOL = 'mcp__agent-fleet__progress'

// `opus` is an alias, so a lead always runs on the newest Opus this build knows.
const DEFAULT_PLANNER: FleetLead = { isEnabled: true, model: 'opus' }
const DEFAULT_REVIEWER: FleetLead = { isEnabled: false, model: 'opus' }
const DEFAULT_DESIGNER: FleetLead = { isEnabled: false, model: 'opus' }

export const plannerOf = (fleet: FleetPlan): FleetLead => fleet.planner ?? DEFAULT_PLANNER
export const reviewerOf = (fleet: FleetPlan): FleetLead => fleet.reviewer ?? DEFAULT_REVIEWER
export const designerOf = (fleet: FleetPlan): FleetLead => fleet.designer ?? DEFAULT_DESIGNER
export const isFileHandoffOn = (fleet: FleetPlan): boolean => fleet.isFileHandoff !== false
export const isWorktreesOn = (fleet: FleetPlan): boolean => fleet.isWorktrees === true

/** Background and text colours of the pane; `default` leaves both to the theme. */
export const THEMES: Record<string, { label: string; bg?: string; text: string }> = {
  default: { label: 'theme', text: 'text' },
  dark: { label: 'dark', bg: '#1e1f22', text: '#e6e6e6' },
  navy: { label: 'navy', bg: '#0f1b2d', text: '#e6edf7' },
  slate: { label: 'slate', bg: '#2b303b', text: '#eceff4' },
  forest: { label: 'forest', bg: '#14251c', text: '#e3efe6' },
  light: { label: 'light', bg: '#f6f6f3', text: '#1f2328' },
  paper: { label: 'paper', bg: '#fdf6e3', text: '#3b3a36' },
}
export const THEME_KEYS = Object.keys(THEMES)
/** Navy unless the person picked another scheme. */
export const DEFAULT_THEME = 'navy'
export const themeOf = (fleet: FleetPlan) =>
  THEMES[fleet.theme ?? DEFAULT_THEME] ?? THEMES[DEFAULT_THEME]!

export const isModel = (word: string): word is FleetModel => (MODELS as string[]).includes(word)

/** `/fleet 3 opus sonnet haiku`: a count, then one model per agent (or one for all). */
export function parsePlan(args: string, current: FleetPlan): FleetPlan | string {
  const words = args.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const count = Number(words[0])
  if (!Number.isInteger(count) || count < 1 || count > MAX_AGENTS) {
    return `Give a number of agents from 1 to ${MAX_AGENTS}, e.g. /fleet 3 opus sonnet haiku`
  }
  const given = words.slice(1)
  const unknown = given.find(word => !isModel(word))
  if (unknown !== undefined) {
    return `Unknown model "${unknown}". Use one of: ${MODELS.join(', ')}`
  }
  const models = Array.from({ length: count }, (_, i): FleetModel => {
    const word = given.length === 1 ? given[0] : given[i]
    return word !== undefined && isModel(word) ? word : (current.models[i] ?? 'inherit')
  })
  return { ...current, isEnabled: true, models }
}

export const modelLabel = (model: FleetModel): string =>
  model === 'inherit' ? 'same as main' : model

const slotLines = (fleet: FleetPlan): string[] =>
  fleet.models.map(
    (model, i) => `- Agent ${i + 1}: ${model === 'inherit' ? 'same model as you' : model}`,
  )
export { slotLines }

/** "exactly 4" or "between 1 and 4": how many workers a request gets. */
const workerCount = (fleet: FleetPlan): string =>
  fleet.isAutoSize && fleet.models.length > 1
    ? `between 1 and ${fleet.models.length}`
    : `exactly ${fleet.models.length}`

const reviewStep = (fleet: FleetPlan): string[] =>
  reviewerOf(fleet).isEnabled
    ? [
        `Last step: launch ONE Agent call with subagent_type "${REVIEWER_TYPE}" whose prompt ` +
          "is your combined draft (or its file path) followed by every worker's notes on " +
          'unverified or conflicting points. Give the user its corrected version and its list ' +
          'of changes.',
      ]
    : []

const designStep = (fleet: FleetPlan): string[] =>
  designerOf(fleet).isEnabled
    ? [
        `Design step (after any review): launch ONE Agent call with subagent_type "${DESIGNER_TYPE}" ` +
          'whose prompt names the final result (its file path, or the text itself), the ' +
          'deliverable type (report, slides, website, code or data) and who it is for. Give the ' +
          'user the file paths it reports and its list of changes. It writes local files only.',
      ]
    : []

const fileStep = (runDir: string | null | undefined): string[] =>
  runDir
    ? [
        `Workers write their results to files in ${runDir}; read them from there to combine. ` +
          `Write a long combined result to ${runDir}/combined.md and give the user its path.`,
      ]
    : []

const plannerSteps = (fleet: FleetPlan): string[] => {
  if (!plannerOf(fleet).isEnabled) return []
  const jobs = fleet.isAutoSize
    ? `between 1 and ${fleet.models.length} job briefs (it decides how many)`
    : `exactly ${fleet.models.length} job briefs`
  return [
    `Step 1: launch ONE Agent call with subagent_type "${PLANNER_TYPE}" whose prompt is the ` +
      "user's request in full, with any context from this conversation it needs. It plans and " +
      `returns ${jobs} ("## Job 1" …). Wait for it.`,
    'Step 2: launch the workers wave by wave. Jobs whose heading has no "(after …)" form the ' +
      'first wave: launch them together in one message. When every job a later job waits for ' +
      "has returned, launch that job. Each worker gets its job's brief word for word, starting " +
      'with its "## Job N: …" heading line, which tells the fleet which job it is. Then combine ' +
      'their results as the plan\'s "How to combine" says.',
  ]
}

export function planText(fleet: FleetPlan): string {
  const count = workerCount(fleet)
  const planner = plannerOf(fleet)
  return [
    '# Agent fleet (set by the user)',
    'This section applies to the main conversation only. If you are a subagent, ignore it.',
    `The user has asked that every task they give you is broken into ${count} ` +
      `subtasks and handed to ${count} worker subagents with the Agent tool. Models are ` +
      'assigned automatically (Job N goes to Agent N), so do not set the `model` parameter:',
    ...slotLines(fleet),
    ...(planner.isEnabled
      ? [
          `A lead planner (${modelLabel(planner.model)}) does the thinking first and does not ` +
            'take a worker slot.',
          ...plannerSteps(fleet),
        ]
      : [
          'Split along real seams (separate parts, files, questions or sections) so the ' +
            'subagents do not repeat each other, give each one a self-contained prompt, launch ' +
            'them together, and put the hardest part first if slot 1 has the strongest model. ' +
            'Then combine their results for the user.',
        ]),
    ...reviewStep(fleet),
    ...designStep(fleet),
    ...(isWorktreesOn(fleet)
      ? [
          'Worktrees are on: each worker edits its own git worktree and branch. Do not merge ' +
            'them yourself; the user merges with /fleet merge, which stops on any conflict.',
        ]
      : []),
    'Launching more workers than this per request is refused. Exempt: a question you can ' +
      'answer directly with no work, and requests to change the agent fleet itself.',
  ].join('\n')
}

/** Attached beside each prompt the user types, where it is hardest to overlook. */
export function promptReminder(fleet: FleetPlan, runDir?: string | null): string {
  const count = fleet.models.length
  const planner = plannerOf(fleet)
  const head = planner.isEnabled
    ? `Agent fleet is ON with a lead planner: this request is planned first, then split into ` +
      `${workerCount(fleet)} worker subtasks. Workers (no \`model\` parameter; assigned in order):`
    : fleet.isAutoSize && count > 1
      ? `Agent fleet is ON: break this request into between 1 and ${count} subtasks (as many as ` +
        'it really divides into) and launch them together in your next message (no `model` ' +
        'parameter; the models are assigned in order):'
      : `Agent fleet is ON: break this request into exactly ${count} subtasks and launch ` +
        `${count} Agent calls together in your next message (no \`model\` parameter; the ` +
        'models are assigned in order):'
  return [
    head,
    ...slotLines(fleet),
    ...(planner.isEnabled ? plannerSteps(fleet) : ['Then combine their results.']),
    ...fileStep(isFileHandoffOn(fleet) ? runDir : null),
    ...reviewStep(fleet),
    ...designStep(fleet),
    'Skip this only if the message needs no work, or asks to change the agent fleet itself.',
  ].join('\n')
}

export const PLANNER_PROMPT = [
  'You are the lead planner of an agent fleet. You do the thinking; workers do the doing.',
  'You receive a task and the list of worker slots, each with its model. Think the task ',
  'through: what the result must contain, how it divides into parts, and which part is ',
  'hardest. If the task concerns files, a codebase or facts you need to check, look them up ',
  'first (read-only: never create, edit or delete files, and run only commands that change ',
  'nothing).',
  '',
  'Then answer with one job per worker, in slot order, in this format:',
  '',
  '## Plan',
  'Two or three sentences: the approach and how the parts fit together.',
  '',
  '## Deliverable: <report | slides | website | code | data>',
  'One line: what the user should end up with, and for whom.',
  '',
  '## Job 1: <short title>',
  'A self-contained brief the worker can act on without seeing anything else: the goal, the ',
  'inputs and file paths, constraints, what not to do, and exactly what to return (format and ',
  'length). Workers cannot see the task, your plan or each other. Ask each worker to end with ',
  'a short "Unverified or conflicting" list.',
  '',
  '## Job 2: <short title> (after 1)',
  'A job that needs another job\'s result names it in its heading: "(after 1)" or "(after 1, 3)". ',
  "It then runs in a later wave and receives that job's result file. Use this only where a job ",
  "genuinely cannot start without another's output; independent jobs run in parallel and are ",
  'faster.',
  '',
  '(…one "## Job N" section per worker…)',
  '',
  '## How to combine',
  "How the main session should merge the workers' results into the final answer.",
  '',
  'Rules: jobs must not overlap; give the hardest job to the strongest model in the slot list. ',
  'The slot message says how many jobs to write: exactly the number of slots, or, when it lets ',
  'you choose, as many as the task really divides into (one is fine for a small task). Return ',
  'only the plan.',
].join('\n')

export const REVIEWER_PROMPT = [
  'You are the reviewer of an agent fleet. You receive a combined draft that several workers ',
  'wrote in parallel (inline, or as files in the run folder named in your prompt), followed by ',
  'their notes on points they could not verify or found conflicting. Your job is to make the ',
  'draft correct and consistent before the user sees it.',
  '',
  'Check every factual claim the notes flag, and any other claim that looks doubtful, against ',
  'primary sources where you can (web search, the files named). Fix contradictions between ',
  "sections, remove repetition, and keep the authors' structure and tone. Never invent a ",
  'source. Where a point stays unverified, soften it ("reportedly") or remove it. You are ',
  'read-only: never create, edit or delete files.',
  '',
  'Answer with:',
  '## Corrected version',
  '(the full corrected text; for a draft too long to return, a numbered list of exact edits,',
  'each as FIND: <verbatim existing text> / REPLACE: <new text>)',
  '## Changes',
  '(a short list: what you changed and why, with the source you relied on)',
  '## Still unverified',
  '(anything you could not settle)',
].join('\n')

export const DESIGNER_PROMPT = [
  'You are the designer of an agent fleet. The content is already written and reviewed; your ',
  'job is to make it look and read as well as it can, without changing what it says.',
  '',
  'Your prompt names the result (a file path or the text), the deliverable type and the ',
  'audience, and the fleet adds the folder you write into. Work by type:',
  '- report or document: restructure for the reader (an executive summary first, clear ',
  '  headings, short paragraphs, tables where they help). Write an improved Markdown copy, and ',
  '  a .docx and a .pdf built with the docx and pdf skills (load them with the Skill tool).',
  '- slides: build a .pptx with the pptx skill: one message per slide, at most six short ',
  '  bullets, a chart or table wherever there are numbers, speaker notes with the detail.',
  '- website or code with a user interface: open the pages in the browser (the claude-in-chrome ',
  '  tools) at desktop and phone widths, take screenshots, then fix layout, spacing, contrast, ',
  '  typography and accessibility in the code, and take screenshots again. Keep them in your folder.',
  '- data: add the clearest charts and a summary table; keep the raw figures unchanged.',
  '',
  'Rules: never add facts, figures or claims, and never drop content the reviewer kept. Never ',
  'overwrite the original files; write into your folder. Never upload, publish or share ',
  'anything: no artifacts, no claude.ai documents, no external services. Those tools are ',
  'refused for you. Finish by writing CHANGES.md in your folder (what you changed and why), ',
  'then reply with the list of files you produced and a three-line summary.',
].join('\n')

/** Tools that would send work off the laptop; the designer may not use them. */
export function designerGuard(tool: string): string | null {
  const isUpload =
    tool.startsWith('Artifact') ||
    tool.startsWith('mcp__claude_ai_') ||
    [
      'DesignSync',
      'ClaudeDesign',
      'SendUserFile',
      'SendFile',
      'PublishPlugin',
      'RemoteTrigger',
    ].includes(tool)
  return isUpload
    ? `Agent fleet: the designer writes local files only; ${tool} would upload or publish, so it is refused.`
    : null
}

/** The deliverable type a planner's answer names in its "## Deliverable:" line. */
export function deliverableOf(answer: string): string | null {
  const match = /^#{0,4}\s*Deliverable\s*[:\-–—]\s*\**\s*([A-Za-z]+)/im.exec(answer)
  return match ? match[1]!.toLowerCase() : null
}

/** What a worker is asked to do so its progress can be measured. */
export const PROGRESS_NOTE =
  `\n\nProgress reporting: the user watches your progress. Once you know your steps (3–6), ` +
  `call the ${PROGRESS_TOOL} tool with done 0, the total and the first step; after each step ` +
  'call it again with the steps done so far and a few words naming the next step. If that ' +
  'tool is not available, carry on without it and do not mention it.'

export function fileNote(outputPath: string, inputs: { path: string; label: string }[]): string {
  const given = inputs.length
    ? '\n\nInputs from earlier jobs (read them before you start):\n' +
      inputs.map(input => `- ${input.path} — ${input.label}`).join('\n')
    : ''
  return (
    given +
    `\n\nDelivery: write your complete result to ${outputPath} with the Write tool (for code ` +
    'changes, a summary of what you changed, where and why). Then reply with only the file ' +
    'path, one line on what it contains, and any notes your brief asks for, such as unverified ' +
    'points. Do not paste the full result into your reply.'
  )
}

export function worktreeNote(path: string, branch: string, repoRoot: string): string {
  return (
    `\n\nWorktree: you work in your own git worktree at ${path} on branch ${branch}. Every ` +
    `path in your brief that points into ${repoRoot} means the same relative path inside ` +
    `${path}. Edit files only inside ${path}; edits under ${repoRoot} are refused. Commit your ` +
    'changes to your branch with clear messages before you finish. Do not push, switch or ' +
    'create branches, rebase, reset, stash, or touch other worktrees; the user merges.'
  )
}

export const PROGRESS_SPEC = {
  name: 'progress',
  description:
    'Report your progress on the task you were given, so the user can follow it: call once ' +
    'your steps are planned (done 0) and again after each step. For subagents of the agent ' +
    'fleet; the main session never needs it.',
  inputSchema: {
    type: 'object',
    properties: {
      done: { type: 'integer', minimum: 0, description: 'Steps finished so far' },
      total: { type: 'integer', minimum: 1, description: 'Steps in your plan' },
      step: { type: 'string', description: 'A few words naming the step you are on now' },
    },
    required: ['done', 'total'],
  },
  isDeferred: false,
} as const

export function nextModel(model: FleetModel): FleetModel {
  return MODELS[(MODELS.indexOf(model) + 1) % MODELS.length] ?? 'inherit'
}

export const nextLeadModel = (model: FleetModel): FleetModel =>
  LEAD_MODELS[(LEAD_MODELS.indexOf(model) + 1) % LEAD_MODELS.length] ?? 'opus'

/** `claude-sonnet-5-5` → `sonnet 5.5`; an alias or an unknown id is shown as given. */
export function shortModel(model: string): string {
  const match = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-|$)/.exec(model)
  if (match === null) return model
  return match[3] === undefined ? `${match[1]} ${match[2]}` : `${match[1]} ${match[2]}.${match[3]}`
}

export const NO_STEPS: FleetSteps = {
  todoDone: 0,
  todoTotal: 0,
  created: 0,
  completedIds: [],
  deletedIds: [],
}

/** Folds one tool call of an agent into its step counts; other tools leave them as they are. */
export function stepsAfter(
  steps: FleetSteps,
  tool: string,
  input: Record<string, unknown>,
): FleetSteps {
  if (tool === 'TodoWrite' && Array.isArray(input.todos)) {
    const todos = input.todos as { status?: string }[]
    return {
      ...steps,
      todoDone: todos.filter(todo => todo.status === 'completed').length,
      todoTotal: todos.length,
    }
  }
  if (tool === 'TaskCreate') return { ...steps, created: steps.created + 1 }
  if (tool === 'TaskUpdate' && typeof input.taskId === 'string') {
    const id = input.taskId
    if (input.status === 'completed' && !steps.completedIds.includes(id)) {
      return { ...steps, completedIds: [...steps.completedIds, id] }
    }
    if (input.status === 'deleted' && !steps.deletedIds.includes(id)) {
      return {
        ...steps,
        completedIds: steps.completedIds.filter(done => done !== id),
        deletedIds: [...steps.deletedIds, id],
      }
    }
  }
  return steps
}

/** Reads the progress tool's input; anything malformed is ignored. */
export function progressFrom(input: Record<string, unknown>): FleetProgress | null {
  const total = Number(input.total)
  const done = Number(input.done)
  if (!Number.isFinite(total) || !Number.isFinite(done) || total < 1) return null
  const step = typeof input.step === 'string' ? input.step.slice(0, 80) : ''
  return { done: Math.max(0, Math.min(done, total)), total, step }
}

/** Completion as a whole percentage, or null while the agent has nothing to measure. */
export function percentOf(run: Pick<FleetRun, 'status' | 'steps' | 'progress'>): number | null {
  if (run.status === 'done') return 100
  if (run.progress) return Math.round((run.progress.done / run.progress.total) * 100)
  const steps = run.steps ?? NO_STEPS
  const total = steps.todoTotal + Math.max(0, steps.created - steps.deletedIds.length)
  if (total === 0) return null
  const done = steps.todoDone + steps.completedIds.length
  return Math.min(100, Math.round((done / total) * 100))
}

const JOB_HEADING = /^#{1,4}\s*Job\s+(\d+)\b\s*[:.\-–—]?\s*(.*)$/i

/** The jobs of a planner's answer, each with the jobs it waits for. */
export function jobsOf(answer: string): FleetJob[] {
  const jobs: FleetJob[] = []
  for (const line of answer.split('\n')) {
    const match = JOB_HEADING.exec(line.trim())
    if (match === null) continue
    const n = Number(match[1])
    let title = (match[2] ?? '').trim()
    const after: number[] = []
    const deps = /\((?:after|depends on|needs)\s+([^)]*)\)\s*$/i.exec(title)
    if (deps) {
      for (const found of deps[1]!.matchAll(/\d+/g)) after.push(Number(found[0]))
      title = title.slice(0, deps.index).trim()
    }
    if (!jobs.some(job => job.n === n)) jobs.push({ n, title, after })
  }
  // Dependencies on unknown jobs or on themselves are dropped.
  const known = new Set(jobs.map(job => job.n))
  return jobs.map(job => ({ ...job, after: job.after.filter(d => d !== job.n && known.has(d)) }))
}

/** Counts the "## Job N" sections of a planner's answer. */
export const jobCountOf = (answer: string): number => jobsOf(answer).length

/** Wave number (1 first) of every job; a dependency cycle puts the rest in one last wave. */
export function wavesOf(jobs: FleetJob[]): Map<number, number> {
  const wave = new Map<number, number>()
  let current = 1
  while (wave.size < jobs.length) {
    const ready = jobs.filter(
      job => !wave.has(job.n) && job.after.every(d => wave.has(d) && wave.get(d)! < current),
    )
    const placed = ready.length ? ready : jobs.filter(job => !wave.has(job.n))
    for (const job of placed) wave.set(job.n, current)
    current += 1
  }
  return wave
}

/** The job number a worker's prompt names in its first "## Job N" heading. */
export function jobOfPrompt(prompt: string): number | null {
  for (const line of prompt.split('\n').slice(0, 8)) {
    const match = JOB_HEADING.exec(line.trim())
    if (match) return Number(match[1])
  }
  return null
}

/**
 * The job an agent was given, in a line or two: a planner brief's title and goal, or the
 * prompt's first sentence. Markdown marks are dropped.
 */
export function taskOf(prompt: string): string {
  const plain = (text: string) =>
    text
      .replace(/\*\*|__|`/g, '')
      .replace(/^#+\s*/, '')
      .replace(/\s+/g, ' ')
      .trim()
  const lines = prompt
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
  const heading = lines.find(line => /^#{1,4}\s*Job\s+\d+/i.test(line))
  const title = heading
    ? plain(heading)
        .replace(/^Job\s+\d+\s*[:.\-–—]\s*/i, '')
        .replace(/\s*\((?:after|depends on|needs)[^)]*\)\s*$/i, '')
    : ''
  const goalLine = lines.find(line => /^\*{0,2}Goal\b/i.test(line))
  const body = plain(goalLine ?? lines.find(line => !line.startsWith('#')) ?? '').replace(
    /^Goal\.?\s*:?\s*/i,
    '',
  )
  const sentence = (body.match(/^.+?[.!?](\s|$)/)?.[0] ?? body).trim()
  const text = title ? `${title}: ${sentence}` : sentence
  return text.length > 220 ? `${text.slice(0, 219)}…` : text
}

export type Phase =
  'planning' | 'working' | 'paused' | 'combining' | 'reviewing' | 'designing' | 'done' | 'stopped'

/** Where a request stands, read from its agents. */
export function phaseOf(request: FleetRequest, list: FleetRun[]): Phase {
  if (request.outcome === 'stopped') return 'stopped'
  if (request.endedAt !== null) return 'done'
  const mine = list.filter(run => run.requestId === request.id)
  const isRunning = (role: FleetRole) => mine.some(r => r.role === role && r.status === 'running')
  if (!mine.some(r => r.status === 'running') && mine.some(r => r.status === 'paused'))
    return 'paused'
  if (isRunning('designer')) return 'designing'
  if (isRunning('reviewer')) return 'reviewing'
  if (isRunning('worker') || isRunning('other')) return 'working'
  if (isRunning('planner')) return 'planning'
  if (mine.some(run => run.role === 'worker')) return 'combining'
  return mine.some(run => run.role === 'planner') ? 'working' : 'planning'
}

/**
 * Overall completion of a request: the planner, each expected worker, the reviewer and the
 * final combining step are one share each; a running agent counts by its own progress.
 */
export function requestPercent(request: FleetRequest, list: FleetRun[], fleet: FleetPlan): number {
  if (request.endedAt !== null) return 100
  const mine = list.filter(run => run.requestId === request.id && !isReplaced(run, list))
  const share = (run: FleetRun | undefined): number =>
    run === undefined
      ? 0
      : run.status === 'running' || run.status === 'paused'
        ? (percentOf(run) ?? 0) / 100
        : 1
  const planners = mine.filter(run => run.role === 'planner')
  const workers = mine.filter(run => run.role === 'worker' || run.role === 'other')
  const reviewers = mine.filter(run => run.role === 'reviewer')
  const designers = mine.filter(run => run.role === 'designer')
  const hasPlanner = plannerOf(fleet).isEnabled || planners.length > 0
  const hasReviewer = reviewerOf(fleet).isEnabled || reviewers.length > 0
  const hasDesigner = designerOf(fleet).isEnabled || designers.length > 0
  const expected = Math.max(workers.length, request.expectedWorkers ?? fleet.models.length, 1)
  const total = (hasPlanner ? 1 : 0) + expected + (hasReviewer ? 1 : 0) + (hasDesigner ? 1 : 0) + 1
  const done =
    (hasPlanner ? share(planners[planners.length - 1]) : 0) +
    workers.reduce((sum, run) => sum + share(run), 0) +
    (hasReviewer ? share(reviewers[reviewers.length - 1]) : 0) +
    (hasDesigner ? share(designers[designers.length - 1]) : 0)
  return Math.min(99, Math.round((done / total) * 100))
}

/** A run a later rerun replaces no longer counts towards progress. */
export const isReplaced = (run: FleetRun, list: FleetRun[]): boolean =>
  list.some(other => other.rerunOf === run.id)

export function elapsedText(from: number, to: number): string {
  const seconds = Math.max(0, Math.round((to - from) / 1000))
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m${seconds % 60}s`
}

export const tokensText = (tokens: number): string =>
  tokens >= 1_000_000
    ? `${(tokens / 1_000_000).toFixed(1)}M tok`
    : `${Math.round(tokens / 1000)}k tok`

export const usdText = (usd: number): string =>
  usd < 10 ? `$${usd.toFixed(2)}` : `$${usd.toFixed(1)}`

export function fit(text: string, width: number): string {
  return text.length <= width ? text.padEnd(width) : `${text.slice(0, Math.max(0, width - 1))}…`
}

export function bar(percent: number, width: number): string {
  const filled = Math.round((Math.max(0, Math.min(100, percent)) / 100) * width)
  return `${'█'.repeat(filled)}${'░'.repeat(width - filled)}`
}

/** 0 under budget, 1 from 80% of it, 2 at or over it. */
export function budgetLevel(cost: number, budgetUsd: number | null | undefined): number {
  if (!budgetUsd || budgetUsd <= 0) return 0
  if (cost >= budgetUsd) return 2
  return cost >= budgetUsd * 0.8 ? 1 : 0
}

/** A folder-safe name: lower case, letters, digits and dashes, at most 40 characters. */
export const slugOf = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'request'

/** Whether `path` lies inside `root` (both absolute); `..` segments are refused outright. */
export function isInside(path: string, root: string): boolean {
  if (/(^|\/)\.\.(\/|$)/.test(path)) return false
  const base = root.endsWith('/') ? root : `${root}/`
  return path === root || path.startsWith(base)
}

/** Git subcommands a worktree agent may not run: they move, rewrite or publish branches. */
const FORBIDDEN_GIT =
  /\bgit\b[^|;&]*\b(push|checkout|switch|rebase|reset\s+--hard|stash|worktree|branch\s+-[dDmM]|merge|cherry-pick|filter-branch|clean\s+-[a-zA-Z]*f)\b/

/**
 * Why a worktree agent's tool call is refused, or null when it may run. File tools must
 * write inside the agent's worktree or the run folder; shell commands may not name the
 * main checkout or run git commands that move or publish branches.
 */
export function worktreeGuard(
  tool: string,
  input: Record<string, unknown>,
  worktreePath: string,
  repoRoot: string,
  runDir: string | null,
): string | null {
  const allowed = (path: string) =>
    isInside(path, worktreePath) || (runDir !== null && isInside(path, runDir))
  if (tool === 'Edit' || tool === 'Write' || tool === 'NotebookEdit' || tool === 'MultiEdit') {
    const target = String(input.file_path ?? input.notebook_path ?? '')
    if (target.startsWith('/') && !allowed(target)) {
      return `Agent fleet: this agent works in its worktree ${worktreePath}; it may not write ${target}.`
    }
  }
  if (tool === 'Bash') {
    const command = String(input.command ?? '')
    const namesRoot = command.split(repoRoot).length > 1 && !command.includes(worktreePath)
    if (namesRoot) {
      return `Agent fleet: this agent works in ${worktreePath}; commands may not touch ${repoRoot}.`
    }
    const git = FORBIDDEN_GIT.exec(command)
    if (git) {
      return `Agent fleet: "git ${git[1]}" is not allowed in a fleet worktree; the user merges.`
    }
  }
  return null
}

/**
 * A request's title: the first line of what the person typed, with pasted-content markers
 * removed, cut to 60 characters.
 */
export function titleOf(text: string): string {
  const line =
    text
      .replace(/<\/?pasted_content[^>]*>/gi, '\n')
      .split('\n')
      .map(one => one.trim())
      .find(one => one !== '') ?? ''
  return line.length > 60 ? `${line.slice(0, 59)}…` : line || 'Request'
}

/**
 * Colours that tell the lead agents apart from the workers in the pane. Mid-tone, so they read
 * on the dark schemes and on the light ones alike.
 */
export const ROLE_COLOR: Partial<Record<FleetRole, string>> = {
  planner: '#a371f7',
  reviewer: '#2f9fd8',
  designer: '#e0569b',
}

/** Transcript rows that agents create: their completion notices and the reports they send. */
export const AGENT_ORIGINS: readonly string[] = [
  'task-notification',
  'peer',
  'peer-send-message',
  'coordinator',
]

/** One line standing for a folded agent message: who, what happened, and its first words. */
export function compactLine(
  text: string,
  origin: string,
  from: string | undefined,
  task: { status?: string; durationMs?: number } | undefined,
  width: number,
): string {
  const who = from ? `@${from}` : origin === 'task-notification' ? 'agent' : 'message'
  const status = task?.status ? ` ${task.status}` : ''
  const time = task?.durationMs ? ` · ${elapsedText(0, task.durationMs)}` : ''
  const first =
    text
      .replace(/<[^>]+>/g, ' ')
      .split('\n')
      .map(one => one.trim())
      .find(one => one !== '' && !/^\[?subagent hand-back\]?/i.test(one)) ?? ''
  const head = `▸ ${who}${status}${time} — `
  const tail = '  (ctrl+o for all)'
  const room = Math.max(10, width - head.length - tail.length)
  return head + (first.length > room ? `${first.slice(0, room - 1)}…` : first) + tail
}

/** Added to the system prompt in quiet mode, so Claude's own updates are short too. */
export const QUIET_SECTION = [
  '# Agent fleet: quiet progress (set by the user)',
  'While fleet agents are running, keep each update to the user to one short line (what started, ',
  'what finished, what is next). Do not restate what the agents reported; put the substance in ',
  'the final answer. This applies to the main conversation only.',
].join('\n')

/** Every /fleet parameter, as the command's own help. */
export const HELP_LINES: readonly string[] = [
  '/fleet                     open the pane',
  '/fleet N model…            N worker slots and their models, e.g. /fleet 4 sonnet sonnet opus',
  '/fleet on | off            apply the plan to your requests, or not (everywhere)',
  '/fleet use on | off        switch the fleet on or off for this project only',
  '/fleet planner on|off|M    lead planner, and its model (opus, fable, sonnet, inherit)',
  '/fleet reviewer on|off|M   reviewer that checks the combined result last',
  '/fleet designer on|off|M   designer that polishes the result into files (uploads nothing)',
  '/fleet auto on|off         let the planner choose 1–N workers per task',
  '/fleet files on|off        workers write results to files in a run folder',
  '/fleet budget N | off      spending limit per request, in US dollars',
  '/fleet budget warn|stop    what happens at the limit',
  '/fleet worktrees on|off    each worker edits its own git worktree and branch',
  '/fleet worktrees           list fleet worktrees and what is still unmerged',
  '/fleet merge               merge finished worktrees into the base branch, stop on conflict',
  "/fleet detach N            remove job N's worktree but keep its branch",
  '/fleet notify on|off|sound|banner   announce finished requests (30 s or longer)',
  "/fleet messages full|compact|quiet  how much of the agents' messages the transcript shows",
  '/fleet history [all]       past requests here (or everywhere) and their run folders',
  '/fleet theme NAME          pane colours: ' + Object.keys(THEMES).join(', '),
  '/fleet pause | resume      pause running agents at their next tool call; resume them',
  '/fleet stop                stop every running fleet agent',
  '/fleet clear               remove finished agents and requests',
  '/fleet help                show this list',
  'Pane keys: t plan · p/o planner · r/e reviewer · d/n designer · f/m fewer/more · a count',
  '           1–9 agent model',
  '           b colours · s stop all · x pause or resume all · c clear · y history · v messages',
  '           h help',
]
