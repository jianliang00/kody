use std::{
    collections::{HashMap, HashSet},
    sync::{
        atomic::{AtomicBool, AtomicI64, Ordering},
        Arc, Mutex, Weak,
    },
    time::Duration,
};

use serde::{de::DeserializeOwned, Serialize};
use serde_json::{json, Value};
use tokio::{
    io::{AsyncBufRead, AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStderr, ChildStdin, ChildStdout, Command},
    sync::{broadcast, mpsc, oneshot, watch},
    time::{timeout, timeout_at, Instant},
};
use tokio_util::sync::CancellationToken;
use tracing::{debug, warn};

use crate::codex::{
    discovery::{
        candidates, probe_version, sort_by_version_preference, CodexBinary, CodexDiscoveryOptions,
    },
    error::{CodexError, Result},
    redaction::{redact_rpc_error, redact_text, redact_value},
    types::{
        AccountLoginCompleted, AccountReadResponse, AccountUpdated, CancelLoginResponse,
        CancelLoginStatus, ChatGptLogin, CodexNotification, CodexServerRequest, DeviceCodeLogin,
        InitializeResponse, ModelInfo, ModelListPage, ModelListParams, RateLimitsResponse,
        RpcErrorPayload, RpcId, ThreadResumeParams, ThreadResumeResponse, ThreadStartParams,
        ThreadStartResponse, TurnInterruptParams, TurnStartParams, TurnStartResponse,
    },
};

type PendingResult = std::result::Result<Value, PendingError>;

#[derive(Debug)]
enum PendingError {
    Rpc(RpcErrorPayload),
    Closed(String),
}

#[derive(Debug, Clone)]
enum Lifecycle {
    Running,
    Exited(String),
}

enum WriterCommand {
    Frame(Vec<u8>),
    Close,
}

/// Limits and identity used by the Codex sidecar client.
#[derive(Debug, Clone)]
pub struct CodexClientOptions {
    pub discovery: CodexDiscoveryOptions,
    pub client_name: String,
    pub client_title: String,
    pub client_version: String,
    pub startup_timeout: Duration,
    pub request_timeout: Duration,
    pub shutdown_timeout: Duration,
    pub server_request_timeout: Duration,
    pub request_queue_capacity: usize,
    pub event_queue_capacity: usize,
    pub max_model_pages: usize,
    pub max_line_bytes: usize,
    pub stderr_tail_bytes: usize,
    /// Explicit CLI `-c key=value` overrides applied before the `app-server`
    /// subcommand. Values are never sourced from renderer input.
    pub config_overrides: Vec<String>,
}

impl Default for CodexClientOptions {
    fn default() -> Self {
        Self {
            discovery: CodexDiscoveryOptions::default(),
            client_name: "kody".into(),
            client_title: "Kody".into(),
            client_version: env!("CARGO_PKG_VERSION").into(),
            startup_timeout: Duration::from_secs(15),
            request_timeout: Duration::from_secs(60),
            shutdown_timeout: Duration::from_secs(3),
            server_request_timeout: Duration::from_secs(120),
            request_queue_capacity: 128,
            event_queue_capacity: 512,
            max_model_pages: 1_024,
            max_line_bytes: 8 * 1024 * 1024,
            stderr_tail_bytes: 64 * 1024,
            config_overrides: Vec::new(),
        }
    }
}

impl CodexClientOptions {
    fn validate(&self) -> Result<()> {
        for (name, duration) in [
            ("startup_timeout", self.startup_timeout),
            ("request_timeout", self.request_timeout),
            ("shutdown_timeout", self.shutdown_timeout),
            ("server_request_timeout", self.server_request_timeout),
        ] {
            if duration.is_zero() {
                return Err(CodexError::InvalidOptions(format!(
                    "{name} must be greater than zero"
                )));
            }
        }
        if self.request_queue_capacity == 0
            || self.event_queue_capacity == 0
            || self.max_model_pages == 0
        {
            return Err(CodexError::InvalidOptions(
                "queue capacities and max_model_pages must be greater than zero".into(),
            ));
        }
        if self.max_line_bytes < 256 {
            return Err(CodexError::InvalidOptions(
                "max_line_bytes must be at least 256".into(),
            ));
        }
        if self.stderr_tail_bytes == 0 {
            return Err(CodexError::InvalidOptions(
                "stderr_tail_bytes must be greater than zero".into(),
            ));
        }
        if self.client_name.trim().is_empty() || self.client_version.trim().is_empty() {
            return Err(CodexError::InvalidOptions(
                "client_name and client_version must not be empty".into(),
            ));
        }
        if self.config_overrides.len() > 32
            || self.config_overrides.iter().any(|value| {
                value.is_empty() || value.len() > 4_096 || value.contains(['\0', '\n', '\r'])
            })
        {
            return Err(CodexError::InvalidOptions(
                "config overrides are empty, oversized, or contain control characters".into(),
            ));
        }
        Ok(())
    }
}

struct ClientInner {
    binary: CodexBinary,
    options: CodexClientOptions,
    writer: mpsc::Sender<WriterCommand>,
    next_id: AtomicI64,
    pending: Mutex<HashMap<RpcId, oneshot::Sender<PendingResult>>>,
    incoming_requests: Mutex<HashSet<RpcId>>,
    notifications: broadcast::Sender<CodexNotification>,
    server_requests: broadcast::Sender<CodexServerRequest>,
    initialize_response: Mutex<Option<InitializeResponse>>,
    stderr_tail: Mutex<String>,
    lifecycle: watch::Sender<Lifecycle>,
    shutdown: CancellationToken,
    graceful_shutdown: AtomicBool,
    closed: AtomicBool,
}

impl ClientInner {
    fn close_reason(&self) -> String {
        match &*self.lifecycle.borrow() {
            Lifecycle::Running => "transport is unavailable".into(),
            Lifecycle::Exited(reason) => reason.clone(),
        }
    }

    fn mark_closed(&self, reason: impl Into<String>) {
        let reason = redact_text(&reason.into());
        if self.closed.swap(true, Ordering::AcqRel) {
            return;
        }
        let _ = self.lifecycle.send(Lifecycle::Exited(reason.clone()));
        self.shutdown.cancel();
        let pending = {
            let mut pending = self
                .pending
                .lock()
                .unwrap_or_else(|poison| poison.into_inner());
            pending
                .drain()
                .map(|(_, sender)| sender)
                .collect::<Vec<_>>()
        };
        for sender in pending {
            let _ = sender.send(Err(PendingError::Closed(reason.clone())));
        }
        self.incoming_requests
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .clear();
    }

    fn append_stderr(&self, text: &str) {
        let redacted = redact_text(text);
        let mut tail = self
            .stderr_tail
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        tail.push_str(&redacted);
        tail.push('\n');
        trim_utf8_prefix(&mut tail, self.options.stderr_tail_bytes);
    }
}

impl Drop for ClientInner {
    fn drop(&mut self) {
        self.graceful_shutdown.store(true, Ordering::Release);
        let _ = self.writer.try_send(WriterCommand::Close);
        self.shutdown.cancel();
    }
}

/// A cloneable handle to one long-lived `codex app-server` child process.
#[derive(Clone)]
pub struct CodexClient {
    inner: Arc<ClientInner>,
}

impl CodexClient {
    /// Probes every implicit candidate, tries parseable semantic versions from
    /// newest to oldest, then tries candidates with unparseable versions. An
    /// explicit `KODY_CODEX_PATH` remains authoritative. Each attempted binary
    /// must complete the initialize handshake and `account/read` capability
    /// probe; a logged-out account is valid.
    pub async fn discover_and_spawn(options: CodexClientOptions) -> Result<Self> {
        options.validate()?;
        let candidates = candidates(&options.discovery)?;
        if candidates.is_empty() {
            return Err(CodexError::NoUsableBinary {
                attempts: "KODY_CODEX_PATH was unset and no executable was found in PATH or configured bundles".into(),
            });
        }

        let mut attempts = Vec::new();
        let mut binaries = Vec::new();
        for candidate in candidates {
            let path = candidate.path.clone();
            match probe_version(&candidate, options.discovery.probe_timeout).await {
                Ok(binary) => binaries.push(binary),
                Err(error) => {
                    attempts.push(format!("{}: {error}", path.display()));
                }
            }
        }
        sort_by_version_preference(&mut binaries);

        for binary in binaries {
            let path = binary.path().to_owned();
            match Self::spawn_binary(binary, options.clone()).await {
                Ok(client) => match client
                    .account_read_with_timeout(options.startup_timeout)
                    .await
                {
                    Ok(_) => return Ok(client),
                    Err(error) => {
                        attempts.push(format!(
                            "{}: account/config capability probe failed: {error}",
                            path.display()
                        ));
                        let _ = client.shutdown().await;
                    }
                },
                Err(error) => attempts.push(format!("{}: {error}", path.display())),
            }
        }

        Err(CodexError::NoUsableBinary {
            attempts: redact_text(&attempts.join("; ")),
        })
    }

    async fn spawn_binary(binary: CodexBinary, options: CodexClientOptions) -> Result<Self> {
        let mut command = Command::new(binary.path());
        for value in &options.config_overrides {
            command.args(["-c", value]);
        }
        command
            .args(["app-server", "--listen", "stdio://"])
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true);
        let mut child = command.spawn().map_err(|source| CodexError::Spawn {
            path: binary.path().to_owned(),
            source,
        })?;
        let stdin = child.stdin.take().expect("piped stdin must exist");
        let stdout = child.stdout.take().expect("piped stdout must exist");
        let stderr = child.stderr.take().expect("piped stderr must exist");

        let (writer, writer_rx) = mpsc::channel(options.request_queue_capacity);
        let (notifications, _) = broadcast::channel(options.event_queue_capacity);
        let (server_requests, _) = broadcast::channel(options.event_queue_capacity);
        let (lifecycle, _) = watch::channel(Lifecycle::Running);
        let shutdown = CancellationToken::new();
        let inner = Arc::new(ClientInner {
            binary,
            options: options.clone(),
            writer,
            next_id: AtomicI64::new(1),
            pending: Mutex::new(HashMap::new()),
            incoming_requests: Mutex::new(HashSet::new()),
            notifications,
            server_requests,
            initialize_response: Mutex::new(None),
            stderr_tail: Mutex::new(String::new()),
            lifecycle,
            shutdown: shutdown.clone(),
            graceful_shutdown: AtomicBool::new(false),
            closed: AtomicBool::new(false),
        });

        tokio::spawn(writer_loop(
            stdin,
            writer_rx,
            Arc::downgrade(&inner),
            shutdown.clone(),
        ));
        tokio::spawn(stdout_loop(stdout, Arc::downgrade(&inner)));
        tokio::spawn(stderr_loop(stderr, Arc::downgrade(&inner)));
        tokio::spawn(supervise_child(child, Arc::downgrade(&inner), shutdown));

        let client = Self { inner };
        let initialize: InitializeResponse = client
            .request_typed_with_timeout(
                "initialize",
                json!({
                    "clientInfo": {
                        "name": options.client_name,
                        "title": options.client_title,
                        "version": options.client_version,
                    },
                    "capabilities": { "experimentalApi": false }
                }),
                options.startup_timeout,
            )
            .await?;
        *client
            .inner
            .initialize_response
            .lock()
            .unwrap_or_else(|poison| poison.into_inner()) = Some(initialize);
        client
            .send_notification_with_timeout("initialized", None, options.startup_timeout)
            .await?;
        Ok(client)
    }

    pub fn binary(&self) -> &CodexBinary {
        &self.inner.binary
    }

    pub fn initialize_info(&self) -> InitializeResponse {
        self.inner
            .initialize_response
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .clone()
            .expect("client is returned only after initialize completes")
    }

    pub fn is_running(&self) -> bool {
        !self.inner.closed.load(Ordering::Acquire)
    }

    /// Returns only an already-redacted, size-bounded stderr tail.
    pub fn stderr_tail(&self) -> String {
        self.inner
            .stderr_tail
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .clone()
    }

    pub fn subscribe_notifications(&self) -> broadcast::Receiver<CodexNotification> {
        self.inner.notifications.subscribe()
    }

    pub fn subscribe_server_requests(&self) -> broadcast::Receiver<CodexServerRequest> {
        self.inner.server_requests.subscribe()
    }

    pub async fn account_read(&self) -> Result<AccountReadResponse> {
        self.account_read_with_timeout(self.inner.options.request_timeout)
            .await
    }

    async fn account_read_with_timeout(&self, duration: Duration) -> Result<AccountReadResponse> {
        let value = self
            .request_value_with_timeout("account/read", json!({ "refreshToken": false }), duration)
            .await?;
        AccountReadResponse::from_wire(value).map_err(CodexError::Json)
    }

    pub async fn rate_limits_read(&self) -> Result<RateLimitsResponse> {
        self.request_typed("account/rateLimits/read", Value::Null)
            .await
    }

    pub async fn models_page(&self, params: ModelListParams) -> Result<ModelListPage> {
        self.request_typed("model/list", params).await
    }

    pub async fn models_all(&self, include_hidden: bool) -> Result<Vec<ModelInfo>> {
        let mut cursor = None;
        let mut seen = HashSet::new();
        let mut models = Vec::new();
        for _ in 0..self.inner.options.max_model_pages {
            let page = self
                .models_page(ModelListParams {
                    cursor: cursor.clone(),
                    limit: Some(100),
                    include_hidden: Some(include_hidden),
                })
                .await?;
            models.extend(page.data);
            let Some(next) = page.next_cursor else {
                return Ok(models);
            };
            if !seen.insert(next.clone()) {
                return Err(CodexError::Protocol(
                    "model/list returned a repeated pagination cursor".into(),
                ));
            }
            cursor = Some(next);
        }
        Err(CodexError::Protocol(format!(
            "model/list exceeded the {}-page safety limit",
            self.inner.options.max_model_pages
        )))
    }

    pub async fn thread_start(&self, params: ThreadStartParams) -> Result<ThreadStartResponse> {
        self.request_typed("thread/start", params).await
    }

    pub async fn thread_resume(&self, params: ThreadResumeParams) -> Result<ThreadResumeResponse> {
        self.request_typed("thread/resume", params).await
    }

    pub async fn turn_start(&self, params: TurnStartParams) -> Result<TurnStartResponse> {
        self.request_typed("turn/start", params).await
    }

    pub async fn turn_interrupt(&self, params: TurnInterruptParams) -> Result<()> {
        let _: Value = self.request_typed("turn/interrupt", params).await?;
        Ok(())
    }

    /// Starts Codex-managed browser OAuth. Only the login id and URL are
    /// returned; any unexpected credential fields in the wire response are
    /// ignored rather than exposed.
    pub async fn login_chatgpt(&self) -> Result<ChatGptLogin> {
        let value = self
            .request_value("account/login/start", json!({ "type": "chatgpt" }))
            .await?;
        parse_chatgpt_login(value)
    }

    /// Starts Codex-managed device-code OAuth. Kody never receives OAuth
    /// tokens from this flow.
    pub async fn login_device_code(&self) -> Result<DeviceCodeLogin> {
        let value = self
            .request_value(
                "account/login/start",
                json!({ "type": "chatgptDeviceCode" }),
            )
            .await?;
        parse_device_code_login(value)
    }

    pub async fn cancel_login(&self, login_id: impl Into<String>) -> Result<CancelLoginResponse> {
        let value = self
            .request_value(
                "account/login/cancel",
                json!({ "loginId": login_id.into() }),
            )
            .await?;
        let status = value
            .get("status")
            .and_then(Value::as_str)
            .ok_or_else(|| CodexError::Protocol("login cancel response omitted status".into()))?;
        let status = match status {
            "canceled" => CancelLoginStatus::Canceled,
            "notFound" => CancelLoginStatus::NotFound,
            other => {
                return Err(CodexError::Protocol(format!(
                    "unknown login cancel status '{other}'"
                )))
            }
        };
        Ok(CancelLoginResponse { status })
    }

    pub async fn logout(&self) -> Result<()> {
        let _: Value = self.request_typed("account/logout", Value::Null).await?;
        Ok(())
    }

    /// Responds exactly once to a server-initiated approval/tool request.
    pub async fn respond_server_request(&self, id: RpcId, result: Value) -> Result<()> {
        let existed = self
            .inner
            .incoming_requests
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .remove(&id);
        if !existed {
            return Err(CodexError::Protocol(format!(
                "server request {id:?} is unknown or was already answered"
            )));
        }
        self.send_envelope_with_timeout(
            json!({ "id": id, "result": result }),
            "server request response",
            self.inner.options.request_timeout,
        )
        .await
    }

    pub async fn reject_server_request(
        &self,
        id: RpcId,
        code: i64,
        message: impl Into<String>,
    ) -> Result<()> {
        let existed = self
            .inner
            .incoming_requests
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .remove(&id);
        if !existed {
            return Err(CodexError::Protocol(format!(
                "server request {id:?} is unknown or was already answered"
            )));
        }
        self.send_envelope_with_timeout(
            json!({
                "id": id,
                "error": { "code": code, "message": message.into() }
            }),
            "server request rejection",
            self.inner.options.request_timeout,
        )
        .await
    }

    /// Closes stdin first so app-server can exit cleanly, then force-kills only
    /// if it exceeds the configured shutdown deadline.
    pub async fn shutdown(&self) -> Result<()> {
        if self.inner.closed.load(Ordering::Acquire) {
            return Ok(());
        }
        self.inner.graceful_shutdown.store(true, Ordering::Release);
        let mut lifecycle = self.inner.lifecycle.subscribe();
        let send = self.inner.writer.send(WriterCommand::Close);
        if timeout(self.inner.options.shutdown_timeout, send)
            .await
            .is_err()
        {
            self.inner.shutdown.cancel();
        }
        let wait_for_exit = async {
            loop {
                if matches!(&*lifecycle.borrow(), Lifecycle::Exited(_)) {
                    return;
                }
                if lifecycle.changed().await.is_err() {
                    return;
                }
            }
        };
        if timeout(self.inner.options.shutdown_timeout, wait_for_exit)
            .await
            .is_err()
        {
            self.inner.shutdown.cancel();
            let _ = timeout(self.inner.options.shutdown_timeout, async {
                while !self.inner.closed.load(Ordering::Acquire) {
                    tokio::task::yield_now().await;
                }
            })
            .await;
        }
        Ok(())
    }

    async fn request_typed<P, R>(&self, method: &str, params: P) -> Result<R>
    where
        P: Serialize,
        R: DeserializeOwned,
    {
        self.request_typed_with_timeout(method, params, self.inner.options.request_timeout)
            .await
    }

    async fn request_typed_with_timeout<P, R>(
        &self,
        method: &str,
        params: P,
        duration: Duration,
    ) -> Result<R>
    where
        P: Serialize,
        R: DeserializeOwned,
    {
        let params = serde_json::to_value(params)?;
        let value = self
            .request_value_with_timeout(method, params, duration)
            .await?;
        serde_json::from_value(value).map_err(CodexError::Json)
    }

    async fn request_value(&self, method: &str, params: Value) -> Result<Value> {
        self.request_value_with_timeout(method, params, self.inner.options.request_timeout)
            .await
    }

    async fn request_value_with_timeout(
        &self,
        method: &str,
        params: Value,
        duration: Duration,
    ) -> Result<Value> {
        if self.inner.closed.load(Ordering::Acquire) {
            return Err(CodexError::Closed {
                reason: self.inner.close_reason(),
            });
        }
        let raw_id = self.inner.next_id.fetch_add(1, Ordering::Relaxed);
        if raw_id <= 0 {
            return Err(CodexError::Protocol(
                "request identifier space was exhausted".into(),
            ));
        }
        let id = RpcId::Integer(raw_id);
        let envelope = json!({ "id": id, "method": method, "params": params });
        let frame = encode_frame(&envelope, self.inner.options.max_line_bytes, "outbound")?;
        let (sender, receiver) = oneshot::channel();
        self.inner
            .pending
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .insert(id.clone(), sender);
        let guard = PendingGuard {
            inner: Arc::downgrade(&self.inner),
            id,
        };
        let deadline = Instant::now() + duration;
        match timeout_at(
            deadline,
            self.inner.writer.send(WriterCommand::Frame(frame)),
        )
        .await
        {
            Ok(Ok(())) => {}
            Ok(Err(_)) => return Err(CodexError::QueueClosed),
            Err(_) => {
                return Err(CodexError::Timeout {
                    method: method.into(),
                    timeout: duration,
                })
            }
        }
        let response = match timeout_at(deadline, receiver).await {
            Ok(Ok(response)) => response,
            Ok(Err(_)) => {
                return Err(CodexError::Closed {
                    reason: self.inner.close_reason(),
                })
            }
            Err(_) => {
                return Err(CodexError::Timeout {
                    method: method.into(),
                    timeout: duration,
                })
            }
        };
        drop(guard);
        match response {
            Ok(value) => Ok(value),
            Err(PendingError::Rpc(error)) => Err(CodexError::Rpc {
                method: method.into(),
                error,
            }),
            Err(PendingError::Closed(reason)) => Err(CodexError::Closed { reason }),
        }
    }

    async fn send_notification_with_timeout(
        &self,
        method: &str,
        params: Option<Value>,
        duration: Duration,
    ) -> Result<()> {
        let envelope = match params {
            Some(params) => json!({ "method": method, "params": params }),
            None => json!({ "method": method }),
        };
        self.send_envelope_with_timeout(envelope, method, duration)
            .await
    }

    async fn send_envelope_with_timeout(
        &self,
        envelope: Value,
        operation: &str,
        duration: Duration,
    ) -> Result<()> {
        let frame = encode_frame(&envelope, self.inner.options.max_line_bytes, "outbound")?;
        match timeout(
            duration,
            self.inner.writer.send(WriterCommand::Frame(frame)),
        )
        .await
        {
            Ok(Ok(())) => Ok(()),
            Ok(Err(_)) => Err(CodexError::QueueClosed),
            Err(_) => Err(CodexError::Timeout {
                method: operation.into(),
                timeout: duration,
            }),
        }
    }

    #[cfg(all(test, unix))]
    pub(crate) async fn request_raw(&self, method: &str, params: Value) -> Result<Value> {
        self.request_value(method, params).await
    }

    #[cfg(all(test, unix))]
    pub(crate) fn pending_request_count(&self) -> usize {
        self.inner
            .pending
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .len()
    }
}

struct PendingGuard {
    inner: Weak<ClientInner>,
    id: RpcId,
}

impl Drop for PendingGuard {
    fn drop(&mut self) {
        if let Some(inner) = self.inner.upgrade() {
            inner
                .pending
                .lock()
                .unwrap_or_else(|poison| poison.into_inner())
                .remove(&self.id);
        }
    }
}

async fn writer_loop(
    mut stdin: ChildStdin,
    mut receiver: mpsc::Receiver<WriterCommand>,
    inner: Weak<ClientInner>,
    shutdown: CancellationToken,
) {
    loop {
        let command = tokio::select! {
            _ = shutdown.cancelled() => break,
            command = receiver.recv() => command,
        };
        match command {
            Some(WriterCommand::Frame(frame)) => {
                if let Err(error) = stdin.write_all(&frame).await {
                    if let Some(inner) = inner.upgrade() {
                        inner.mark_closed(format!("failed writing app-server stdin: {error}"));
                    }
                    return;
                }
                if let Err(error) = stdin.flush().await {
                    if let Some(inner) = inner.upgrade() {
                        inner.mark_closed(format!("failed flushing app-server stdin: {error}"));
                    }
                    return;
                }
            }
            Some(WriterCommand::Close) | None => break,
        }
    }
    let _ = stdin.shutdown().await;
}

async fn stdout_loop(stdout: ChildStdout, inner: Weak<ClientInner>) {
    let mut reader = BufReader::new(stdout);
    loop {
        let Some(inner) = inner.upgrade() else {
            return;
        };
        let line =
            match read_bounded_line(&mut reader, inner.options.max_line_bytes, "inbound").await {
                Ok(Some(line)) => line,
                Ok(None) => {
                    if !inner.graceful_shutdown.load(Ordering::Acquire) {
                        inner.mark_closed("app-server stdout closed unexpectedly");
                    }
                    return;
                }
                Err(error) => {
                    inner.mark_closed(error.to_string());
                    return;
                }
            };
        let message: Value = match serde_json::from_slice(&line) {
            Ok(message) => message,
            Err(error) => {
                inner.mark_closed(format!("invalid JSONL from app-server: {error}"));
                return;
            }
        };
        if message.get("jsonrpc").is_some() {
            inner.mark_closed("app-server message unexpectedly contained a jsonrpc field");
            return;
        }
        if let Err(error) = handle_incoming(&inner, message) {
            inner.mark_closed(error.to_string());
            return;
        }
    }
}

fn handle_incoming(inner: &Arc<ClientInner>, message: Value) -> Result<()> {
    let object = message
        .as_object()
        .ok_or_else(|| CodexError::Protocol("top-level message must be an object".into()))?;
    if let Some(method) = object.get("method").and_then(Value::as_str) {
        let params = object.get("params").cloned().unwrap_or(Value::Null);
        if let Some(id_value) = object.get("id") {
            let id: RpcId = serde_json::from_value(id_value.clone())?;
            handle_server_request(inner, id, method.to_owned(), params)?;
        } else {
            handle_notification(inner, method, params)?;
        }
        return Ok(());
    }

    let id_value = object
        .get("id")
        .ok_or_else(|| CodexError::Protocol("response omitted id".into()))?;
    let id: RpcId = serde_json::from_value(id_value.clone())?;
    let sender = inner
        .pending
        .lock()
        .unwrap_or_else(|poison| poison.into_inner())
        .remove(&id);
    let Some(sender) = sender else {
        debug!(?id, "discarding response for an expired Codex request");
        return Ok(());
    };
    let response = match (object.get("result"), object.get("error")) {
        (Some(result), None) => Ok(result.clone()),
        (None, Some(error)) => {
            let error: RpcErrorPayload = serde_json::from_value(error.clone())?;
            Err(PendingError::Rpc(redact_rpc_error(error)))
        }
        _ => {
            return Err(CodexError::Protocol(
                "response must contain exactly one of result or error".into(),
            ))
        }
    };
    let _ = sender.send(response);
    Ok(())
}

fn handle_notification(inner: &ClientInner, method: &str, params: Value) -> Result<()> {
    let notification = match method {
        "account/login/completed" => {
            let mut completed: AccountLoginCompleted = serde_json::from_value(params)?;
            completed.error = completed.error.map(|error| redact_text(&error));
            CodexNotification::AccountLoginCompleted(completed)
        }
        "account/updated" => {
            CodexNotification::AccountUpdated(serde_json::from_value::<AccountUpdated>(params)?)
        }
        _ => {
            let mut params = params;
            redact_value(&mut params);
            CodexNotification::Other {
                method: method.to_owned(),
                params,
            }
        }
    };
    let _ = inner.notifications.send(notification);
    Ok(())
}

fn handle_server_request(
    inner: &Arc<ClientInner>,
    id: RpcId,
    method: String,
    params: Value,
) -> Result<()> {
    // External token refresh belongs to Codex-managed auth and is never
    // delegated through Kody's generic server-request stream.
    if method.to_ascii_lowercase().contains("chatgptauthtokens") {
        send_automatic_rejection(
            Arc::downgrade(inner),
            id,
            -32601,
            "external token auth is not supported by Kody",
        );
        return Ok(());
    }
    {
        let mut requests = inner
            .incoming_requests
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        if !requests.insert(id.clone()) {
            return Err(CodexError::Protocol(format!(
                "duplicate server request id {id:?}"
            )));
        }
    }
    let request = CodexServerRequest {
        id: id.clone(),
        method,
        params,
    };
    if inner.server_requests.send(request).is_err() {
        inner
            .incoming_requests
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .remove(&id);
        send_automatic_rejection(
            Arc::downgrade(inner),
            id,
            -32601,
            "no Kody server-request handler is subscribed",
        );
        return Ok(());
    }

    let weak = Arc::downgrade(inner);
    let duration = inner.options.server_request_timeout;
    tokio::spawn(async move {
        tokio::time::sleep(duration).await;
        let Some(inner) = weak.upgrade() else {
            return;
        };
        let expired = inner
            .incoming_requests
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .remove(&id);
        if expired {
            send_automatic_rejection(
                Arc::downgrade(&inner),
                id,
                -32001,
                "Kody server-request handler timed out",
            );
        }
    });
    Ok(())
}

fn send_automatic_rejection(inner: Weak<ClientInner>, id: RpcId, code: i64, message: &'static str) {
    tokio::spawn(async move {
        let Some(inner) = inner.upgrade() else {
            return;
        };
        let envelope = json!({
            "id": id,
            "error": { "code": code, "message": message }
        });
        let frame = match encode_frame(&envelope, inner.options.max_line_bytes, "outbound") {
            Ok(frame) => frame,
            Err(error) => {
                inner.mark_closed(error.to_string());
                return;
            }
        };
        match timeout(
            inner.options.request_timeout,
            inner.writer.send(WriterCommand::Frame(frame)),
        )
        .await
        {
            Ok(Ok(())) => {}
            Ok(Err(_)) => inner.mark_closed("request queue closed while rejecting server request"),
            Err(_) => inner.mark_closed("request queue stalled while rejecting server request"),
        }
    });
}

async fn stderr_loop(stderr: ChildStderr, inner: Weak<ClientInner>) {
    let mut reader = BufReader::new(stderr);
    loop {
        let Some(inner) = inner.upgrade() else {
            return;
        };
        match read_bounded_line(&mut reader, inner.options.max_line_bytes, "stderr").await {
            Ok(Some(line)) => inner.append_stderr(&String::from_utf8_lossy(&line)),
            Ok(None) => return,
            Err(error) => {
                inner.append_stderr(&error.to_string());
                inner.mark_closed(error.to_string());
                return;
            }
        }
    }
}

async fn supervise_child(mut child: Child, inner: Weak<ClientInner>, shutdown: CancellationToken) {
    let mut forced = false;
    let status = tokio::select! {
        result = child.wait() => result,
        _ = shutdown.cancelled() => {
            forced = true;
            let _ = child.start_kill();
            child.wait().await
        }
    };
    let Some(inner) = inner.upgrade() else {
        return;
    };
    let graceful = inner.graceful_shutdown.load(Ordering::Acquire);
    let stderr = inner
        .stderr_tail
        .lock()
        .unwrap_or_else(|poison| poison.into_inner())
        .clone();
    let reason = match status {
        Ok(status) if graceful => format!("shutdown completed with {status}"),
        Ok(status) => {
            let suffix = if stderr.trim().is_empty() {
                String::new()
            } else {
                format!("; stderr: {}", stderr.trim())
            };
            format!("app-server exited with {status}{suffix}")
        }
        Err(error) => format!("failed waiting for app-server process: {error}"),
    };
    if forced && !graceful {
        warn!(%reason, "Codex sidecar was terminated after a transport failure");
    }
    inner.mark_closed(reason);
}

async fn read_bounded_line<R>(
    reader: &mut R,
    limit: usize,
    direction: &'static str,
) -> Result<Option<Vec<u8>>>
where
    R: AsyncBufRead + Unpin,
{
    let mut line = Vec::with_capacity(1024.min(limit));
    loop {
        let (consumed, found_newline) = {
            let available = reader.fill_buf().await.map_err(|source| CodexError::Io {
                operation: "reading app-server output",
                source,
            })?;
            if available.is_empty() {
                if line.is_empty() {
                    return Ok(None);
                }
                return Ok(Some(line));
            }
            let newline = available.iter().position(|byte| *byte == b'\n');
            let content = newline.unwrap_or(available.len());
            if line.len().saturating_add(content) > limit {
                return Err(CodexError::LineTooLong { direction, limit });
            }
            line.extend_from_slice(&available[..content]);
            (
                newline.map_or(content, |position| position + 1),
                newline.is_some(),
            )
        };
        reader.consume(consumed);
        if found_newline {
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            return Ok(Some(line));
        }
    }
}

fn encode_frame(value: &Value, limit: usize, direction: &'static str) -> Result<Vec<u8>> {
    let mut frame = serde_json::to_vec(value)?;
    if frame.len() > limit {
        return Err(CodexError::LineTooLong { direction, limit });
    }
    frame.push(b'\n');
    Ok(frame)
}

fn parse_chatgpt_login(value: Value) -> Result<ChatGptLogin> {
    let kind = value.get("type").and_then(Value::as_str);
    if kind != Some("chatgpt") {
        return Err(CodexError::Protocol(
            "account/login/start returned the wrong login type".into(),
        ));
    }
    let login_id = required_string(&value, "loginId")?;
    let auth_url = required_string(&value, "authUrl")?;
    Ok(ChatGptLogin { login_id, auth_url })
}

fn parse_device_code_login(value: Value) -> Result<DeviceCodeLogin> {
    let kind = value.get("type").and_then(Value::as_str);
    if kind != Some("chatgptDeviceCode") {
        return Err(CodexError::Protocol(
            "account/login/start returned the wrong device login type".into(),
        ));
    }
    Ok(DeviceCodeLogin {
        login_id: required_string(&value, "loginId")?,
        user_code: required_string(&value, "userCode")?,
        verification_url: required_string(&value, "verificationUrl")?,
    })
}

fn required_string(value: &Value, field: &str) -> Result<String> {
    value
        .get(field)
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| CodexError::Protocol(format!("response omitted string field '{field}'")))
}

fn trim_utf8_prefix(text: &mut String, max_bytes: usize) {
    if text.len() <= max_bytes {
        return;
    }
    let mut start = text.len() - max_bytes;
    while !text.is_char_boundary(start) {
        start += 1;
    }
    text.drain(..start);
}
