import type { Session, WebContents } from 'electron'
import { shell } from 'electron'

import type { ContextReference, PermissionMode, RpcMethod } from '../shared/protocol'

const RPC_METHODS = new Set<RpcMethod>([
  'initialize',
  'provider/list',
  'provider/models',
  'image/provider/list',
  'image/models',
  'image/generate',
  'project/list',
  'project/import',
  'thread/list',
  'thread/create',
  'thread/create-and-start',
  'thread/get',
  'thread/reference/add',
  'turn/start',
  'turn/cancel',
  'approval/respond',
  'user-input/respond',
  'process/list',
  'process/get',
  'process/read-output',
  'process/stop'
])

const EMPTY_METHODS = new Set<RpcMethod>([
  'initialize',
  'provider/list',
  'image/provider/list',
  'project/list',
  'thread/list'
])
const EXTERNAL_PROTOCOLS = new Set(['http:', 'https:'])

export function validateRpcInvocation(method: unknown, params: unknown): asserts method is RpcMethod {
  if (typeof method !== 'string' || !RPC_METHODS.has(method as RpcMethod)) {
    throw new Error('Unsupported Kody RPC method')
  }
  if (!isRecord(params)) throw new Error(`Invalid parameters for '${method}'`)

  const rpcMethod = method as RpcMethod
  if (EMPTY_METHODS.has(rpcMethod)) {
    requireKeys(params, [])
    return
  }

  switch (rpcMethod) {
    case 'provider/models':
      requireKeys(params, ['provider_id'])
      requireString(params.provider_id, 'provider_id', 256)
      break
    case 'image/models':
      requireKeys(params, ['provider_id'])
      requireString(params.provider_id, 'provider_id', 256)
      break
    case 'image/generate':
      requireKeys(
        params,
        ['thread_id', 'provider', 'prompt', 'count'],
        ['model', 'size', 'quality', 'output_format', 'background']
      )
      requireId(params.thread_id, 'thread_id')
      requireString(params.provider, 'provider', 256)
      requireString(params.prompt, 'prompt', 64_000)
      requireOptionalString(params.model, 'model', 256)
      requireOptionalString(params.size, 'size', 64)
      requireOptionalString(params.quality, 'quality', 64)
      requireOptionalString(params.output_format, 'output_format', 16)
      requireOptionalString(params.background, 'background', 64)
      requireOptionalUnsignedInteger(params.count, 'count', 4, 1)
      break
    case 'project/import':
      requireKeys(params, ['path'], ['name'])
      requireString(params.path, 'path', 32_768)
      requireOptionalString(params.name, 'name', 512)
      break
    case 'thread/create':
      requireKeys(params, ['title'], ['working_directory'])
      requireString(params.title, 'title', 512)
      requireOptionalString(params.working_directory, 'working_directory', 32_768)
      break
    case 'thread/create-and-start':
      requireKeys(
        params,
        ['client_request_id', 'message', 'references', 'provider', 'permission_mode'],
        ['model', 'working_directory']
      )
      requireId(params.client_request_id, 'client_request_id')
      requireString(params.message, 'message', 128_000)
      requireString(params.provider, 'provider', 256)
      requirePermissionMode(params.permission_mode)
      requireOptionalString(params.model, 'model', 256)
      requireOptionalString(params.working_directory, 'working_directory', 32_768)
      if (!Array.isArray(params.references) || params.references.length > 128) {
        throw new Error('Invalid Turn references')
      }
      if (!params.references.every(isContextReference)) throw new Error('Invalid Turn context reference')
      break
    case 'thread/get':
      requireKeys(params, ['thread_id'])
      requireId(params.thread_id, 'thread_id')
      break
    case 'thread/reference/add':
      requireKeys(params, ['thread_id', 'reference'])
      requireId(params.thread_id, 'thread_id')
      if (!isContextReference(params.reference)) throw new Error('Invalid context reference')
      break
    case 'turn/start':
      requireKeys(
        params,
        ['thread_id', 'message', 'references', 'provider', 'permission_mode'],
        ['model']
      )
      requireId(params.thread_id, 'thread_id')
      requireString(params.message, 'message', 128_000)
      requireString(params.provider, 'provider', 256)
      requirePermissionMode(params.permission_mode)
      requireOptionalString(params.model, 'model', 256)
      if (!Array.isArray(params.references) || params.references.length > 128) {
        throw new Error('Invalid Turn references')
      }
      if (!params.references.every(isContextReference)) throw new Error('Invalid Turn context reference')
      break
    case 'turn/cancel':
      requireKeys(params, ['turn_id'])
      requireId(params.turn_id, 'turn_id')
      break
    case 'approval/respond':
      requireKeys(params, ['approval_id', 'approved'])
      requireId(params.approval_id, 'approval_id')
      if (typeof params.approved !== 'boolean') throw new Error("'approved' must be a boolean")
      break
    case 'user-input/respond':
      requireKeys(params, ['interaction_id', 'answers', 'cancelled'])
      requireId(params.interaction_id, 'interaction_id')
      if (typeof params.cancelled !== 'boolean') throw new Error("'cancelled' must be a boolean")
      if (!isRecord(params.answers) || Object.keys(params.answers).length > 16) {
        throw new Error("'answers' must be a bounded question-answer map")
      }
      let totalAnswerLength = 0
      for (const [questionId, answer] of Object.entries(params.answers)) {
        requireId(questionId, 'question_id')
        if (!isRecord(answer)) throw new Error('Invalid user-input answer')
        requireKeys(answer, ['answers'])
        if (!Array.isArray(answer.answers) || answer.answers.length === 0 || answer.answers.length > 32) {
          throw new Error('Each user-input answer must contain between 1 and 32 values')
        }
        for (const value of answer.answers) {
          requireString(value, 'answer', 32_768)
          totalAnswerLength += value.length
          if (totalAnswerLength > 512 * 1_024) throw new Error('User-input answers exceed the total size limit')
        }
      }
      if (params.cancelled && Object.keys(params.answers).length !== 0) {
        throw new Error('Cancelled user-input interactions cannot include answers')
      }
      break
    case 'process/list':
      requireKeys(params, ['thread_id'])
      requireId(params.thread_id, 'thread_id')
      break
    case 'process/get':
      requireKeys(params, ['thread_id', 'process_id'])
      requireId(params.thread_id, 'thread_id')
      requireId(params.process_id, 'process_id')
      break
    case 'process/read-output':
      requireKeys(params, ['thread_id', 'process_id'], ['after_cursor', 'limit'])
      requireId(params.thread_id, 'thread_id')
      requireId(params.process_id, 'process_id')
      requireOptionalUnsignedInteger(params.after_cursor, 'after_cursor', Number.MAX_SAFE_INTEGER)
      requireOptionalUnsignedInteger(params.limit, 'limit', 256 * 1024, 1)
      break
    case 'process/stop':
      requireKeys(params, ['thread_id', 'process_id'])
      requireId(params.thread_id, 'thread_id')
      requireId(params.process_id, 'process_id')
      break
    default:
      throw new Error('Unsupported Kody RPC method')
  }
}

function requirePermissionMode(value: unknown): asserts value is PermissionMode {
  if (value !== 'read_only' && value !== 'ask' && value !== 'full_access') {
    throw new Error("'permission_mode' must be read_only, ask, or full_access")
  }
}

export function isTrustedRendererUrl(candidate: string, trustedRendererUrl: string): boolean {
  try {
    const candidateUrl = new URL(candidate)
    const trustedUrl = new URL(trustedRendererUrl)
    if (candidateUrl.protocol !== trustedUrl.protocol) return false
    if (trustedUrl.protocol === 'file:') {
      return candidateUrl.host === trustedUrl.host && candidateUrl.pathname === trustedUrl.pathname
    }
    return candidateUrl.origin === trustedUrl.origin && candidateUrl.pathname === trustedUrl.pathname
  } catch {
    return false
  }
}

export function hardenRendererSession(session: Session, trustedRendererUrl: string, isDev: boolean): void {
  session.setPermissionCheckHandler(() => false)
  session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
  session.webRequest.onHeadersReceived((details, callback) => {
    if (details.resourceType !== 'mainFrame' || !isTrustedRendererUrl(details.url, trustedRendererUrl)) {
      callback({ responseHeaders: details.responseHeaders })
      return
    }
    const scriptSource = isDev
      ? "script-src 'self' 'unsafe-eval' 'unsafe-inline'"
      : "script-src 'self'"
    const connectSource = isDev ? "connect-src 'self' ws:" : "connect-src 'self'"
    const policy = [
      "default-src 'self'",
      scriptSource,
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "font-src 'self' data:",
      connectSource,
      "object-src 'none'",
      "base-uri 'none'",
      "frame-src 'none'",
      "form-action 'none'"
    ].join('; ')
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [policy]
      }
    })
  })
}

export function hardenWebContents(webContents: WebContents, trustedRendererUrl: string): void {
  webContents.on('will-attach-webview', (event) => event.preventDefault())
  webContents.on('will-navigate', (event, targetUrl) => {
    if (isTrustedRendererUrl(targetUrl, trustedRendererUrl)) return
    event.preventDefault()
    void openExternalUrl(targetUrl)
  })
  webContents.setWindowOpenHandler(({ url }) => {
    void openExternalUrl(url)
    return { action: 'deny' }
  })
}

async function openExternalUrl(rawUrl: string): Promise<void> {
  try {
    const url = new URL(rawUrl)
    if (!EXTERNAL_PROTOCOLS.has(url.protocol)) return
    url.username = ''
    url.password = ''
    await shell.openExternal(url.toString(), { activate: true })
  } catch {
    // Invalid and non-http(s) links stay inside the denied navigation boundary.
  }
}

function isContextReference(value: unknown): value is ContextReference {
  if (!isRecord(value) || typeof value.kind !== 'string') return false
  if (value.kind === 'project') {
    requireKeys(value, ['kind', 'project_id', 'access'])
    return isId(value.project_id) && (value.access === 'read_only' || value.access === 'read_write')
  }
  if (value.kind !== 'thread') return false
  const optional = value.mode === 'messages' ? ['message_ids'] : []
  requireKeys(value, ['kind', 'thread_id', 'mode'], optional)
  if (!isId(value.thread_id) || !['summary', 'full', 'messages', 'artifacts'].includes(String(value.mode))) {
    return false
  }
  if (value.mode !== 'messages') return true
  return Array.isArray(value.message_ids)
    && value.message_ids.length <= 256
    && value.message_ids.every(isId)
}

function requireKeys(value: Record<string, unknown>, required: string[], optional: string[] = []): void {
  const allowed = new Set([...required, ...optional])
  if (!required.every((key) => key in value) || Object.keys(value).some((key) => !allowed.has(key))) {
    throw new Error('RPC parameters contain missing or unsupported fields')
  }
}

function requireString(value: unknown, name: string, maxLength: number, allowEmpty = false): void {
  if (typeof value !== 'string' || value.length > maxLength || (!allowEmpty && value.trim().length === 0)) {
    throw new Error(`'${name}' must be a valid string`)
  }
}

function requireOptionalString(value: unknown, name: string, maxLength: number): void {
  if (value !== undefined) requireString(value, name, maxLength)
}

function requireOptionalUnsignedInteger(
  value: unknown,
  name: string,
  maximum: number,
  minimum = 0
): void {
  if (value === undefined) return
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`'${name}' must be an integer between ${minimum} and ${maximum}`)
  }
}

function requireId(value: unknown, name: string): void {
  if (!isId(value)) throw new Error(`'${name}' must be a valid identifier`)
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
