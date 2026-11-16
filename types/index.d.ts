export type FleetModel = 'inherit' | 'opus' | 'sonnet' | 'haiku' | 'fable'

/** A lead agent outside the worker slots: the planner, the reviewer. */
export type FleetLead = { isEnabled: boolean; model: FleetModel }
/** Kept for plans saved before the reviewer existed. */
export type FleetPlanner = FleetLead

export type FleetPlan = {
  isEnabled: boolean
  models: FleetModel[]
  planner?: FleetLead
  reviewer?: FleetLead
  /** Polishes the final result into files (documents, decks, web pages); uploads nothing. */
  designer?: FleetLead
  /** Researches what already exists (competitors, features, sources) before the planner plans. */
  researcher?: FleetLead
  /** Reviews what the agents built for security problems, as the last step; read-only. */
  security?: FleetLead
  /** The planner (or Claude) picks between 1 and `models.length` workers. */
  isAutoSize?: boolean
  /** A key of the pane's colour schemes. */
  theme?: string
  /** Workers write their results to files in the request's run folder. On unless turned off. */
  isFileHandoff?: boolean
  /** Each worker gets its own git worktree and branch. Off unless turned on. */
  isWorktrees?: boolean
  /** Spending limit per request in US dollars; null or absent for none. */
  budgetUsd?: number | null
  /** What happens when a request reaches its budget. */
  budgetAction?: 'warn' | 'stop'
  /** How a finished request is announced: sound and banner (default), one of them, or nothing. */
  notify?: 'all' | 'sound' | 'banner' | 'off'
  /** How much of the agents' messages the transcript shows. Full unless changed. */
  messages?: 'full' | 'compact' | 'quiet'
  /**
   * Memory the laptop must keep available, in MB: below it no agent starts and running ones
   * are acted on. Absent: a tenth of the installed memory (1 GB at least). Null: no guard.
   */
  memMinFreeMb?: number | null
  /** What happens to running agents when available memory falls below the limit. */
  memAction?: 'warn' | 'pause' | 'stop'
  /**
   * Small requests (a commit, a push, one command) are done by Claude directly, without the
   * fleet. On unless turned off.
   */
  isQuickDirect?: boolean
  /**
   * When the reviewer runs: on every request (`always`, the default), or only where a review
   * pays (`auto`): two or more workers ran, or a worker listed points it could not verify.
   */
  reviewWhen?: 'always' | 'auto'
  /** How much the reviewer checks: everything doubtful (`full`), or only what was flagged. */
  reviewDepth?: 'full' | 'quick'
  /** Minutes without any activity after which an agent counts as stuck. Null: never. */
  stallMinutes?: number | null
  /** What the fleet does about a stuck agent. */
  stallAction?: 'warn' | 'tell' | 'restart'
}

/** The lead agents, in the order they run. */
export type FleetLeadKey = 'researcher' | 'planner' | 'reviewer' | 'designer' | 'security'

/** The laptop's memory as last measured. */
export type FleetMemory = {
  availMb: number
  totalMb: number
  at: number
  /** Below the limit, and not yet clearly back above it. */
  isLow: boolean
}

export type FleetStatus = 'running' | 'paused' | 'done' | 'failed' | 'stopped'

export type FleetRole =
  'researcher' | 'planner' | 'worker' | 'reviewer' | 'designer' | 'security' | 'other'

/** `todo`: the agent's latest TodoWrite list. `tasks`: TaskCreate/TaskUpdate ids by status. */
export type FleetSteps = {
  todoDone: number
  todoTotal: number
  created: number
  completedIds: string[]
  deletedIds: string[]
}

/** What an agent last reported through the fleet's progress tool. */
export type FleetProgress = { done: number; total: number; step: string }

export type FleetRun = {
  id: string
  description: string
  type: string
  model: string
  slot: number | null
  status: FleetStatus
  startedAt: number
  endedAt: number | null
  tools: number
  lastTool: string | null
  tokens: number | null
  /** The agent's own task list: steps it has completed and steps it has planned. */
  steps: FleetSteps
  role?: FleetRole
  requestId?: string | null
  progress?: FleetProgress | null
  /** One or two sentences naming the job the agent was given, read from its prompt. */
  task?: string
  /** The prompt as the agent's caller wrote it, before the fleet's notes: what a rerun repeats. */
  prompt?: string
  /** What the fleet appended to that prompt (delivery, worktree, slots): a rerun gets it again. */
  notes?: string
  /** The planner's job number this agent works on, when its brief names one. */
  job?: number | null
  /** Where the agent was asked to write its result. */
  outputPath?: string | null
  /** The worktree the agent works in, when worktrees are on. */
  worktreeId?: string | null
  /** The run this one repeats, for a rerun. */
  rerunOf?: string | null
  /** The person asked to pause it: it stops at its next tool call. */
  pauseRequested?: boolean
  /** Why it was paused, when the fleet did it and not the person. */
  pauseReason?: 'memory' | null
  /** When it last did anything: a model response arriving, or a tool call. */
  lastActivityAt?: number
  /** The tool call it is inside, while one runs. */
  busyTool?: string | null
  /** When the fleet found it stuck; cleared once it shows activity again. */
  stalledAt?: number | null
  /** A worker's reply listed points it could not verify or found conflicting. */
  hasOpenPoints?: boolean
  /** How many times the fleet has already restarted this job because it was stuck. */
  stallRestarts?: number
}

/** One job of a planner's plan, and the jobs it waits for. */
export type FleetJob = { n: number; title: string; after: number[] }

/** One message the person typed while the fleet was on, and everything it started. */
export type FleetRequest = {
  id: string
  title: string
  startedAt: number
  endedAt: number | null
  /** Workers the plan expects: the slot count, or the planner's job count when it chooses. */
  expectedWorkers: number | null
  outcome: 'open' | 'done' | 'stopped'
  /** Folder holding the plan, each worker's result and the combined result. */
  runDir?: string | null
  /** The session's cost when the request started, and what the request has cost since. */
  costAtStart?: number | null
  cost?: number | null
  /** 0: under budget; 1: warned at 80%; 2: reached. */
  budgetLevel?: number
  /** What the person should end up with, as the planner named it: report, slides, website, code, data. */
  deliverable?: string | null
  /** The planner's jobs, with their waves read from the dependencies. */
  jobs?: FleetJob[]
  /** The commit and branch worktrees are cut from, when worktrees are on. */
  baseCommit?: string | null
  baseBranch?: string | null
  /** The commit the project was at when the request started: what a security review diffs against. */
  headAtStart?: string | null
  /** Where the researcher's findings were saved. */
  researchPath?: string | null
}

/**
 * A worktree the fleet created. Kept across sessions until its branch is merged and the
 * worktree removed, so no work is left behind.
 */
export type FleetWorktree = {
  id: string
  repoRoot: string
  requestId: string
  requestTitle: string
  job: number | null
  label: string
  path: string
  branch: string
  baseCommit: string
  baseBranch: string
  createdAt: number
  status: 'active' | 'ready' | 'empty' | 'merged' | 'conflict' | 'removed' | 'detached'
  /** Commits on the branch that the base does not have. */
  commits: number
  note: string
}

/** One finished request, kept across sessions so a run can be found again. */
export type FleetHistoryEntry = {
  id: string
  title: string
  project: string
  startedAt: number
  endedAt: number
  outcome: 'done' | 'stopped'
  agents: number
  tokens: number
  cost: number | null
  runDir: string | null
}

/** What the pane shows for one agent opened with "peek". */
export type FleetPeek = {
  runId: string
  text: string
  tool: string
  at: number
}

declare module 'claude-code' {
  interface PluginState {
    'agent-fleet': {
      plan: FleetPlan
      runs: FleetRun[]
      now: number
      requests: FleetRequest[]
      isBandHidden: boolean
      isHelpOpen: boolean
      /** The fleet is switched off for the current project with /fleet use off. */
      isProjectOff: boolean
      worktrees: FleetWorktree[]
      peek: FleetPeek | null
      history: FleetHistoryEntry[]
      isHistoryOpen: boolean
      memory: FleetMemory | null
    }
  }
}
