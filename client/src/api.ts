export type Task = {
  id: string
  title: string
  description: string
  requiredExpertise: string
  status: string
  version: number
  activeAssignmentId: string | null
  acceptedAt: string | null
  createdAt: string
  updatedAt: string
}

export type Assignment = {
  id: string
  taskId: string
  contributorId: string
  source: string
  status: string
  offeredAt: string
  respondedAt: string | null
  responseNote: string | null
}

export type Contributor = {
  id: string
  name: string
  expertise: string
}

export type RoutingAttempt = {
  id: string
  status: string
  outcome: string
  dueAt: string
  warningAt: string | null
  selectedContributorId: string | null
  taskVersionAtCreation: number
  createdAt: string
  completedAt: string | null
}

export type AuditEvent = {
  id: string
  type: string
  actor: string
  details: Record<string, unknown>
  createdAt: string
}

export type TaskDetail = {
  task: Task
  assignments: Assignment[]
  eligibleContributors: Contributor[]
  routingAttempts: RoutingAttempt[]
  auditEvents: AuditEvent[]
}

export class ApiError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }
}

const API_BASE = import.meta.env.VITE_API_BASE ?? ''

async function request(path: string, init?: RequestInit): Promise<unknown> {
  let response: Response
  try {
    response = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers: {
        Accept: 'application/json',
        ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      },
    })
  } catch {
    throw new ApiError(0, 'network_error', 'The server could not be reached.')
  }
  const text = await response.text()
  let payload: unknown = null
  if (text) {
    try {
      payload = JSON.parse(text)
    } catch {
      throw new ApiError(response.status, response.ok ? 'invalid_response' : 'request_failed', 'The server could not be reached.')
    }
  }
  if (!response.ok) {
    const error = record(payload)?.error
    const body = record(error)
    const details = body?.details
    const detailText = details ? detailMessage(details) : ''
    throw new ApiError(
      response.status,
      typeof body?.code === 'string' ? body.code : 'request_failed',
      `${typeof body?.message === 'string' ? body.message : 'The request failed.'}${detailText}`,
    )
  }
  return payload
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : null
}

function detailMessage(details: unknown): string {
  const body = record(details)
  if (!body) return ''
  const messages = Object.values(body).filter((value): value is string => typeof value === 'string')
  return messages.length ? ` ${messages.join(' ')}` : ''
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function nullableText(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function taskFrom(value: unknown): Task {
  const body = record(value)
  if (!body || typeof body.id !== 'string' || typeof body.version !== 'number') {
    throw new ApiError(500, 'invalid_response', 'The server returned an unexpected task.')
  }
  return {
    id: body.id,
    title: text(body.title),
    description: text(body.description),
    requiredExpertise: text(body.requiredExpertise),
    status: text(body.status),
    version: body.version,
    activeAssignmentId: nullableText(body.activeAssignmentId),
    acceptedAt: nullableText(body.acceptedAt),
    createdAt: text(body.createdAt),
    updatedAt: text(body.updatedAt),
  }
}

function assignmentFrom(value: unknown): Assignment {
  const body = record(value)
  if (!body || typeof body.id !== 'string') {
    throw new ApiError(500, 'invalid_response', 'The server returned an unexpected assignment.')
  }
  return {
    id: body.id,
    taskId: text(body.taskId),
    contributorId: text(body.contributorId),
    source: text(body.source),
    status: text(body.status),
    offeredAt: text(body.offeredAt),
    respondedAt: nullableText(body.respondedAt),
    responseNote: nullableText(body.responseNote),
  }
}

function attemptFrom(value: unknown): RoutingAttempt {
  const body = record(value)
  if (!body || typeof body.id !== 'string') {
    throw new ApiError(500, 'invalid_response', 'The server returned an unexpected routing attempt.')
  }
  return {
    id: body.id,
    status: text(body.status),
    outcome: text(body.outcome),
    dueAt: text(body.due_at ?? body.dueAt),
    warningAt: nullableText(body.warning_at ?? body.warningAt),
    selectedContributorId: nullableText(body.selected_contributor_id ?? body.selectedContributorId),
    taskVersionAtCreation: typeof body.task_version_at_creation === 'number'
      ? body.task_version_at_creation
      : typeof body.taskVersionAtCreation === 'number' ? body.taskVersionAtCreation : 0,
    createdAt: text(body.created_at ?? body.createdAt),
    completedAt: nullableText(body.completed_at ?? body.completedAt),
  }
}

function detailFrom(value: unknown): TaskDetail {
  const body = record(value)
  if (!body) throw new ApiError(500, 'invalid_response', 'The server returned an unexpected task.')
  const contributors = Array.isArray(body.eligibleContributors) ? body.eligibleContributors : []
  return {
    task: taskFrom(body.task),
    assignments: Array.isArray(body.assignments) ? body.assignments.map(assignmentFrom) : [],
    eligibleContributors: contributors.map((item) => {
      const contributor = record(item)
      return {
        id: text(contributor?.id),
        name: text(contributor?.name),
        expertise: text(contributor?.expertise),
      }
    }),
    routingAttempts: Array.isArray(body.routingAttempts) ? body.routingAttempts.map(attemptFrom) : [],
    auditEvents: Array.isArray(body.auditEvents) ? body.auditEvents.map((item) => {
      const event = record(item)
      return {
        id: text(event?.id),
        type: text(event?.type),
        actor: text(event?.actor),
        details: record(event?.details) ?? {},
        createdAt: text(event?.createdAt),
      }
    }) : [],
  }
}

export function checkHealth(): Promise<void> {
  return request('/api/health').then(() => undefined)
}

export function listTasks(): Promise<Task[]> {
  return request('/api/tasks').then((payload) => {
    const tasks = record(payload)?.tasks
    return Array.isArray(tasks) ? tasks.map(taskFrom) : []
  })
}

export function getTask(taskId: string): Promise<TaskDetail> {
  return request(`/api/tasks/${encodeURIComponent(taskId)}`).then(detailFrom)
}

export function createTask(input: { title: string; description: string; requiredExpertise: string }): Promise<Task> {
  return request('/api/tasks', { method: 'POST', body: JSON.stringify(input) }).then((payload) => taskFrom(record(payload)?.task))
}

export function assignContributor(taskId: string, contributorId: string, version: number): Promise<Task> {
  return request(`/api/tasks/${encodeURIComponent(taskId)}/assignments`, {
    method: 'POST',
    body: JSON.stringify({ contributorId, version }),
  }).then((payload) => taskFrom(record(payload)?.task))
}

export function respondToAssignment(
  taskId: string,
  assignmentId: string,
  action: 'accept' | 'decline' | 'fail',
  contributorId: string,
  version: number,
  responseNote: string,
): Promise<Task> {
  return request(`/api/tasks/${encodeURIComponent(taskId)}/assignments/${encodeURIComponent(assignmentId)}/${action}`, {
    method: 'POST',
    body: JSON.stringify({ contributorId, version, ...(responseNote ? { responseNote } : {}) }),
  }).then((payload) => taskFrom(record(payload)?.task))
}

export function retryRouting(taskId: string, version: number): Promise<Task> {
  return request(`/api/tasks/${encodeURIComponent(taskId)}/routing`, {
    method: 'POST',
    body: JSON.stringify({ version }),
  }).then((payload) => taskFrom(record(payload)?.task))
}
