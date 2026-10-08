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
}

export type FleetStatus = 'running' | 'done' | 'failed' | 'stopped'

export type FleetRole = 'planner' | 'worker' | 'reviewer' | 'other'

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
  /** The planner's job number this agent works on, when its brief names one. */
  job?: number | null
  /** Where the agent was asked to write its result. */
  outputPath?: string | null
  /** The worktree the agent works in, when worktrees are on. */
  worktreeId?: string | null
  /** The run this one repeats, for a rerun. */
  rerunOf?: string | null
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
  /** The planner's jobs, with their waves read from the dependencies. */
  jobs?: FleetJob[]
  /** The commit and branch worktrees are cut from, when worktrees are on. */
  baseCommit?: string | null
  baseBranch?: string | null
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
    }
  }
}
