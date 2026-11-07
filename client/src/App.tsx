import { useEffect, useRef, useState, type FormEvent } from 'react'
import {
  ApiError,
  assignContributor,
  checkHealth,
  createTask,
  getTask,
  listTasks,
  respondToAssignment,
  retryRouting,
  type Assignment,
  type Contributor,
  type Task,
  type TaskDetail,
} from './api.ts'
import {
  actorLabel,
  ageLabel,
  assignmentLabel,
  attemptLabel,
  auditText,
  connectionLabel,
  isConnectionFailure,
  manualAssignmentUnavailable,
  nextConnection,
  outcomeLabel,
  statusNotice,
  sourceLabel,
  statusLabel,
  timeLabel,
  type ConnectionPhase,
} from './format.ts'

const statuses = [
  'routing',
  'no_response_warning',
  'offered',
  'accepted',
  'pre_work_failed',
  'recovery_required',
] as const

type Notice = { tone: 'success' | 'warning' | 'error'; text: string }

export default function App() {
  const [tasks, setTasks] = useState<Task[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<TaskDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [connection, setConnection] = useState<ConnectionPhase>('pending')
  const [notice, setNotice] = useState<Notice | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [filter, setFilter] = useState<string>('all')
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [expertise, setExpertise] = useState('')
  const [contributorId, setContributorId] = useState('')
  const [note, setNote] = useState('')
  const [names, setNames] = useState<Record<string, string>>({})
  const [now, setNow] = useState(() => Date.now())
  const selectedIdRef = useRef<string | null>(null)
  const busyRef = useRef(false)
  const detailRequest = useRef(0)
  const connectionRef = useRef<ConnectionPhase>('pending')
  const monitorLock = useRef(false)

  function reportConnection(event: 'success' | 'failure' | 'retry'): void {
    const next = nextConnection(connectionRef.current, event)
    connectionRef.current = next
    setConnection(next)
  }

  function lostConnection(error: unknown): boolean {
    return !(error instanceof ApiError) || isConnectionFailure(error.status)
  }

  function selectTask(taskId: string): void {
    selectedIdRef.current = taskId
    setSelectedId(taskId)
    setContributorId('')
    setNote('')
    setNotice(null)
  }

  async function refreshDetail(taskId: string): Promise<void> {
    const requestId = ++detailRequest.current
    const next = await getTask(taskId)
    if (requestId !== detailRequest.current || selectedIdRef.current !== taskId) return
    setDetail(next)
    rememberNames(next.eligibleContributors, next.assignments)
  }

  function rememberNames(contributors: Contributor[], assignments: Assignment[]): void {
    setNames((current) => {
      const next = { ...current }
      for (const contributor of contributors) next[contributor.id] = contributor.name
      for (const assignment of assignments) {
        if (!next[assignment.id]) {
          next[assignment.id] = next[assignment.contributorId] ?? assignment.contributorId
        }
      }
      return next
    })
  }

  async function refreshAll(taskId = selectedIdRef.current): Promise<void> {
    const list = await listTasks()
    setTasks(list)
    setNow(Date.now())
    if (taskId && list.some((task) => task.id === taskId)) await refreshDetail(taskId)
    else if (taskId && selectedIdRef.current === taskId) {
      selectedIdRef.current = null
      setDetail(null)
      setSelectedId(null)
    }
  }

  useEffect(() => {
    let cancel = false
    void (async () => {
      try {
        const list = await listTasks()
        if (cancel) return
        setTasks(list)
        if (!selectedIdRef.current && list[0]) selectTask(list[0].id)
        setLoadError(null)
        reportConnection('success')
      } catch (error) {
        if (!cancel) {
          setLoadError(error instanceof Error ? error.message : 'Tasks could not be loaded.')
          if (lostConnection(error)) reportConnection('failure')
        }
      } finally {
        if (!cancel) setLoading(false)
      }
    })()
    return () => { cancel = true }
  }, [])

  useEffect(() => {
    if (!selectedId) return
    let cancel = false
    const requestId = ++detailRequest.current
    void getTask(selectedId).then((next) => {
      if (cancel || requestId !== detailRequest.current) return
      setDetail(next)
      rememberNames(next.eligibleContributors, next.assignments)
    }).catch((error: unknown) => {
      if (!cancel && lostConnection(error)) reportConnection('failure')
    })
    return () => { cancel = true }
  }, [selectedId])

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30000)
    return () => window.clearInterval(timer)
  }, [])

  const routing = tasks.some((task) => task.status === 'routing')
  useEffect(() => {
    let cancel = false
    const timer = window.setInterval(() => {
      const phase = connectionRef.current
      const refreshData = routing || phase !== 'current'
      if (busyRef.current || monitorLock.current) return
      if (phase === 'disconnected' || phase === 'reconnecting') reportConnection('retry')
      monitorLock.current = true
      const request = refreshData ? refreshAll() : checkHealth()
      void request.then(() => {
        if (cancel || !refreshData) return
        setLoadError(null)
        reportConnection('success')
      }).catch((error: unknown) => {
        if (!cancel && lostConnection(error)) reportConnection('failure')
      }).finally(() => {
        monitorLock.current = false
      })
    }, 1500)
    return () => {
      cancel = true
      window.clearInterval(timer)
    }
  }, [routing])

  useEffect(() => {
    const missing = tasks.filter((task) => task.activeAssignmentId && !names[task.activeAssignmentId])
    if (!missing.length) return
    let cancel = false
    void Promise.all(missing.map(async (task) => {
      const next = await getTask(task.id)
      const active = next.assignments.find((assignment) => assignment.id === task.activeAssignmentId)
      const name = active
        ? next.eligibleContributors.find((contributor) => contributor.id === active.contributorId)?.name ?? active.contributorId
        : 'Unassigned'
      return [task.activeAssignmentId as string, name] as const
    })).then((entries) => {
      if (cancel) return
      setNames((current) => ({ ...current, ...Object.fromEntries(entries) }))
    }).catch(() => undefined)
    return () => { cancel = true }
  }, [tasks, names])

  async function runAction(name: string, action: () => Promise<string>): Promise<void> {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(name)
    setNotice(null)
    try {
      const message = await action()
      await refreshAll()
      reportConnection('success')
      setNotice({ tone: 'success', text: message })
    } catch (error) {
      if (lostConnection(error)) {
        reportConnection('failure')
        setNotice({ tone: 'error', text: 'The server could not be reached.' })
      } else if (error instanceof ApiError && error.status === 409) {
        try {
          await refreshAll()
          reportConnection('success')
          setNotice({
            tone: 'warning',
            text: 'This task changed on the server. The latest state is shown below. Review it before trying again.',
          })
        } catch (refreshError) {
          if (lostConnection(refreshError)) reportConnection('failure')
          setNotice({
            tone: 'warning',
            text: 'This task changed on the server, but the latest data could not be loaded.',
          })
        }
      } else {
        setNotice({ tone: 'error', text: error instanceof Error ? error.message : 'The request failed.' })
      }
    } finally {
      busyRef.current = false
      setBusy(null)
    }
  }

  async function submitTask(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    const nextTitle = title.trim()
    const nextExpertise = expertise.trim()
    if (!nextTitle || !nextExpertise) {
      setNotice({ tone: 'error', text: 'Title and required expertise are both required.' })
      return
    }
    await runAction('create', async () => {
      const task = await createTask({ title: nextTitle, description: description.trim(), requiredExpertise: nextExpertise })
      setTitle('')
      setDescription('')
      setExpertise('')
      selectTask(task.id)
      return 'Task created. Automatic routing has started.'
    })
  }

  const current = detail && detail.task.id === selectedId ? detail : null
  const activeAssignment = current?.assignments.find((assignment) => assignment.id === current.task.activeAssignmentId) ?? null
  const pendingAttempt = current?.routingAttempts.some((attempt) => attempt.status === 'pending') ?? false
  const status = current?.task.status ?? ''
  const eligible = current?.eligibleContributors ?? []
  const selectedContributorId = eligible.some((contributor) => contributor.id === contributorId)
    ? contributorId
    : eligible[0]?.id ?? ''
  const canAssign = Boolean(
    current
    && selectedContributorId
    && ['routing', 'no_response_warning', 'offered', 'pre_work_failed', 'recovery_required'].includes(status),
  )
  const assignmentUnavailable = eligible.length === 0 && ['routing', 'no_response_warning', 'offered', 'pre_work_failed', 'recovery_required'].includes(status)
  const canRetry = Boolean(current && (status === 'no_response_warning' || status === 'pre_work_failed' || status === 'recovery_required' || (status === 'routing' && !pendingAttempt)))
  const canRespond = Boolean(activeAssignment && status === 'offered' && activeAssignment.status === 'offered')
  const canFail = Boolean(activeAssignment && status === 'accepted' && activeAssignment.status === 'accepted')
  const visibleTasks = filter === 'all' ? tasks : tasks.filter((task) => task.status === filter)

  return (
    <div className="app">
      <header className="topbar">
        <div>
          <p className="eyebrow">TaskFlow</p>
          <h1>Operator dashboard</h1>
        </div>
        <p className={`connection${connection === 'disconnected' ? ' is-down' : ''}${connection === 'reconnecting' ? ' is-reconnecting' : ''}`} role="status">
          {connectionLabel(connection)}
        </p>
      </header>

      {notice && <p className={`notice is-${notice.tone}`} role="status">{notice.text}</p>}

      <section className="summary" aria-label="Task summary">
        <button type="button" className={filter === 'all' ? 'is-selected' : ''} aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>
          <span>All</span>
          <strong>{tasks.length}</strong>
        </button>
        {statuses.map((item) => (
          <button key={item} type="button" className={filter === item ? 'is-selected' : ''} aria-pressed={filter === item} onClick={() => setFilter(item)}>
            <span>{statusLabel(item)}</span>
            <strong>{tasks.filter((task) => task.status === item).length}</strong>
          </button>
        ))}
      </section>

      <main className="layout">
        <div className="queue">
          <form className="panel create" onSubmit={(event) => { void submitTask(event) }}>
            <h2>New task</h2>
            <label htmlFor="task-title">Title</label>
            <input id="task-title" value={title} maxLength={200} onChange={(event) => setTitle(event.target.value)} required />
            <label htmlFor="task-description">Description</label>
            <textarea id="task-description" value={description} maxLength={2000} rows={3} onChange={(event) => setDescription(event.target.value)} />
            <label htmlFor="task-expertise">Required expertise</label>
            <input id="task-expertise" value={expertise} maxLength={80} placeholder="frontend" onChange={(event) => setExpertise(event.target.value)} required />
            <button type="submit" className="primary" disabled={busy !== null}>
              {busy === 'create' ? 'Creating…' : 'Create and route'}
            </button>
          </form>

          <section className="panel" aria-labelledby="task-list-heading">
            <h2 id="task-list-heading">Tasks</h2>
            {loading && <p className="empty">Loading tasks…</p>}
            {loadError && (
              <div className="empty">
                <p>{loadError}</p>
                <button type="button" onClick={() => window.location.reload()}>Try again</button>
              </div>
            )}
            {!loading && !loadError && visibleTasks.length === 0 && (
              <p className="empty">{tasks.length === 0 ? 'No tasks yet. Create one to start routing.' : 'No tasks are in this state.'}</p>
            )}
            <ul className="task-list">
              {visibleTasks.map((task) => (
                <li key={task.id}>
                  <button
                    type="button"
                    className={task.id === selectedId ? 'task is-selected' : 'task'}
                    aria-current={task.id === selectedId ? 'true' : undefined}
                    onClick={() => selectTask(task.id)}
                  >
                    <span className="task-topline">
                      <span className="task-title">{task.title}</span>
                      <StatusBadge status={task.status} />
                    </span>
                    <span className="task-meta">
                      {task.requiredExpertise}
                      {' · '}
                      {ageLabel(task.createdAt, now)}
                      {' · '}
                      {task.activeAssignmentId ? names[task.activeAssignmentId] ?? 'Assigned' : 'Unassigned'}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        </div>

        <section className="panel detail" aria-live="polite">
          {!current && <p className="empty">{selectedId ? 'Loading task…' : 'Select a task to see its assignment and history.'}</p>}
          {current && (
            <>
              <div className="detail-heading">
                <div>
                  <h2>{current.task.title}</h2>
                  <p>{current.task.description || 'No description.'}</p>
                </div>
                <StatusBadge status={current.task.status} />
              </div>
              <StateNotice detail={current} names={names} />
              <dl className="meta">
                <div><dt>Expertise</dt><dd>{current.task.requiredExpertise}</dd></div>
                <div><dt>Created</dt><dd>{timeLabel(current.task.createdAt)}</dd></div>
                <div><dt>Assignee</dt><dd>{activeAssignment ? names[activeAssignment.contributorId] ?? activeAssignment.contributorId : 'Unassigned'}</dd></div>
                <div><dt>Accepted</dt><dd>{current.task.acceptedAt ? timeLabel(current.task.acceptedAt) : 'Not accepted'}</dd></div>
              </dl>

              <h3>Assignment</h3>
              {current.assignments.length === 0 && <p className="muted">No assignment has been made.</p>}
              <ul className="stack">
                {current.assignments.map((assignment) => (
                  <li key={assignment.id} className={assignment.id === current.task.activeAssignmentId ? 'card is-active' : 'card'}>
                    <strong>{names[assignment.contributorId] ?? assignment.contributorId}</strong>
                    <span>{sourceLabel(assignment.source)}</span>
                    <span>{assignmentLabel(assignment.status)}</span>
                    <span>{timeLabel(assignment.offeredAt)}</span>
                    {assignment.responseNote && <p>{assignment.responseNote}</p>}
                  </li>
                ))}
              </ul>

              <h3>Routing</h3>
              {current.routingAttempts.length === 0 && <p className="muted">No routing attempt has been recorded.</p>}
              <ul className="stack">
                {current.routingAttempts.map((attempt) => (
                  <li key={attempt.id} className="card">
                    <strong>{attemptLabel(attempt.status)}</strong>
                    <span>{outcomeLabel(attempt.outcome, attempt.selectedContributorId ? names[attempt.selectedContributorId] ?? attempt.selectedContributorId : null)}</span>
                    <span>Due {timeLabel(attempt.dueAt)}</span>
                    {attempt.warningAt && <span>Warning {timeLabel(attempt.warningAt)}</span>}
                  </li>
                ))}
              </ul>

              <form className="actions" onSubmit={(event) => {
                event.preventDefault()
                const version = current.task.version
                const chosen = current.eligibleContributors.find((contributor) => contributor.id === selectedContributorId)
                void runAction('assign', async () => {
                  await assignContributor(current.task.id, selectedContributorId, version)
                  return `Assigned to ${chosen?.name ?? 'the selected contributor'}. Waiting for a response.`
                })
              }}>
                <h3>Manual assignment</h3>
                <label htmlFor="contributor">Eligible contributor</label>
                {assignmentUnavailable && <p className="muted" id="contributor-unavailable">{manualAssignmentUnavailable}</p>}
                <select id="contributor" value={selectedContributorId} onChange={(event) => setContributorId(event.target.value)} disabled={!canAssign || busy !== null} aria-describedby={assignmentUnavailable ? 'contributor-unavailable' : undefined}>
                  {current.eligibleContributors.length === 0 && <option value="">No matching contributor</option>}
                  {current.eligibleContributors.map((contributor) => (
                    <option key={contributor.id} value={contributor.id}>{contributor.name}</option>
                  ))}
                </select>
                <div className="action-row">
                  <button type="submit" className="primary" disabled={!canAssign || busy !== null}>
                    {busy === 'assign' ? 'Assigning…' : status === 'offered' ? 'Replace offer' : 'Assign'}
                  </button>
                  <button type="button" disabled={!canRetry || busy !== null} onClick={() => {
                    const version = current.task.version
                    void runAction('retry', async () => {
                      await retryRouting(current.task.id, version)
                      return 'A new routing attempt has started.'
                    })
                  }}>
                    {busy === 'retry' ? 'Starting…' : 'Retry routing'}
                  </button>
                </div>
              </form>

              <div className="actions">
                <h3>Response</h3>
                <label htmlFor="response-note">Note <span>(optional)</span></label>
                <textarea id="response-note" value={note} maxLength={500} rows={2} onChange={(event) => setNote(event.target.value)} />
                <div className="action-row">
                  <button type="button" className="primary" disabled={!canRespond || busy !== null} onClick={() => {
                    if (!activeAssignment) return
                    const version = current.task.version
                    setNote('')
                    void runAction('accept', async () => {
                      await respondToAssignment(current.task.id, activeAssignment.id, 'accept', activeAssignment.contributorId, version, note.trim())
                      return 'Offer accepted. Automatic routing is stopped.'
                    })
                  }}>{busy === 'accept' ? 'Saving…' : 'Accept'}</button>
                  <button type="button" disabled={!canRespond || busy !== null} onClick={() => {
                    if (!activeAssignment) return
                    const version = current.task.version
                    setNote('')
                    void runAction('decline', async () => {
                      await respondToAssignment(current.task.id, activeAssignment.id, 'decline', activeAssignment.contributorId, version, note.trim())
                      return 'Offer declined. Retry routing or assign someone.'
                    })
                  }}>{busy === 'decline' ? 'Saving…' : 'Decline'}</button>
                  <button type="button" className="danger" disabled={!canFail || busy !== null} onClick={() => {
                    if (!activeAssignment) return
                    const version = current.task.version
                    setNote('')
                    void runAction('fail', async () => {
                      await respondToAssignment(current.task.id, activeAssignment.id, 'fail', activeAssignment.contributorId, version, note.trim())
                      return 'Pre-work failure recorded. You can retry or assign someone.'
                    })
                  }}>{busy === 'fail' ? 'Saving…' : 'Report pre-work failure'}</button>
                </div>
              </div>

              <h3>History</h3>
              {current.auditEvents.length === 0 && <p className="muted">No history yet.</p>}
              <ol className="history">
                {[...current.auditEvents].reverse().map((event) => (
                  <li key={event.id}>
                    <time dateTime={event.createdAt}>{timeLabel(event.createdAt)}</time>
                    <span>{actorLabel(event.actor)}</span>
                    <p>{auditText(event, current.eligibleContributors)}</p>
                  </li>
                ))}
              </ol>
            </>
          )}
        </section>
      </main>
    </div>
  )
}

function StatusBadge({ status }: { status: string }) {
  return <span className={`badge is-${status}`}>{statusLabel(status)}</span>
}

function StateNotice({ detail, names }: { detail: TaskDetail; names: Record<string, string> }) {
  const active = detail.assignments.find((assignment) => assignment.id === detail.task.activeAssignmentId)
  const name = active ? names[active.contributorId] ?? active.contributorId : 'the contributor'
  const text = statusNotice(detail.task.status, name, detail.eligibleContributors.length)
  if (!text) return null
  return <p className={`callout is-${detail.task.status}`}>{text}</p>
}
