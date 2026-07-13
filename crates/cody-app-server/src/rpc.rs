use std::{collections::HashSet, path::PathBuf, sync::Arc};

use cody_core::{
    ApprovalId, CodyEngine, CodyError, ContextReference, ProcessId, ProjectId, StartTurn, ThreadId,
    TurnId, DEFAULT_THREAD_TITLE,
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

impl From<CodyError> for RpcError {
    fn from(error: CodyError) -> Self {
        let code = match error {
            CodyError::ProjectNotFound(_)
            | CodyError::ThreadNotFound(_)
            | CodyError::WorkspaceNotFound(_)
            | CodyError::TurnNotFound(_)
            | CodyError::MessageNotFound(_)
            | CodyError::ProcessNotFound(_)
            | CodyError::ProviderNotFound(_)
            | CodyError::ToolNotFound(_) => -32004,
            CodyError::Conflict(_) => -32009,
            CodyError::InvalidInput(_) => -32602,
            CodyError::Cancelled => -32800,
            CodyError::Provider(_) => -32020,
            CodyError::Tool(_) => -32021,
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
                    .ids()
                    .map_err(RpcError::from)?;
                Ok(json!({ "providers": providers }))
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
                self.state
                    .engine
                    .runtime()
                    .approvals()
                    .respond(params.approval_id, params.approved)
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
                return Err(RpcError::from(CodyError::Conflict(format!(
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
    working_directory: &'a Option<PathBuf>,
}

fn create_request_fingerprint(params: &CreateThreadAndStartParams) -> Result<String, RpcError> {
    serde_json::to_string(&CreateRequestFingerprint {
        message: &params.message,
        references: &params.references,
        provider: &params.provider,
        model: &params.model,
        working_directory: &params.working_directory,
    })
    .map_err(RpcError::invalid_params)
}

async fn hydrate_create_response(
    store: &dyn cody_core::StateStore,
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
            "name": "cody-app-server",
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
            "tool_approvals": true,
            "managed_processes": true,
            "process_output": true,
            "thread_event_subscriptions": true,
            "provider_plugins": true,
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
fn _engine_is_send_sync(_: Arc<CodyEngine>) {}
