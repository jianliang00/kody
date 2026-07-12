use std::{path::PathBuf, sync::Arc};

use cody_core::{
    ApprovalId, CodyEngine, CodyError, ContextReference, ProjectId, StartTurn, ThreadId, TurnId,
};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::{json, Value};

use crate::server::AppState;

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
                Ok(json!({
                    "thread": thread,
                    "workspace": workspace,
                    "messages": messages,
                    "turns": turns,
                    "pending_approvals": pending_approvals,
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
            _ => Err(RpcError::method_not_found(method)),
        }
    }
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
            "thread_references": true,
            "project_references": true,
            "turn_cancellation": true,
            "tool_approvals": true,
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

fn default_thread_title() -> String {
    "New thread".into()
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

#[allow(dead_code)]
fn _engine_is_send_sync(_: Arc<CodyEngine>) {}
