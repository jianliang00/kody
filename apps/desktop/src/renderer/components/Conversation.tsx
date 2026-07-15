import {
  Check,
  ChevronRight,
  Command,
  LoaderCircle,
  MessageCircle,
  ShieldAlert,
  Sparkles,
  X
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkBreaks from 'remark-breaks'
import remarkGfm from 'remark-gfm'
import type {
  ChatMessage,
  ContextReference,
  EventEnvelope,
  PendingApproval,
  Project,
  Thread,
  ThreadSnapshot,
  PendingUserInput,
  UserInputAnswers
} from '@shared/protocol'
import { ReferenceChips } from './ReferenceChips'

interface ConversationProps {
  snapshot: ThreadSnapshot
  threads: Thread[]
  projects: Project[]
  events: EventEnvelope[]
  pendingApprovals: PendingApproval[]
  pendingUserInputs: PendingUserInput[]
  running: boolean
  resolvingApprovals: Set<string>
  resolvingUserInputs: Set<string>
  bottomInset: number
  onApproval: (approvalId: string, approved: boolean) => Promise<void>
  onUserInput: (
    interactionId: string,
    answers: UserInputAnswers,
    cancelled: boolean
  ) => Promise<void>
}

const markdownRemarkPlugins = [remarkGfm, remarkBreaks]
const markdownComponents: Components = {
  a: (props) => <a {...props} target="_blank" rel="noreferrer" />
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit'
  }).format(new Date(value))
}

function textParts(message: ChatMessage): string {
  return message.parts
    .filter((part): part is Extract<ChatMessage['parts'][number], { type: 'text' }> => part.type === 'text')
    .map((part) => part.text)
    .join('\n\n')
}

function MessageReferences({
  references,
  threads,
  projects
}: {
  references: ContextReference[]
  threads: Thread[]
  projects: Project[]
}) {
  if (references.length === 0) return null
  return (
    <div className="message-references">
      <span>Context attached here · remains active later</span>
      <ReferenceChips references={references} threads={threads} projects={projects} compact />
    </div>
  )
}

function Markdown({ children }: { children: string }) {
  return (
    <div className="markdown" dir="auto">
      <ReactMarkdown
        remarkPlugins={markdownRemarkPlugins}
        skipHtml
        components={markdownComponents}
      >
        {children}
      </ReactMarkdown>
    </div>
  )
}

function ToolParts({ message }: { message: ChatMessage }) {
  const parts = message.parts.filter((part) => part.type !== 'text')
  if (parts.length === 0) return null
  return (
    <div className="durable-tool-parts">
      {parts.map((part, index) => {
        if (part.type === 'tool_call') {
          return (
            <details key={`${part.id}-${index}`}>
              <summary><Command aria-hidden="true" size={14} /> Called {part.name}</summary>
              <pre>{JSON.stringify(part.arguments, null, 2)}</pre>
            </details>
          )
        }
        return (
          <details key={`${part.tool_call_id}-${index}`}>
            <summary className={part.is_error ? 'tool-error' : undefined}>
              <ChevronRight aria-hidden="true" size={14} /> {part.name} {part.is_error ? 'failed' : 'finished'}
            </summary>
            <pre>{part.content}</pre>
          </details>
        )
      })}
    </div>
  )
}

function ApprovalCard({
  event,
  projects,
  resolved,
  resolving,
  onApproval
}: {
  event: Extract<EventEnvelope['event'], { type: 'approval_requested' }>
  projects: Project[]
  resolved?: boolean
  resolving: boolean
  onApproval: (approvalId: string, approved: boolean) => Promise<void>
}) {
  const args = event.arguments && typeof event.arguments === 'object'
    ? (event.arguments as Record<string, unknown>)
    : {}
  const command = typeof args.command === 'string'
    ? args.command
    : typeof args.cmd === 'string'
      ? args.cmd
      : JSON.stringify(event.arguments)
  const targetProject = typeof args.project_id === 'string'
    ? projects.find((project) => project.id === args.project_id)
    : undefined
  const target = targetProject
    ? `${targetProject.name} · ${targetProject.root}`
    : typeof args.cwd === 'string'
      ? args.cwd
      : typeof args.path === 'string'
        ? args.path
        : 'Thread Workspace'

  return (
    <section className="approval-card" aria-labelledby={`approval-${event.approval_id}`}>
      <header>
        <span className="approval-card__icon"><ShieldAlert aria-hidden="true" size={17} /></span>
        <div>
          <h3 id={`approval-${event.approval_id}`}>Command permission required</h3>
          <p>Kody paused before running this command.</p>
        </div>
      </header>
      <dl>
        <div>
          <dt>Command</dt>
          <dd><code>{command}</code></dd>
        </div>
        <div>
          <dt>Target</dt>
          <dd title={target}>{target}</dd>
        </div>
        <div>
          <dt>Reason</dt>
          <dd>{event.reason}</dd>
        </div>
      </dl>
      <footer>
        {resolved ? (
          <span className="approval-card__resolved"><Check aria-hidden="true" size={15} /> Response recorded</span>
        ) : resolving ? (
          <span className="approval-card__resolved"><LoaderCircle className="spin" aria-hidden="true" size={15} /> Sending response…</span>
        ) : (
          <>
            <button className="secondary-button" type="button" onClick={() => void onApproval(event.approval_id, false)}>
              <X aria-hidden="true" size={15} /> Deny
            </button>
            <button className="approval-allow" type="button" onClick={() => void onApproval(event.approval_id, true)}>
              <Check aria-hidden="true" size={15} /> Allow once
            </button>
          </>
        )}
      </footer>
    </section>
  )
}

type DraftAnswer = { mode: 'option' | 'free'; value: string }

function UserInputCard({
  request,
  resolving,
  onRespond
}: {
  request: PendingUserInput
  resolving: boolean
  onRespond: ConversationProps['onUserInput']
}) {
  const [drafts, setDrafts] = useState<Record<string, DraftAnswer>>({})
  const [error, setError] = useState('')
  const formId = `user-input-${request.interaction_id}`

  const updateDraft = (questionId: string, draft: DraftAnswer): void => {
    setDrafts((current) => ({ ...current, [questionId]: draft }))
    setError('')
  }

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    const answers: UserInputAnswers = {}
    for (const question of request.questions) {
      const draft = drafts[question.id]
      if (!draft || draft.value.trim().length === 0) {
        setError(`Answer “${question.header}” before continuing.`)
        return
      }
      answers[question.id] = { answers: [draft.value] }
    }
    setDrafts({})
    void onRespond(request.interaction_id, answers, false)
  }

  return (
    <section className="user-input-card" aria-labelledby={`${formId}-title`}>
      <header>
        <span className="user-input-card__icon"><MessageCircle aria-hidden="true" size={17} /></span>
        <div>
          <h3 id={`${formId}-title`}>Kody needs your input</h3>
          <p>The current Turn is paused until you answer or cancel this request.</p>
        </div>
      </header>
      <form onSubmit={submit} aria-describedby={error ? `${formId}-error` : undefined}>
        {request.questions.map((question, questionIndex) => {
          const inputId = `${formId}-question-${questionIndex}`
          const descriptionId = `${inputId}-description`
          // Secret prompts always use a protected free-text control, even if
          // an upstream backend also supplied option metadata.
          const options = question.is_secret ? [] : question.options ?? []
          const draft = drafts[question.id]
          return (
            <fieldset key={question.id} disabled={resolving}>
              <legend>{question.header}</legend>
              <p id={descriptionId}>{question.question}</p>
              {options.length > 0 ? (
                <div className="user-input-options" aria-describedby={descriptionId}>
                  {options.map((option, optionIndex) => (
                    <label key={`${question.id}-${option.label}`}>
                      <input
                        type="radio"
                        name={`${inputId}-choice`}
                        value={option.label}
                        checked={draft?.mode === 'option' && draft.value === option.label}
                        onChange={() => updateDraft(question.id, { mode: 'option', value: option.label })}
                      />
                      <span>
                        <strong>{option.label}</strong>
                        {option.description ? <small>{option.description}</small> : null}
                      </span>
                    </label>
                  ))}
                  {question.is_other ? (
                    <label>
                      <input
                        type="radio"
                        name={`${inputId}-choice`}
                        value="other"
                        checked={draft?.mode === 'free'}
                        onChange={() => updateDraft(question.id, { mode: 'free', value: '' })}
                      />
                      <span><strong>Other</strong><small>Provide a different answer.</small></span>
                    </label>
                  ) : null}
                </div>
              ) : null}
              {options.length === 0 || (question.is_other && draft?.mode === 'free') ? (
                <label className="user-input-free" htmlFor={`${inputId}-free`}>
                  <span>{options.length > 0 ? 'Other answer' : 'Your answer'}</span>
                  <input
                    id={`${inputId}-free`}
                    type={question.is_secret ? 'password' : 'text'}
                    autoComplete="off"
                    spellCheck={!question.is_secret}
                    aria-describedby={descriptionId}
                    value={draft?.mode === 'free' ? draft.value : ''}
                    onChange={(event) => updateDraft(question.id, { mode: 'free', value: event.target.value })}
                  />
                  {question.is_secret ? <small>Hidden while typing and never added to public activity.</small> : null}
                </label>
              ) : null}
            </fieldset>
          )
        })}
        {error ? <p id={`${formId}-error`} className="user-input-card__error" role="alert">{error}</p> : null}
        <footer>
          {resolving ? (
            <span className="user-input-card__status" role="status">
              <LoaderCircle className="spin" aria-hidden="true" size={15} /> Sending response…
            </span>
          ) : (
            <>
              <button
                className="secondary-button"
                type="button"
                onClick={() => {
                  setDrafts({})
                  setError('')
                  void onRespond(request.interaction_id, {}, true)
                }}
              >
                <X aria-hidden="true" size={15} /> Cancel request
              </button>
              <button className="user-input-submit" type="submit">
                <Check aria-hidden="true" size={15} /> Continue
              </button>
            </>
          )}
        </footer>
      </form>
    </section>
  )
}

export function Conversation({
  snapshot,
  threads,
  projects,
  events,
  pendingApprovals,
  pendingUserInputs,
  running,
  resolvingApprovals,
  resolvingUserInputs,
  bottomInset,
  onApproval,
  onUserInput
}: ConversationProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const nearBottomRef = useRef(true)
  const previousLastMessageRef = useRef<string | undefined>(undefined)
  const liveOutput = useMemo(
    () => events
      .filter((envelope) => envelope.event.type === 'model_output_delta')
      .map((envelope) => (envelope.event as Extract<EventEnvelope['event'], { type: 'model_output_delta' }>).delta)
      .join(''),
    [events]
  )
  const reasoning = useMemo(
    () => events
      .filter((envelope) => envelope.event.type === 'model_reasoning_delta')
      .map((envelope) => (envelope.event as Extract<EventEnvelope['event'], { type: 'model_reasoning_delta' }>).delta)
      .join(''),
    [events]
  )
  const latestFailure = [...events].reverse().find(
    (envelope) => envelope.event.type === 'turn_failed' || envelope.event.type === 'turn_cancelled'
  )
  const pendingInteractionKey = [
    ...pendingApprovals.map((approval) => `approval:${approval.approval_id}`),
    ...pendingUserInputs.map((request) => `input:${request.interaction_id}`)
  ].join('|')

  useEffect(() => {
    const lastMessage = snapshot.messages.at(-1)
    const newUserMessage = lastMessage?.id !== previousLastMessageRef.current && lastMessage?.role === 'user'
    previousLastMessageRef.current = lastMessage?.id
    if (!nearBottomRef.current && !newUserMessage) return
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const scrollContainer = scrollRef.current
    if (!scrollContainer) return
    scrollContainer.scrollTo({
      top: scrollContainer.scrollHeight,
      behavior: reduced ? 'auto' : 'smooth'
    })
  }, [snapshot.messages.length, events.length, pendingInteractionKey, bottomInset])

  return (
    <div
      ref={scrollRef}
      className="conversation-scroll"
      aria-label="Conversation"
      onScroll={() => {
        const element = scrollRef.current
        if (!element) return
        nearBottomRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 120
      }}
    >
      <div className="conversation-column">
        {snapshot.messages.length === 0 ? (
          <section className="thread-welcome">
            <span className="thread-welcome__mark" aria-hidden="true"><Sparkles size={22} /></span>
            <p className="eyebrow">Fresh Workspace</p>
            <h2>What should Kody work on?</h2>
            <p>
              Start with a question, or add Threads and Projects as explicit context. Each message joins this durable conversation.
            </p>
          </section>
        ) : null}

        {snapshot.messages.map((message) => {
          const text = textParts(message)
          if (message.role === 'system') return null
          if (message.role === 'user') {
            return (
              <article className="message message--user" key={message.id}>
                <header>
                  <span>You</span>
                  <time dateTime={message.created_at}>{formatTime(message.created_at)}</time>
                </header>
                {text ? <p dir="auto">{text}</p> : null}
                <MessageReferences references={message.references} threads={threads} projects={projects} />
                <ToolParts message={message} />
              </article>
            )
          }
          if (message.role === 'tool') {
            return <ToolParts message={message} key={message.id} />
          }
          return (
            <article className="message message--assistant" key={message.id}>
              <header>
                <span className="assistant-identity">
                  <span className="assistant-identity__mark" aria-hidden="true"><MessageCircle size={13} /></span>
                  Kody
                </span>
                <time dateTime={message.created_at}>{formatTime(message.created_at)}</time>
              </header>
              {text ? <Markdown>{text}</Markdown> : null}
              <ToolParts message={message} />
            </article>
          )
        })}

        {running ? (
          <article className="message message--assistant message--live">
            <header>
              <span className="assistant-identity">
                <span className="assistant-identity__mark assistant-identity__mark--live" aria-hidden="true"><LoaderCircle className="spin" size={13} /></span>
                Kody is working
              </span>
              <span className="live-label">Live</span>
            </header>
            {reasoning ? <p className="reasoning-line">{reasoning}</p> : null}
            {liveOutput ? <Markdown>{liveOutput}</Markdown> : <div className="thinking-dots" aria-label="Waiting for model output"><span /><span /><span /></div>}
          </article>
        ) : null}

        {pendingApprovals.map((approval) => (
          <ApprovalCard
            key={approval.approval_id}
            event={{
              type: 'approval_requested',
              approval_id: approval.approval_id,
              tool_call_id: approval.tool_call_id,
              name: approval.name,
              arguments: approval.arguments,
              reason: approval.reason
            }}
            projects={projects}
            resolving={resolvingApprovals.has(approval.approval_id)}
            onApproval={onApproval}
          />
        ))}

        {pendingUserInputs.map((request) => (
          <UserInputCard
            key={request.interaction_id}
            request={request}
            resolving={resolvingUserInputs.has(request.interaction_id)}
            onRespond={onUserInput}
          />
        ))}

        {!running && latestFailure ? (
          <div className={`turn-terminal turn-terminal--${latestFailure.event.type}`}>
            {latestFailure.event.type === 'turn_failed'
              ? `Turn failed: ${latestFailure.event.error}`
              : 'Turn stopped by user.'}
          </div>
        ) : null}
        <div className="conversation-end-spacer" aria-hidden="true" />
      </div>
    </div>
  )
}
