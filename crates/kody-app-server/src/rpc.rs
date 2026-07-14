use std::{collections::HashSet, path::PathBuf, sync::Arc};

use kody_core::{
    provider::{
        OpenAiCompatibleConfig, OpenAiCompatibleProvider, OpenAiResponsesConfig,
        OpenAiResponsesProvider,
    },
    ApprovalId, ContextReference, InteractionId, KodyEngine, KodyError, ProcessId, ProjectId,
    StartTurn, ThreadId, TurnId, UserInputAnswers, DEFAULT_THREAD_TITLE,
};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;

use crate::server::{AppState, CreateRequestRecord};

#[derive(Debug, Clone, Deserialize)]
pub struct RpcRequest {
    #[serde(default = "jsonrpc_version")]
    pub jsonrpc: String,
    #[serde(default)]
    pub id: Option<Value>,
    pub method: String,
    #[serde(default)]
    pub params: Value,
}

fn jsonrpc_version() -> String {
    "2.0".into()
}

#[derive(Debug, Clone, Serialize)]
pub struct RpcResponse {
    pub jsonrpc: &'static str,
    pub id: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<RpcError>,
}

impl RpcResponse {
    pub fn success(id: Value, result: Value) -> Self {
        Self {
            jsonrpc: "2.0",
            id,
            result: Some(result),
            error: None,
        }
    }

    pub fn error(id: Value, error: RpcError) -> Self {
        Self {
            jsonrpc: "2.0",
            id,
            result: None,
            error: Some(error),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct RpcError {
    pub code: i32,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

impl RpcError {
    pub fn parse(error: impl ToString) -> Self {
        Self {
            code: -32700,
            message: "Parse error".into(),
            data: Some(json!({ "detail": error.to_string() })),
        }
    }

    pub fn invalid_request(message: impl Into<String>) -> Self {
        Self {
            code: -32600,
            message: message.into(),
            data: None,
        }
    }

    pub fn method_not_found(method: &str) -> Self {
        Self {
            code: -32601,
            message: format!("method '{method}' was not found"),
            data: None,
        }
    }

    pub fn invalid_params(error: impl ToString) -> Self {
        Self {
            code: -32602,
            message: "Invalid params".into(),
            data: Some(json!({ "detail": error.to_string() })),
        }
    }
}

impl From<KodyError> for RpcError {
    fn from(error: KodyError) -> Self {
        let code = match error {
            KodyError::ProjectNotFound(_)
            | KodyError::ThreadNotFound(_)
            | KodyError::WorkspaceNotFound(_)
            | KodyError::TurnNotFound(_)
            | KodyError::MessageNotFound(_)
            | KodyError::ProcessNotFound(_)
            | KodyError::ProviderNotFound(_)
            | KodyError::ToolNotFound(_) => -32004,
            KodyError::Conflict(_) => -32009,
            KodyError::InvalidInput(_) => -32602,
            KodyError::Cancelled => -32800,
            KodyError::Provider(_) => -32020,
            KodyError::Tool(_) => -32021,
            _ => -32603,
        };
        Self {
            code,
            message: error.to_string(),
            data: None,
        }
    }
}

#[derive(Clone)]
pub struct RpcDispatcher {
    state: AppState,
}

impl RpcDispatcher {
    pub fn new(state: AppState) -> Self {
        Self { state }
    }

    /// Executes a request. JSON-RPC notifications (requests without an id) are
    /// executed but deliberately produce no response.
    pub async fn handle(&self, request: RpcRequest) -> Option<RpcResponse> {
        let id = request.id.clone();
        let result = if request.jsonrpc != "2.0" {
            Err(RpcError::invalid_request("jsonrpc must be '2.0'"))
        } else {
            self.dispatch(&request.method, request.params).await
        };

        id.map(|id| match result {
            Ok(value) => RpcResponse::success(id, value),
            Err(error) => RpcResponse::error(id, error),
        })
    }

    async fn dispatch(&self, method: &str, params: Value) -> Result<Value, RpcError> {
        match method {
            "initialize" => Ok(initialize_result()),
            "provider/list" | "provider.list" => {
                let providers = self
                    .state
                    .engine
                    .providers()
                    .descriptors()
                    .map_err(RpcError::from)?;
                Ok(json!({ "providers": providers }))
            }
            "provider/models" | "provider.models" => {
                let params: ProviderIdParams = parse_params(params)?;
                let provider = self
                    .state
                    .engine
                    .providers()
                    .get(&params.provider_id)
                    .map_err(RpcError::from)?;
                let models = provider.list_models().await.map_err(RpcError::from)?;
                Ok(json!({ "models": models }))
            }
            "provider/health" | "provider.health" => {
                let params: ProviderIdParams = parse_params(params)?;
                let provider = self
                    .state
                    .engine
                    .providers()
                    .get(&params.provider_id)
                    .map_err(RpcError::from)?;
                let health = provider.health().await.map_err(RpcError::from)?;
                serde_json::to_value(health).map_err(RpcError::invalid_params)
            }
            // These mutation methods are intended for the authenticated
            // Electron main process. The renderer IPC allowlist deliberately
            // does not expose them, so API keys never cross into web content.
            "provider/configure" | "provider.configure" => {
                let params: ConfigureProviderParams = parse_params(params)?;
                if params.id == "echo" || params.id == "codex" {
                    return Err(RpcError::from(KodyError::Conflict(format!(
                        "built-in provider '{}' cannot be replaced",
                        params.id
                    ))));
                }
                let provider: Arc<dyn kody_core::ModelProvider> = match params.kind.as_str() {
                    "openai" => {
                        let mut config = OpenAiResponsesConfig::new(
                            params.id.clone(),
                            params
                                .base_url
                                .unwrap_or_else(|| "https://api.openai.com/v1".into()),
                        );
                        config.display_name = params.display_name;
                        config.api_key = params.api_key;
                        config.require_api_key = true;
                        config.default_model = Some(params.default_model);
                        config.configured_models = params.custom_models;
                        Arc::new(OpenAiResponsesProvider::new(config).map_err(RpcError::from)?)
                    }
                    "openai-compatible" => {
                        let mut config = OpenAiCompatibleConfig::new(
                            params.id.clone(),
                            params.base_url.ok_or_else(|| {
                                RpcError::invalid_params(
                                    "base_url is required for an OpenAI-compatible provider",
                                )
                            })?,
                        );
                        config.display_name = params.display_name;
                        config.api_key = params.api_key;
                        config.default_model = Some(params.default_model);
                        config.configured_models = params.custom_models;
                        Arc::new(OpenAiCompatibleProvider::new(config).map_err(RpcError::from)?)
                    }
                    unsupported => {
                        return Err(RpcError::invalid_params(format!(
                            "provider kind '{unsupported}' is not supported by this runtime"
                        )))
                    }
                };
                self.state
                    .engine
                    .providers()
                    .replace(provider.clone())
                    .map_err(RpcError::from)?;
                serde_json::to_value(provider.descriptor()).map_err(RpcError::invalid_params)
            }
            "provider/remove" | "provider.remove" => {
                let params: ProviderIdParams = parse_params(params)?;
                if params.provider_id == "echo" || params.provider_id == "codex" {
                    return Err(RpcError::from(KodyError::Conflict(format!(
                        "built-in provider '{}' cannot be removed",
                        params.provider_id
                    ))));
                }
                let removed = self
                    .state
                    .engine
                    .providers()
                    .remove(&params.provider_id)
                    .map_err(RpcError::from)?
                    .is_some();
                Ok(json!({ "removed": removed }))
            }
            "codex/account/read" | "codex.account.read" => match self.state.codex.client().await {
                Ok(client) => match self.state.codex.account_read().await {
                    Ok(account) => Ok(json!({
                        "state": if account.account.is_some() { "signed_in" } else { "signed_out" },
                        "account": account.account.map(|account| json!({
                            "account_type": account.account_type,
                            "email": account.email,
                            "plan_type": account.plan_type,
                        })),
                        "requires_openai_auth": account.requires_openai_auth,
                        "binary": {
                            "path": client.binary().path(),
                            "version": client.binary().version(),
                        }
                    })),
                    Err(error) => Ok(json!({
                        "state": "unavailable",
                        "detail": error.to_string(),
                    })),
                },
                Err(error) => Ok(json!({
                    "state": "unavailable",
                    "detail": error.to_string(),
                })),
            },
            "codex/account/rate-limits" | "codex.account.rate-limits" => {
                let limits = self
                    .state
                    .codex
                    .client()
                    .await
                    .map_err(|error| RpcError::from(KodyError::Provider(error.to_string())))?
                    .rate_limits_read()
                    .await
                    .map_err(|error| RpcError::from(KodyError::Provider(error.to_string())))?;
                serde_json::to_value(limits).map_err(RpcError::invalid_params)
            }
            "codex/account/login/start" | "codex.account.login.start" => {
                let params: CodexLoginParams = parse_params(params)?;
                let client = self
                    .state
                    .codex
                    .client()
                    .await
                    .map_err(|error| RpcError::from(KodyError::Provider(error.to_string())))?;
                match params.mode.as_str() {
                    "browser" => {
                        let login = client.login_chatgpt().await.map_err(|error| {
                            RpcError::from(KodyError::Provider(error.to_string()))
                        })?;
                        Ok(json!({
                            "mode": "browser",
                            "login_id": login.login_id,
                            "auth_url": login.auth_url,
                        }))
                    }
                    "device_code" => {
                        let login = client.login_device_code().await.map_err(|error| {
                            RpcError::from(KodyError::Provider(error.to_string()))
                        })?;
                        Ok(json!({
                            "mode": "device_code",
                            "login_id": login.login_id,
                            "user_code": login.user_code,
                            "verification_url": login.verification_url,
                        }))
                    }
                    _ => Err(RpcError::invalid_params(
                        "Codex login mode must be 'browser' or 'device_code'",
                    )),
                }
            }
            "codex/account/login/cancel" | "codex.account.login.cancel" => {
                let params: CodexCancelLoginParams = parse_params(params)?;
                let result = self
                    .state
                    .codex
                    .client()
                    .await
                    .map_err(|error| RpcError::from(KodyError::Provider(error.to_string())))?
                    .cancel_login(params.login_id)
                    .await
                    .map_err(|error| RpcError::from(KodyError::Provider(error.to_string())))?;
                Ok(json!({
                    "status": match result.status {
                        crate::codex::CancelLoginStatus::Canceled => "canceled",
                        crate::codex::CancelLoginStatus::NotFound => "not_found",
                    }
                }))
            }
            "codex/account/logout" | "codex.account.logout" => {
                self.state
                    .codex
                    .client()
                    .await
                    .map_err(|error| RpcError::from(KodyError::Provider(error.to_string())))?
                    .logout()
                    .await
                    .map_err(|error| RpcError::from(KodyError::Provider(error.to_string())))?;
                self.state.codex.mark_signed_out();
                Ok(json!({ "signed_out": true }))
            }
            "tool/list" | "tool.list" => Ok(json!({
                "tools": self.state.engine.tools().definitions()
            })),
            "project/import" | "project.import" => {
                let params: ProjectPathParams = parse_params(params)?;
                let project = self
                    .state
                    .engine
                    .import_project(params.path, params.name)
                    .await
                    .map_err(RpcError::from)?;
                serde_json::to_value(project).map_err(RpcError::invalid_params)
            }
            "project/create" | "project.create" => {
                let params: ProjectPathParams = parse_params(params)?;
                let project = self
                    .state
                    .engine
                    .create_project(params.path, params.name)
                    .await
                    .map_err(RpcError::from)?;
                serde_json::to_value(project).map_err(RpcError::invalid_params)
            }
            "project/list" | "project.list" => {
                let projects = self
                    .state
                    .engine
                    .store()
                    .list_projects()
                    .await
                    .map_err(RpcError::from)?;
                Ok(json!({ "projects": projects }))
            }
            "project/get" | "project.get" => {
                let params: ProjectGetParams = parse_params(params)?;
                let project = self
                    .state
                    .engine
                    .store()
                    .get_project(params.project_id)
                    .await
                    .map_err(RpcError::from)?;
                serde_json::to_value(project).map_err(RpcError::invalid_params)
            }
            "thread/create" | "thread.create" => {
                let params: ThreadCreateParams = parse_params(params)?;
                let (thread, workspace, project) = self
                    .state
                    .engine
                    .create_thread(params.title, params.working_directory)
                    .await
                    .map_err(RpcError::from)?;
                Ok(json!({
                    "thread": thread,
                    "workspace": workspace,
                    "imported_project": project,
                }))
            }
            "thread/create-and-start" | "thread.create-and-start" => {
                let (value, prepared) = self.create_and_prepare_thread(params).await?;
                if let Some((turn_id, cancellation)) = prepared {
                    self.state.turns.execute_prepared(
                        self.state.engine.runtime().clone(),
                        turn_id,
                        cancellation,
                    );
                }
                Ok(value)
            }
            "thread/list" | "thread.list" => {
                let threads = self
                    .state
                    .engine
                    .store()
                    .list_threads()
                    .await
                    .map_err(RpcError::from)?;
                Ok(json!({ "threads": threads }))
            }
            "thread/get" | "thread.get" => {
                let params: ThreadGetParams = parse_params(params)?;
                let store = self.state.engine.store();
                let thread = store
                    .get_thread(params.thread_id)
                    .await
                    .map_err(RpcError::from)?;
                let workspace = store
                    .get_workspace(thread.workspace_id)
                    .await
                    .map_err(RpcError::from)?;
                let messages = store
                    .list_messages(thread.id)
                    .await
                    .map_err(RpcError::from)?;
                let turns = store.list_turns(thread.id).await.map_err(RpcError::from)?;
                let pending_approvals = self
                    .state
                    .engine
                    .runtime()
                    .approvals()
                    .list(Some(thread.id))
                    .await;
                let pending_user_inputs = self
                    .state
                    .engine
                    .runtime()
                    .user_inputs()
                    .list(Some(thread.id))
                    .await;
                let processes = self
                    .state
                    .engine
                    .processes()
                    .list(thread.id)
                    .await
                    .map_err(RpcError::from)?;
                Ok(json!({
                    "thread": thread,
                    "workspace": workspace,
                    "messages": messages,
                    "turns": turns,
                    "pending_approvals": pending_approvals,
                    "pending_user_inputs": pending_user_inputs,
                    "processes": processes,
                }))
            }
            "thread/reference/add" | "thread.reference.add" => {
                let params: AddReferenceParams = parse_params(params)?;
                let thread = self
                    .state
                    .engine
                    .add_default_reference(params.thread_id, params.reference)
                    .await
                    .map_err(RpcError::from)?;
                serde_json::to_value(thread).map_err(RpcError::invalid_params)
            }
            "thread/messages" | "thread.messages" => {
                let params: ThreadGetParams = parse_params(params)?;
                let messages = self
                    .state
                    .engine
                    .store()
                    .list_messages(params.thread_id)
                    .await
                    .map_err(RpcError::from)?;
                Ok(json!({ "messages": messages }))
            }
            "turn/start" | "turn.start" => {
                let params: StartTurn = parse_params(params)?;
                let turn = self
                    .state
                    .turns
                    .start(self.state.engine.runtime().clone(), params)
                    .await
                    .map_err(RpcError::from)?;
                serde_json::to_value(turn).map_err(RpcError::invalid_params)
            }
            "turn/get" | "turn.get" => {
                let params: TurnGetParams = parse_params(params)?;
                let turn = self
                    .state
                    .engine
                    .store()
                    .get_turn(params.turn_id)
                    .await
                    .map_err(RpcError::from)?;
                serde_json::to_value(turn).map_err(RpcError::invalid_params)
            }
            "turn/cancel" | "turn.cancel" => {
                let params: TurnGetParams = parse_params(params)?;
                let cancelled = self.state.turns.cancel(params.turn_id).await;
                Ok(json!({ "cancelled": cancelled }))
            }
            "approval/respond" | "approval.respond" => {
                let params: ApprovalResponseParams = parse_params(params)?;
                let resolved = self
                    .state
                    .engine
                    .runtime()
                    .approvals()
                    .respond(params.approval_id, params.approved)
                    .await
                    .map_err(RpcError::from)?;
                Ok(json!({ "resolved": resolved }))
            }
            "user-input/respond" | "user-input.respond" => {
                let params: UserInputResponseParams = parse_params(params)?;
                self.state
                    .engine
                    .runtime()
                    .user_inputs()
                    .respond(params.interaction_id, params.answers, params.cancelled)
                    .await
                    .map_err(RpcError::from)?;
                Ok(json!({ "resolved": true }))
            }
            "process/list" | "process.list" => {
                let params: ThreadGetParams = parse_params(params)?;
                let processes = self
                    .state
                    .engine
                    .processes()
                    .list(params.thread_id)
                    .await
                    .map_err(RpcError::from)?;
                Ok(json!({ "processes": processes }))
            }
            "process/get" | "process.get" => {
                let params: ProcessGetParams = parse_params(params)?;
                let process = self
                    .state
                    .engine
                    .processes()
                    .get_for_thread(params.thread_id, params.process_id)
                    .await
                    .map_err(RpcError::from)?;
                serde_json::to_value(process).map_err(RpcError::invalid_params)
            }
            "process/read-output" | "process.read-output" => {
                let params: ProcessOutputParams = parse_params(params)?;
                let page = self
                    .state
                    .engine
                    .processes()
                    .read_output(
                        params.thread_id,
                        params.process_id,
                        params.after_cursor,
                        params.limit,
                    )
                    .await
                    .map_err(RpcError::from)?;
                serde_json::to_value(page).map_err(RpcError::invalid_params)
            }
            "process/stop" | "process.stop" => {
                let params: ProcessGetParams = parse_params(params)?;
                let process = self
                    .state
                    .engine
                    .processes()
                    .stop(params.thread_id, params.process_id)
                    .await
                    .map_err(RpcError::from)?;
                serde_json::to_value(process).map_err(RpcError::invalid_params)
            }
            _ => Err(RpcError::method_not_found(method)),
        }
    }

    /// Creates the durable Thread unit and prepares its first Turn while the
    /// caller decides when execution begins. WebSocket callers subscribe to
    /// the new Thread before starting execution so no early events are lost.
    pub(crate) async fn create_and_prepare_thread(
        &self,
        params: Value,
    ) -> Result<(Value, Option<(TurnId, CancellationToken)>), RpcError> {
        let params: CreateThreadAndStartParams = parse_params(params)?;
        let request_id = params.client_request_id.trim().to_owned();
        if request_id.is_empty() || request_id.len() > 256 {
            return Err(RpcError::invalid_params(
                "client_request_id must be between 1 and 256 characters",
            ));
        }
        let fingerprint = create_request_fingerprint(&params)?;

        // Holding this small process-local lock serializes only first-message
        // creation and makes concurrent retries with one request ID idempotent.
        let mut requests = self.state.create_requests.lock().await;
        if let Some(existing) = requests.get(&request_id).cloned() {
            if existing.fingerprint != fingerprint {
                return Err(RpcError::from(KodyError::Conflict(format!(
                    "client_request_id '{request_id}' was already used with different parameters"
                ))));
            }
            let value =
                hydrate_create_response(self.state.engine.store().as_ref(), &existing).await?;
            return Ok((value, None));
        }

        let store = self.state.engine.store();
        let existing_projects = store
            .list_projects()
            .await
            .map_err(RpcError::from)?
            .into_iter()
            .map(|project| project.id)
            .collect::<HashSet<_>>();
        let (thread, workspace, imported_project) = self
            .state
            .engine
            .create_thread(DEFAULT_THREAD_TITLE, params.working_directory)
            .await
            .map_err(RpcError::from)?;
        let start = StartTurn {
            thread_id: thread.id,
            message: params.message,
            references: params.references,
            provider: params.provider,
            model: params.model,
            permission_mode: params.permission_mode,
            temperature: None,
            max_output_tokens: None,
        };
        let (turn, cancellation) = match self
            .state
            .turns
            .prepare(self.state.engine.runtime().clone(), start)
            .await
        {
            Ok(prepared) => prepared,
            Err(error) => {
                let _ = store.delete_thread(thread.id).await;
                let _ = tokio::fs::remove_dir_all(&workspace.root).await;
                if let Some(project) = &imported_project {
                    if !existing_projects.contains(&project.id) {
                        let _ = store.delete_project(project.id).await;
                    }
                }
                return Err(RpcError::from(error));
            }
        };
        let record = CreateRequestRecord {
            fingerprint,
            thread_id: thread.id,
            workspace_id: workspace.id,
            turn_id: turn.id,
            project_id: imported_project.as_ref().map(|project| project.id),
        };
        let value = hydrate_create_response(store.as_ref(), &record).await?;
        requests.insert(request_id, record);
        Ok((value, Some((turn.id, cancellation))))
    }
}

#[derive(Serialize)]
struct CreateRequestFingerprint<'a> {
    message: &'a str,
    references: &'a [ContextReference],
    provider: &'a str,
    model: &'a Option<String>,
    permission_mode: &'a Option<kody_core::PermissionMode>,
    working_directory: &'a Option<PathBuf>,
}

fn create_request_fingerprint(params: &CreateThreadAndStartParams) -> Result<String, RpcError> {
    serde_json::to_string(&CreateRequestFingerprint {
        message: &params.message,
        references: &params.references,
        provider: &params.provider,
        model: &params.model,
        permission_mode: &params.permission_mode,
        working_directory: &params.working_directory,
    })
    .map_err(RpcError::invalid_params)
}

async fn hydrate_create_response(
    store: &dyn kody_core::StateStore,
    record: &CreateRequestRecord,
) -> Result<Value, RpcError> {
    let thread = store
        .get_thread(record.thread_id)
        .await
        .map_err(RpcError::from)?;
    let workspace = store
        .get_workspace(record.workspace_id)
        .await
        .map_err(RpcError::from)?;
    let turn = store
        .get_turn(record.turn_id)
        .await
        .map_err(RpcError::from)?;
    let imported_project = match record.project_id {
        Some(project_id) => Some(
            store
                .get_project(project_id)
                .await
                .map_err(RpcError::from)?,
        ),
        None => None,
    };
    Ok(json!({
        "thread": thread,
        "workspace": workspace,
        "imported_project": imported_project,
        "turn": turn,
    }))
}

fn parse_params<T: DeserializeOwned>(params: Value) -> Result<T, RpcError> {
    serde_json::from_value(params).map_err(RpcError::invalid_params)
}

fn initialize_result() -> Value {
    json!({
        "server_info": {
            "name": "kody-app-server",
            "version": env!("CARGO_PKG_VERSION"),
        },
        "capabilities": {
            "protocol": "json-rpc-2.0",
            "transports": ["http", "websocket"],
            "event_notification": "turn/event",
            "process_event_notification": "process/event",
            "thread_references": true,
            "project_references": true,
            "thread_create_and_start": true,
            "thread_auto_titles": true,
            "turn_cancellation": true,
            "turn_permission_modes": ["read_only", "ask", "full_access"],
            "tool_approvals": true,
            "structured_user_input": true,
            "managed_processes": true,
            "process_output": true,
            "thread_event_subscriptions": true,
            "provider_plugins": true,
            "provider_model_catalog": true,
            "provider_configuration": true,
            "provider_health": true,
            "codex_chatgpt_auth": true,
            "codex_external_turn_backend": true,
        }
    })
}

#[derive(Debug, Deserialize)]
struct ProjectPathParams {
    path: PathBuf,
    #[serde(default)]
    name: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ProviderIdParams {
    provider_id: String,
}

#[derive(Debug, Deserialize)]
struct ConfigureProviderParams {
    id: String,
    display_name: String,
    kind: String,
    #[serde(default)]
    base_url: Option<String>,
    #[serde(default)]
    api_key: Option<String>,
    default_model: String,
    #[serde(default)]
    custom_models: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct CodexLoginParams {
    mode: String,
}

#[derive(Debug, Deserialize)]
struct CodexCancelLoginParams {
    login_id: String,
}

#[derive(Debug, Deserialize)]
struct ProjectGetParams {
    project_id: ProjectId,
}

#[derive(Debug, Deserialize)]
struct ThreadCreateParams {
    #[serde(default = "default_thread_title")]
    title: String,
    #[serde(default)]
    working_directory: Option<PathBuf>,
}

#[derive(Debug, Deserialize)]
struct CreateThreadAndStartParams {
    client_request_id: String,
    message: String,
    #[serde(default)]
    references: Vec<ContextReference>,
    provider: String,
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    permission_mode: Option<kody_core::PermissionMode>,
    #[serde(default)]
    working_directory: Option<PathBuf>,
}

fn default_thread_title() -> String {
    DEFAULT_THREAD_TITLE.into()
}

#[derive(Debug, Deserialize)]
struct ThreadGetParams {
    thread_id: ThreadId,
}

#[derive(Debug, Deserialize)]
struct AddReferenceParams {
    thread_id: ThreadId,
    reference: ContextReference,
}

#[derive(Debug, Deserialize)]
struct TurnGetParams {
    turn_id: TurnId,
}

#[derive(Debug, Deserialize)]
struct ApprovalResponseParams {
    approval_id: ApprovalId,
    approved: bool,
}

#[derive(Debug, Deserialize)]
struct UserInputResponseParams {
    interaction_id: InteractionId,
    #[serde(default)]
    answers: UserInputAnswers,
    #[serde(default)]
    cancelled: bool,
}

#[derive(Debug, Deserialize)]
struct ProcessGetParams {
    thread_id: ThreadId,
    process_id: ProcessId,
}

#[derive(Debug, Deserialize)]
struct ProcessOutputParams {
    thread_id: ThreadId,
    process_id: ProcessId,
    #[serde(default)]
    after_cursor: Option<u64>,
    #[serde(default)]
    limit: Option<usize>,
}

#[allow(dead_code)]
fn _engine_is_send_sync(_: Arc<KodyEngine>) {}
