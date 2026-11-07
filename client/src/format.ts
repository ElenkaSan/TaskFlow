import type { AuditEvent, Contributor } from './api.ts'

const statusLabels: Record<string, string> = {
  routing: 'Routing',
  no_response_warning: 'No response',
  offered: 'Offered',
  accepted: 'Accepted',
  pre_work_failed: 'Pre-work failed',
  recovery_required: 'Needs recovery',
}

const assignmentLabels: Record<string, string> = {
  offered: 'Offered, waiting for a response',
  accepted: 'Accepted',
  declined: 'Declined',
  pre_work_failed: 'Pre-work failed',
  superseded: 'Replaced',
}

const attemptLabels: Record<string, string> = {
  pending: 'Waiting',
  completed: 'Finished',
  no_response: 'Unresolved',
  superseded: 'Superseded',
  cancelled: 'Cancelled',
}

const auditLabels: Record<string, string> = {
  task_created: 'Task created',
  routing_offer_created: 'Automatic offer created',
  routing_no_eligible_contributor: 'No eligible contributor found',
  routing_no_response_warning: 'No response yet. The attempt is still unresolved',
  routing_result_ignored: 'A late routing result was ignored',
  manual_assignment_created: 'Contributor assigned manually',
  assignment_superseded: 'Previous offer replaced',
  routing_attempts_superseded: 'Routing attempt superseded',
  assignment_accepted: 'Offer accepted',
  assignment_declined: 'Offer declined',
  assignment_pre_work_failed: 'Pre-work failure reported',
  routing_retried: 'Routing started again',
}

export function statusLabel(status: string): string {
  return statusLabels[status] ?? status.replaceAll('_', ' ')
}

export function assignmentLabel(status: string): string {
  return assignmentLabels[status] ?? status.replaceAll('_', ' ')
}

export function attemptLabel(status: string): string {
  return attemptLabels[status] ?? status.replaceAll('_', ' ')
}

export function sourceLabel(source: string): string {
  if (source === 'human') return 'Manual'
  if (source === 'automation') return 'Automatic'
  return source
}

export function actorLabel(actor: string): string {
  if (actor === 'operator') return 'Operator'
  if (actor === 'contributor') return 'Contributor'
  if (actor === 'system') return 'System'
  return actor
}

export function ageLabel(iso: string, now: number): string {
  const elapsed = Math.max(0, now - Date.parse(iso))
  const minutes = Math.floor(elapsed / 60000)
  if (minutes < 1) return 'Just now'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

export function timeLabel(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return 'Unknown time'
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date)
}

export function contributorName(contributors: Contributor[], id: string | null): string {
  if (!id) return 'Unassigned'
  return contributors.find((contributor) => contributor.id === id)?.name ?? id
}

export function auditText(event: AuditEvent, contributors: Contributor[]): string {
  const label = auditLabels[event.type] ?? event.type.replaceAll('_', ' ')
  const contributorId = typeof event.details.contributorId === 'string' ? event.details.contributorId : null
  if (!contributorId) return label
  return `${label} · ${contributorName(contributors, contributorId)}`
}

export type DetailPhase = 'idle' | 'loading' | 'ready' | 'failed'

export type DetailView = 'empty' | 'loading' | 'failed' | 'ready'

export function phaseWhileLoadingDetail(
  phase: DetailPhase,
  loadedTaskId: string | null,
  failedTaskId: string | null,
  taskId: string,
): DetailPhase {
  if (failedTaskId === taskId) return 'failed'
  if (loadedTaskId === taskId && phase !== 'loading') return 'ready'
  return 'loading'
}

export function detailView(
  selectedId: string | null,
  phase: DetailPhase,
  loadedTaskId: string | null,
  failedTaskId: string | null,
): DetailView {
  if (!selectedId) return 'empty'
  if (phase === 'failed' && failedTaskId === selectedId) return 'failed'
  if (loadedTaskId === selectedId && failedTaskId !== selectedId) return 'ready'
  return 'loading'
}

export type DetailLoad = {
  phase: DetailPhase
  loadedTaskId: string | null
  failedTaskId: string | null
  requestId: number
}

export function settleDetailRequest(
  state: DetailLoad,
  result: { requestId: number; taskId: string; selectedId: string | null; ok: boolean },
): DetailLoad | null {
  if (result.requestId !== state.requestId || result.selectedId !== result.taskId) return null
  if (result.ok) {
    return { requestId: state.requestId, phase: 'ready', loadedTaskId: result.taskId, failedTaskId: null }
  }
  return { requestId: state.requestId, phase: 'failed', loadedTaskId: state.loadedTaskId, failedTaskId: result.taskId }
}

export type ConnectionPhase = 'pending' | 'current' | 'disconnected' | 'reconnecting'

export function connectionLabel(phase: ConnectionPhase): string {
  switch (phase) {
    case 'current':
      return 'Up to date'
    case 'disconnected':
      return 'Disconnected'
    case 'reconnecting':
      return 'Reconnecting'
    default:
      return ''
  }
}

export function beginConnectionAttempt(phase: ConnectionPhase): ConnectionPhase {
  return phase === 'disconnected' || phase === 'reconnecting' ? 'reconnecting' : phase
}

export function applyConnectionResult(_phase: ConnectionPhase, ok: boolean): ConnectionPhase {
  return ok ? 'current' : 'disconnected'
}

export function isConnectionFailure(status: number): boolean {
  return status === 0 || status >= 500
}

export function nextConnection(phase: ConnectionPhase, event: 'success' | 'failure' | 'retry'): ConnectionPhase {
  if (event === 'retry') return beginConnectionAttempt(phase)
  return applyConnectionResult(phase, event === 'success')
}

export const manualAssignmentUnavailable =
  'Manual assignment is currently unavailable because no matching contributor was found.'

export function statusNotice(status: string, assigneeName: string, eligibleCount: number): string | null {
  const none = eligibleCount === 0
  switch (status) {
    case 'routing':
      return none
        ? `Routing is still in progress. ${manualAssignmentUnavailable}`
        : 'Routing is still in progress. You can assign someone now. A later automatic result will not replace that decision.'
    case 'no_response_warning':
      return none
        ? `No response has arrived. This is not a routing failure. ${manualAssignmentUnavailable} You can start another attempt.`
        : 'No response has arrived. This is not a routing failure. Assign someone or start another attempt.'
    case 'offered':
      return `Offered to ${assigneeName}. The assignment is waiting for a response and has not been accepted.`
    case 'accepted':
      return `Accepted by ${assigneeName}. Automatic routing is stopped.`
    case 'pre_work_failed':
      return none
        ? `The accepted contributor reported a problem before work started. ${manualAssignmentUnavailable} You can retry routing.`
        : 'The accepted contributor reported a problem before work started. Retry routing or assign someone.'
    case 'recovery_required':
      return none
        ? `A decision is needed. ${manualAssignmentUnavailable} You can retry routing.`
        : 'A decision is needed. Retry routing or assign someone. People who declined or failed are left out of the next automatic attempt.'
    default:
      return null
  }
}

export function outcomeLabel(outcome: string, contributor: string | null): string {
  if (!contributor) return 'No matching contributor was available.'
  if (outcome === 'no_response') return `No response from ${contributor}. This is not a failure.`
  return `Match saved for ${contributor}.`
}

export const pendingRoutingText = 'Awaiting routing response.'

export function routingAttemptLines(
  attempt: {
    status: string
    outcome: string
    dueAt: string
    warningAt: string | null
    createdAt: string
  },
  contributor: string | null,
  now: number,
): string[] {
  if (attempt.status === 'pending') {
    return [pendingRoutingText, `Elapsed ${ageLabel(attempt.createdAt, now)}`]
  }
  if (attempt.status !== 'completed' && attempt.status !== 'no_response') return []
  const lines = [outcomeLabel(attempt.outcome, contributor), `Due ${timeLabel(attempt.dueAt)}`]
  if (attempt.status === 'no_response' && attempt.warningAt) lines.push(`Warning ${timeLabel(attempt.warningAt)}`)
  return lines
}
