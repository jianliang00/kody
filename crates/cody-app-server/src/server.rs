use std::{
    collections::{HashMap, HashSet, VecDeque},
    sync::{Arc, RwLock},
};

use axum::{
    body::Bytes,
    extract::{
        ws::{Message as WsMessage, WebSocket, WebSocketUpgrade},
        Query, State,
    },
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use cody_core::{
    AgentRuntime, CodyEngine, EventId, ExternalTurnBackend, ProjectId, Result as CodyResult,
    StartTurn, ThreadId, Turn, TurnId, WorkspaceId,
};
use futures_util::{FutureExt, SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::sync::{Mutex, Notify};
use tokio_util::sync::CancellationToken;
use tracing::{debug, warn};

use crate::{
    codex_backend::CodexService,
    rpc::{RpcDispatcher, RpcError, RpcRequest, RpcResponse},
};

const CREATE_REQUEST_CACHE_CAPACITY: usize = 1_024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CreateRequestRecord {
    pub fingerprint: String,
    pub thread_id: ThreadId,
    pub workspace_id: WorkspaceId,
    pub turn_id: TurnId,
    pub project_id: Option<ProjectId>,
}

/// Process-local idempotency window. Order is tracked independently from the
/// hash table so capacity eviction is deterministic FIFO, not hash iteration
/// order.
#[derive(Debug)]
pub(crate) struct CreateRequestCache {
    records: HashMap<String, CreateRequestRecord>,
    insertion_order: VecDeque<String>,
    capacity: usize,
}

impl Default for CreateRequestCache {
    fn default() -> Self {
        Self::with_capacity(CREATE_REQUEST_CACHE_CAPACITY)
    }
}

impl CreateRequestCache {
    fn with_capacity(capacity: usize) -> Self {
        Self {
            records: HashMap::new(),
            insertion_order: VecDeque::new(),
            capacity: capacity.max(1),
        }
    }

    pub fn get(&self, request_id: &str) -> Option<&CreateRequestRecord> {
        self.records.get(request_id)
    }

    pub fn insert(&mut self, request_id: String, record: CreateRequestRecord) {
        if let Some(existing) = self.records.get_mut(&request_id) {
            *existing = record;
            return;
        }
        while self.records.len() >= self.capacity {
            let Some(oldest) = self.insertion_order.pop_front() else {
                break;
            };
            self.records.remove(&oldest);
        }
        self.insertion_order.push_back(request_id.clone());
        self.records.insert(request_id, record);
    }
}

#[derive(Clone)]
pub struct AppState {
    pub engine: Arc<CodyEngine>,
    pub turns: TurnManager,
    pub codex: Arc<CodexService>,
    pub(crate) create_requests: Arc<Mutex<CreateRequestCache>>,
    auth_token: Arc<str>,
    allowed_origins: Arc<HashSet<String>>,
}

impl AppState {
    pub fn new(engine: Arc<CodyEngine>) -> Self {
        let auth_token = std::env::var("CODY_SERVER_TOKEN")
            .ok()
            .filter(|token| !token.trim().is_empty())
            .unwrap_or_else(|| format!("{}{}", EventId::new(), EventId::new()));
        // The token authenticates the desktop-to-server control channel. It
        // must not leak into Codex, tools, or managed child processes.
        std::env::remove_var("CODY_SERVER_TOKEN");
        let allowed_origins = std::env::var("CODY_ALLOWED_ORIGINS")
            .ok()
            .into_iter()
            .flat_map(|origins| {
                origins
                    .split(',')
                    .map(str::trim)
                    .filter(|origin| !origin.is_empty())
                    .map(str::to_owned)
                    .collect::<Vec<_>>()
            })
            .collect();
        Self::with_auth(engine, auth_token, allowed_origins)
    }

    pub fn with_auth(
        engine: Arc<CodyEngine>,
        auth_token: impl Into<String>,
        allowed_origins: HashSet<String>,
    ) -> Self {
        let codex = CodexService::new(engine.clone());
        if let Err(error) = engine.providers().replace(codex.catalog_provider()) {
            warn!(%error, "could not register the Codex model catalog");
        }
        let turns = TurnManager::default();
        if let Err(error) = turns.register_backend("codex", codex.clone()) {
            warn!(%error, "could not register the Codex execution backend");
        }
        Self {
            engine,
            turns,
            codex,
            create_requests: Arc::new(Mutex::new(CreateRequestCache::default())),
            auth_token: Arc::from(auth_token.into()),
            allowed_origins: Arc::new(allowed_origins),
        }
    }

    pub fn auth_token(&self) -> &str {
        &self.auth_token
    }
}

#[derive(Clone)]
pub struct TurnManager {
    active: Arc<Mutex<HashMap<TurnId, CancellationToken>>>,
    idle: Arc<Notify>,
    backends: Arc<RwLock<HashMap<String, Arc<dyn ExternalTurnBackend>>>>,
}

impl Default for TurnManager {
    fn default() -> Self {
        Self {
            active: Arc::new(Mutex::new(HashMap::new())),
            idle: Arc::new(Notify::new()),
            backends: Arc::new(RwLock::new(HashMap::new())),
        }
    }
}

impl TurnManager {
    pub fn register_backend(
        &self,
        provider_id: impl Into<String>,
        backend: Arc<dyn ExternalTurnBackend>,
    ) -> CodyResult<()> {
        let provider_id = provider_id.into();
        if provider_id.trim().is_empty() {
            return Err(cody_core::CodyError::InvalidInput(
                "external backend provider id cannot be empty".into(),
            ));
        }
        self.backends
            .write()
            .map_err(|_| {
                cody_core::CodyError::Store("turn backend registry lock was poisoned".into())
            })?
            .insert(provider_id, backend);
        Ok(())
    }

    pub async fn start(&self, runtime: Arc<AgentRuntime>, request: StartTurn) -> CodyResult<Turn> {
        let (turn, cancellation) = self.prepare(runtime.clone(), request).await?;
        self.execute_prepared(runtime, turn.id, cancellation);
        Ok(turn)
    }

    pub async fn prepare(
        &self,
        runtime: Arc<AgentRuntime>,
        request: StartTurn,
    ) -> CodyResult<(Turn, CancellationToken)> {
        let turn = runtime.prepare_turn(request).await?;
        let cancellation = CancellationToken::new();
        self.active
            .lock()
            .await
            .insert(turn.id, cancellation.clone());
        Ok((turn, cancellation))
    }

    pub fn execute_prepared(
        &self,
        runtime: Arc<AgentRuntime>,
        turn_id: TurnId,
        cancellation: CancellationToken,
    ) {
        let active = self.active.clone();
        let idle = self.idle.clone();
        let backends = self.backends.clone();
        tokio::spawn(async move {
            let execution = std::panic::AssertUnwindSafe(async {
                let turn = runtime.store().get_turn(turn_id).await?;
                let backend = backends
                    .read()
                    .map_err(|_| {
                        cody_core::CodyError::Store(
                            "turn backend registry lock was poisoned".into(),
                        )
                    })?
                    .get(&turn.provider)
                    .cloned();
                match backend {
                    Some(backend) => {
                        runtime
                            .execute_turn_with_backend(turn_id, cancellation, backend)
                            .await
                    }
                    None => runtime.execute_turn(turn_id, cancellation).await,
                }
            })
            .catch_unwind()
            .await;
            match execution {
                Ok(Err(error)) => debug!(%turn_id, %error, "turn task finished with an error"),
                Err(_) => warn!(%turn_id, "turn task panicked outside the guarded agent loop"),
                Ok(Ok(_)) => {}
            }
            active.lock().await.remove(&turn_id);
            idle.notify_waiters();
        });
    }

    pub async fn cancel(&self, turn_id: TurnId) -> bool {
        let cancellation = self.active.lock().await.get(&turn_id).cloned();
        if let Some(cancellation) = cancellation {
            cancellation.cancel();
            true
        } else {
            false
        }
    }

    /// Cancel every active Turn and wait until each execution task has
    /// persisted its terminal state. This is the app-server shutdown barrier.
    pub async fn cancel_all_and_wait(&self, timeout: std::time::Duration) -> bool {
        let cancellations = self
            .active
            .lock()
            .await
            .values()
            .cloned()
            .collect::<Vec<_>>();
        for cancellation in cancellations {
            cancellation.cancel();
        }

        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            let notified = self.idle.notified();
            if self.active.lock().await.is_empty() {
                return true;
            }
            if tokio::time::timeout_at(deadline, notified).await.is_err() {
                return self.active.lock().await.is_empty();
            }
        }
    }
}

pub fn app(state: AppState) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/v1/rpc", post(http_rpc))
        .route("/v1/ws", get(websocket_upgrade))
        .route("/v1/app-server", get(websocket_upgrade))
        .with_state(state)
}

async fn health() -> Json<Value> {
    Json(json!({
        "status": "ok",
        "service": "cody-app-server",
        "version": env!("CARGO_PKG_VERSION"),
    }))
}

async fn http_rpc(State(state): State<AppState>, headers: HeaderMap, body: Bytes) -> Response {
    if !authorized(&headers, None, &state) {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "error": "missing or invalid bearer token" })),
        )
            .into_response();
    }
    let is_json = headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| {
            value.eq_ignore_ascii_case("application/json")
                || value.to_ascii_lowercase().starts_with("application/json;")
        });
    if !is_json {
        return (
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            Json(json!({ "error": "Content-Type must be application/json" })),
        )
            .into_response();
    }
    let request = match serde_json::from_slice::<RpcRequest>(&body) {
        Ok(request) => request,
        Err(error) => {
            return (
                StatusCode::OK,
                Json(RpcResponse::error(Value::Null, RpcError::parse(error))),
            )
                .into_response();
        }
    };
    let dispatcher = RpcDispatcher::new(state);
    match dispatcher.handle(request).await {
        Some(response) => (StatusCode::OK, Json(response)).into_response(),
        None => StatusCode::NO_CONTENT.into_response(),
    }
}

async fn websocket_upgrade(
    websocket: WebSocketUpgrade,
    State(state): State<AppState>,
    Query(auth): Query<WebSocketAuth>,
    headers: HeaderMap,
) -> Response {
    if !origin_allowed(&headers, &state) {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({ "error": "websocket origin is not allowed" })),
        )
            .into_response();
    }
    if !authorized(&headers, auth.token.as_deref(), &state) {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "error": "missing or invalid websocket token" })),
        )
            .into_response();
    }
    websocket.on_upgrade(move |socket| websocket_session(socket, state))
}

#[derive(Debug, serde::Deserialize)]
struct WebSocketAuth {
    #[serde(default)]
    token: Option<String>,
}

fn authorized(headers: &HeaderMap, query_token: Option<&str>, state: &AppState) -> bool {
    let bearer = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "));
    bearer.or(query_token).is_some_and(|candidate| {
        constant_time_eq(candidate.as_bytes(), state.auth_token.as_bytes())
    })
}

fn origin_allowed(headers: &HeaderMap, state: &AppState) -> bool {
    let Some(origin) = headers.get(header::ORIGIN) else {
        // Native app/CLI clients normally omit Origin.
        return true;
    };
    origin
        .to_str()
        .ok()
        .is_some_and(|origin| state.allowed_origins.contains(origin))
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.iter()
        .zip(right)
        .fold(0_u8, |difference, (left, right)| {
            difference | (left ^ right)
        })
        == 0
}

async fn websocket_session(socket: WebSocket, state: AppState) {
    let dispatcher = RpcDispatcher::new(state.clone());
    let mut events = state.engine.events().subscribe();
    let mut process_events = state.engine.processes().subscribe();
    let (mut sender, mut receiver) = socket.split();
    let mut subscriptions = HashSet::<ThreadId>::new();

    loop {
        tokio::select! {
            incoming = receiver.next() => {
                let Some(incoming) = incoming else { break };
                match incoming {
                    Ok(WsMessage::Text(text)) => {
                        let outcome = match serde_json::from_str::<RpcRequest>(text.as_str()) {
                            Ok(request) => handle_ws_request(&dispatcher, &state, request, &mut subscriptions).await,
                            Err(error) => WsRequestOutcome::response(RpcResponse::error(Value::Null, RpcError::parse(error))),
                        };
                        let send_failed = if let Some(response) = outcome.response {
                            send_json(&mut sender, &response).await.is_err()
                        } else {
                            false
                        };
                        if let Some((turn_id, cancellation)) = outcome.prepared {
                            state.turns.execute_prepared(
                                state.engine.runtime().clone(),
                                turn_id,
                                cancellation,
                            );
                        }
                        if send_failed { break; }
                    }
                    Ok(WsMessage::Binary(bytes)) => {
                        let outcome = match serde_json::from_slice::<RpcRequest>(&bytes) {
                            Ok(request) => handle_ws_request(&dispatcher, &state, request, &mut subscriptions).await,
                            Err(error) => WsRequestOutcome::response(RpcResponse::error(Value::Null, RpcError::parse(error))),
                        };
                        let send_failed = if let Some(response) = outcome.response {
                            send_json(&mut sender, &response).await.is_err()
                        } else {
                            false
                        };
                        if let Some((turn_id, cancellation)) = outcome.prepared {
                            state.turns.execute_prepared(
                                state.engine.runtime().clone(),
                                turn_id,
                                cancellation,
                            );
                        }
                        if send_failed { break; }
                    }
                    Ok(WsMessage::Ping(payload)) => {
                        if sender.send(WsMessage::Pong(payload)).await.is_err() {
                            break;
                        }
                    }
                    Ok(WsMessage::Pong(_)) => {}
                    Ok(WsMessage::Close(_)) | Err(_) => break,
                }
            }
            event = events.recv() => {
                match event {
                    Ok(event) => {
                        if !subscriptions.contains(&event.thread_id) {
                            continue;
                        }
                        let notification = json!({
                            "jsonrpc": "2.0",
                            "method": "turn/event",
                            "params": event,
                        });
                        if send_json(&mut sender, &notification).await.is_err() {
                            break;
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(skipped)) => {
                        warn!(skipped, "websocket client lagged behind the event stream");
                        let notification = json!({
                            "jsonrpc": "2.0",
                            "method": "server/event_gap",
                            "params": { "stream": "turn", "skipped": skipped },
                        });
                        if send_json(&mut sender, &notification).await.is_err() {
                            break;
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                }
            }
            event = process_events.recv() => {
                match event {
                    Ok(event) => {
                        if !subscriptions.contains(&event.thread_id) {
                            continue;
                        }
                        let notification = json!({
                            "jsonrpc": "2.0",
                            "method": "process/event",
                            "params": event,
                        });
                        if send_json(&mut sender, &notification).await.is_err() {
                            break;
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(skipped)) => {
                        warn!(skipped, "websocket client lagged behind the process event stream");
                        let notification = json!({
                            "jsonrpc": "2.0",
                            "method": "server/event_gap",
                            "params": { "stream": "process", "skipped": skipped },
                        });
                        if send_json(&mut sender, &notification).await.is_err() {
                            break;
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                }
            }
        }
    }
}

struct WsRequestOutcome {
    response: Option<RpcResponse>,
    prepared: Option<(TurnId, CancellationToken)>,
}

impl WsRequestOutcome {
    fn response(response: RpcResponse) -> Self {
        Self {
            response: Some(response),
            prepared: None,
        }
    }

    fn from_response(response: Option<RpcResponse>) -> Self {
        Self {
            response,
            prepared: None,
        }
    }
}

async fn handle_ws_request(
    dispatcher: &RpcDispatcher,
    state: &AppState,
    request: RpcRequest,
    subscriptions: &mut HashSet<ThreadId>,
) -> WsRequestOutcome {
    if request.jsonrpc != "2.0" {
        return WsRequestOutcome::from_response(
            request.id.map(|id| {
                RpcResponse::error(id, RpcError::invalid_request("jsonrpc must be '2.0'"))
            }),
        );
    }
    if matches!(
        request.method.as_str(),
        "thread/create-and-start" | "thread.create-and-start"
    ) {
        let id = request.id.clone();
        let result = dispatcher.create_and_prepare_thread(request.params).await;
        let (result, prepared) = match result {
            Ok((value, prepared)) => {
                let thread_id = value
                    .get("thread")
                    .and_then(|thread| thread.get("id"))
                    .cloned()
                    .and_then(|value| serde_json::from_value::<ThreadId>(value).ok())
                    .ok_or_else(|| RpcError::invalid_params("created Thread response has no id"));
                match thread_id {
                    Ok(thread_id) => {
                        subscriptions.insert(thread_id);
                        (Ok(value), prepared)
                    }
                    Err(error) => (Err(error), None),
                }
            }
            Err(error) => (Err(error), None),
        };
        return WsRequestOutcome {
            response: id.map(|id| match result {
                Ok(value) => RpcResponse::success(id, value),
                Err(error) => RpcResponse::error(id, error),
            }),
            prepared,
        };
    }
    if matches!(
        request.method.as_str(),
        "thread/subscribe" | "thread.subscribe"
    ) {
        let id = request.id.clone();
        let result = serde_json::from_value::<ThreadSubscription>(request.params)
            .map_err(RpcError::invalid_params);
        let result = match result {
            Ok(params) => match state.engine.store().get_thread(params.thread_id).await {
                Ok(_) => {
                    subscriptions.insert(params.thread_id);
                    Ok(json!({ "subscribed": true, "thread_id": params.thread_id }))
                }
                Err(error) => Err(RpcError::from(error)),
            },
            Err(error) => Err(error),
        };
        return WsRequestOutcome::from_response(id.map(|id| match result {
            Ok(value) => RpcResponse::success(id, value),
            Err(error) => RpcResponse::error(id, error),
        }));
    }
    if matches!(
        request.method.as_str(),
        "thread/unsubscribe" | "thread.unsubscribe"
    ) {
        let id = request.id.clone();
        let result = serde_json::from_value::<ThreadSubscription>(request.params)
            .map_err(RpcError::invalid_params)
            .map(|params| {
                let removed = subscriptions.remove(&params.thread_id);
                json!({ "subscribed": false, "removed": removed, "thread_id": params.thread_id })
            });
        return WsRequestOutcome::from_response(id.map(|id| match result {
            Ok(value) => RpcResponse::success(id, value),
            Err(error) => RpcResponse::error(id, error),
        }));
    }

    // Starting or inspecting a thread implicitly subscribes this connection.
    if matches!(
        request.method.as_str(),
        "turn/start"
            | "turn.start"
            | "thread/get"
            | "thread.get"
            | "thread/messages"
            | "thread.messages"
            | "process/list"
            | "process.list"
            | "process/get"
            | "process.get"
            | "process/read-output"
            | "process.read-output"
            | "process/stop"
            | "process.stop"
    ) {
        if let Some(thread_id) = request
            .params
            .get("thread_id")
            .cloned()
            .and_then(|value| serde_json::from_value(value).ok())
        {
            subscriptions.insert(thread_id);
        }
    }
    WsRequestOutcome::from_response(dispatcher.handle(request).await)
}

#[derive(Debug, serde::Deserialize)]
struct ThreadSubscription {
    thread_id: ThreadId,
}

async fn send_json<S, T>(sender: &mut S, value: &T) -> Result<(), ()>
where
    S: futures_util::Sink<WsMessage> + Unpin,
    T: serde::Serialize,
{
    let text = serde_json::to_string(value).map_err(|_| ())?;
    sender
        .send(WsMessage::Text(text.into()))
        .await
        .map_err(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(fingerprint: &str) -> CreateRequestRecord {
        CreateRequestRecord {
            fingerprint: fingerprint.into(),
            thread_id: ThreadId::new(),
            workspace_id: WorkspaceId::new(),
            turn_id: TurnId::new(),
            project_id: None,
        }
    }

    #[test]
    fn create_request_cache_evicts_in_insertion_order() {
        let mut cache = CreateRequestCache::with_capacity(2);
        cache.insert("first".into(), record("one"));
        cache.insert("second".into(), record("two"));

        // Reads do not change insertion order.
        assert!(cache.get("first").is_some());
        cache.insert("third".into(), record("three"));

        assert!(cache.get("first").is_none());
        assert!(cache.get("second").is_some());
        assert!(cache.get("third").is_some());
    }
}
