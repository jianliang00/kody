use std::{collections::BTreeMap, sync::Arc};

use async_trait::async_trait;
use serde::Deserialize;
use serde_json::json;
use tokio::fs;

use crate::{
    domain::{ManagedProcess, ProcessId, ProcessOrigin, ProcessStatus, ProjectId},
    error::{KodyError, Result},
    process::{ProcessManager, ProcessOutputPage, StartProcessRequest},
};

use super::{
    builtins::{
        confined_existing_path, sanitized_process_environment, select_root, validate_relative_path,
    },
    Tool, ToolCall, ToolContext, ToolDefinition, ToolRegistry, ToolResult, ToolRisk,
};

const MAX_COMMAND_BYTES: usize = 64 * 1024;
const MAX_CUSTOM_ENVIRONMENT_VARIABLES: usize = 96;
const MAX_CUSTOM_ENVIRONMENT_BYTES: usize = 48 * 1024;
const MAX_ENVIRONMENT_VARIABLES: usize = 128;
const MAX_ENVIRONMENT_BYTES: usize = 64 * 1024;

#[derive(Clone)]
pub struct StartProcessTool {
    manager: Arc<ProcessManager>,
}

impl StartProcessTool {
    pub fn new(manager: Arc<ProcessManager>) -> Self {
        Self { manager }
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct StartProcessArguments {
    command: String,
    #[serde(default)]
    project_id: Option<ProjectId>,
    #[serde(default)]
    cwd: Option<String>,
    #[serde(default)]
    environment: BTreeMap<String, String>,
}

#[async_trait]
impl Tool for StartProcessTool {
    fn definition(&self) -> ToolDefinition {
        ToolDefinition::new(
            "start_process",
            "Start a supervised background command in the thread workspace or a read-write referenced project. The command itself must remain in the foreground and must not daemonize or detach from its process group. It remains alive after this turn completes and must be inspected or stopped with the process tools.",
            json!({
                "type": "object",
                "properties": {
                    "command": {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": MAX_COMMAND_BYTES,
                        "description": "Command passed to the configured shell with -c."
                    },
                    "project_id": {
                        "type": "string",
                        "format": "uuid",
                        "description": "Referenced read-write project to use as the process root; omit for the thread workspace."
                    },
                    "cwd": {
                        "type": "string",
                        "minLength": 1,
                        "description": "Optional relative working directory below the selected root."
                    },
                    "environment": {
                        "type": "object",
                        "maxProperties": MAX_CUSTOM_ENVIRONMENT_VARIABLES,
                        "additionalProperties": { "type": "string" },
                        "description": "Explicit environment additions or overrides. Ambient credentials are never inherited."
                    }
                },
                "required": ["command"],
                "additionalProperties": false
            }),
        )
    }

    fn risk(&self) -> ToolRisk {
        ToolRisk::CommandExecution
    }

    async fn execute(&self, call: &ToolCall, context: &ToolContext) -> Result<ToolResult> {
        let arguments: StartProcessArguments = parse_arguments(call)?;
        validate_command(&arguments.command)?;
        validate_custom_environment(&arguments.environment)?;
        context.check_cancelled()?;

        // A managed command has the same mutation capability as `shell`, so a
        // referenced project must be read-write before it may become the cwd.
        let selected = select_root(context, arguments.project_id, true).await?;
        let cwd = match arguments.cwd {
            Some(relative) => {
                let relative = validate_relative_path(&relative)?;
                let cwd = confined_existing_path(&selected.root, &relative).await?;
                if !fs::metadata(&cwd).await?.is_dir() {
                    return Err(KodyError::InvalidInput(format!(
                        "process cwd '{}' is not a directory",
                        relative.display()
                    )));
                }
                cwd
            }
            None => selected.root.clone(),
        };

        let mut environment = sanitized_process_environment(&selected.root);
        environment.extend(arguments.environment);
        // These values describe and confine the selected execution context;
        // explicit model input cannot point them at an unrelated directory.
        environment.insert(
            "HOME".to_owned(),
            selected.root.to_string_lossy().into_owned(),
        );
        environment.insert("PWD".to_owned(), cwd.to_string_lossy().into_owned());
        environment.insert(
            "CARGO_HOME".to_owned(),
            selected
                .root
                .join(".kody-home/cargo")
                .to_string_lossy()
                .into_owned(),
        );
        validate_environment(&environment)?;

        // Do not select on the Turn cancellation token here. Once spawn has
        // succeeded the manager owns the process independently of this Turn.
        let process = self
            .manager
            .start(StartProcessRequest {
                thread_id: context.thread_id,
                origin: ProcessOrigin {
                    turn_id: context.turn_id,
                    tool_call_id: call.id.clone(),
                },
                project_id: arguments.project_id,
                command: arguments.command,
                cwd,
                environment,
            })
            .await?;

        start_process_result(call, &process)
    }
}

#[derive(Clone)]
pub struct ListProcessesTool {
    manager: Arc<ProcessManager>,
}

impl ListProcessesTool {
    pub fn new(manager: Arc<ProcessManager>) -> Self {
        Self { manager }
    }
}

#[async_trait]
impl Tool for ListProcessesTool {
    fn definition(&self) -> ToolDefinition {
        ToolDefinition::new(
            "list_processes",
            "List every managed background process owned by the current thread, including completed and lost processes.",
            json!({
                "type": "object",
                "properties": {},
                "additionalProperties": false
            }),
        )
    }

    async fn execute(&self, call: &ToolCall, context: &ToolContext) -> Result<ToolResult> {
        let _: EmptyArguments = parse_arguments(call)?;
        let processes = self.manager.list(context.thread_id).await?;
        serialized_result(call, &processes)
    }
}

#[derive(Clone)]
pub struct ReadProcessOutputTool {
    manager: Arc<ProcessManager>,
}

impl ReadProcessOutputTool {
    pub fn new(manager: Arc<ProcessManager>) -> Self {
        Self { manager }
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ReadProcessOutputArguments {
    process_id: ProcessId,
    #[serde(default)]
    cursor: Option<u64>,
    #[serde(default)]
    limit: Option<usize>,
}

#[async_trait]
impl Tool for ReadProcessOutputTool {
    fn definition(&self) -> ToolDefinition {
        let max_read_bytes = self.manager.max_read_bytes();
        ToolDefinition::new(
            "read_process_output",
            "Read bounded stdout/stderr output from one managed process owned by the current thread. Continue from next_cursor while has_more is true.",
            json!({
                "type": "object",
                "properties": {
                    "process_id": {
                        "type": "string",
                        "format": "uuid"
                    },
                    "cursor": {
                        "type": "integer",
                        "minimum": 0,
                        "description": "Merged output byte cursor; omit to begin at the first retained byte."
                    },
                    "limit": {
                        "type": "integer",
                        "minimum": 1,
                        "maximum": max_read_bytes,
                        "default": max_read_bytes,
                        "description": "Maximum output bytes to return."
                    }
                },
                "required": ["process_id"],
                "additionalProperties": false
            }),
        )
    }

    async fn execute(&self, call: &ToolCall, context: &ToolContext) -> Result<ToolResult> {
        let arguments: ReadProcessOutputArguments = parse_arguments(call)?;
        let page = self
            .manager
            .read_output(
                context.thread_id,
                arguments.process_id,
                arguments.cursor,
                arguments.limit,
            )
            .await?;
        output_result(call, &page)
    }
}

#[derive(Clone)]
pub struct StopProcessTool {
    manager: Arc<ProcessManager>,
}

impl StopProcessTool {
    pub fn new(manager: Arc<ProcessManager>) -> Self {
        Self { manager }
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct StopProcessArguments {
    process_id: ProcessId,
}

#[async_trait]
impl Tool for StopProcessTool {
    fn definition(&self) -> ToolDefinition {
        ToolDefinition::new(
            "stop_process",
            "Gracefully stop one managed background process owned by the current thread, escalating to forced termination after the configured grace period.",
            json!({
                "type": "object",
                "properties": {
                    "process_id": {
                        "type": "string",
                        "format": "uuid"
                    }
                },
                "required": ["process_id"],
                "additionalProperties": false
            }),
        )
    }

    fn risk(&self) -> ToolRisk {
        ToolRisk::ProcessControl
    }

    async fn execute(&self, call: &ToolCall, context: &ToolContext) -> Result<ToolResult> {
        let arguments: StopProcessArguments = parse_arguments(call)?;
        let process = self
            .manager
            .stop(context.thread_id, arguments.process_id)
            .await?;
        process_result(call, &process)
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct EmptyArguments {}

pub(super) fn register_process_tools(
    registry: &mut ToolRegistry,
    manager: Arc<ProcessManager>,
) -> Result<()> {
    registry.register(StartProcessTool::new(manager.clone()))?;
    registry.register(ListProcessesTool::new(manager.clone()))?;
    registry.register(ReadProcessOutputTool::new(manager.clone()))?;
    registry.register(StopProcessTool::new(manager))?;
    Ok(())
}

fn parse_arguments<T>(call: &ToolCall) -> Result<T>
where
    T: for<'de> Deserialize<'de>,
{
    serde_json::from_value(call.arguments.clone()).map_err(|error| {
        KodyError::InvalidInput(format!("invalid arguments for '{}': {error}", call.name))
    })
}

fn validate_command(command: &str) -> Result<()> {
    if command.trim().is_empty() {
        return Err(KodyError::InvalidInput(
            "managed process command cannot be empty".to_owned(),
        ));
    }
    if command.len() > MAX_COMMAND_BYTES {
        return Err(KodyError::InvalidInput(format!(
            "managed process command cannot exceed {MAX_COMMAND_BYTES} bytes"
        )));
    }
    if command.contains('\0') {
        return Err(KodyError::InvalidInput(
            "managed process command cannot contain NUL".to_owned(),
        ));
    }
    Ok(())
}

fn validate_environment(environment: &BTreeMap<String, String>) -> Result<()> {
    validate_environment_with_limits(
        environment,
        MAX_ENVIRONMENT_VARIABLES,
        MAX_ENVIRONMENT_BYTES,
    )
}

fn validate_custom_environment(environment: &BTreeMap<String, String>) -> Result<()> {
    validate_environment_with_limits(
        environment,
        MAX_CUSTOM_ENVIRONMENT_VARIABLES,
        MAX_CUSTOM_ENVIRONMENT_BYTES,
    )
}

fn validate_environment_with_limits(
    environment: &BTreeMap<String, String>,
    max_variables: usize,
    max_bytes: usize,
) -> Result<()> {
    if environment.len() > max_variables {
        return Err(KodyError::InvalidInput(format!(
            "environment cannot contain more than {max_variables} variables"
        )));
    }
    let mut bytes = 0usize;
    for (name, value) in environment {
        if name.is_empty() || name.contains('=') || name.contains('\0') {
            return Err(KodyError::InvalidInput(format!(
                "invalid environment variable name '{name}'"
            )));
        }
        if value.contains('\0') {
            return Err(KodyError::InvalidInput(format!(
                "environment variable '{name}' contains NUL"
            )));
        }
        bytes = bytes
            .checked_add(name.len())
            .and_then(|total| total.checked_add(value.len()))
            .ok_or_else(|| KodyError::InvalidInput("environment is too large".to_owned()))?;
    }
    if bytes > max_bytes {
        return Err(KodyError::InvalidInput(format!(
            "environment cannot exceed {max_bytes} bytes"
        )));
    }
    Ok(())
}

fn process_result(call: &ToolCall, process: &ManagedProcess) -> Result<ToolResult> {
    serialized_result(call, process)
}

fn start_process_result(call: &ToolCall, process: &ManagedProcess) -> Result<ToolResult> {
    let metadata = serde_json::to_value(process)?;
    let content = serde_json::to_string(process)?;
    if matches!(process.status, ProcessStatus::Failed | ProcessStatus::Lost) {
        Ok(ToolResult::error(call, content, metadata))
    } else {
        Ok(ToolResult::success(call, content, metadata))
    }
}

fn output_result(call: &ToolCall, page: &ProcessOutputPage) -> Result<ToolResult> {
    serialized_result(call, page)
}

fn serialized_result<T>(call: &ToolCall, value: &T) -> Result<ToolResult>
where
    T: serde::Serialize,
{
    let metadata = serde_json::to_value(value)?;
    let content = serde_json::to_string(value)?;
    Ok(ToolResult::success(call, content, metadata))
}

#[cfg(test)]
mod tests {
    use std::{os::unix::fs::symlink, time::Duration};

    use chrono::Utc;
    use serde_json::json;
    use tempfile::TempDir;
    use tokio_util::sync::CancellationToken;

    use crate::{
        domain::{Project, ProjectAccess, ProjectKind, ThreadId, TurnId, Workspace, WorkspaceId},
        process::ProcessManagerConfig,
        provider::EchoProvider,
        runtime::StartTurn,
        store::InMemoryStore,
        tools::ProjectBinding,
        EngineConfig, KodyEngine,
    };

    use super::*;

    fn manager(log_root: &TempDir) -> Arc<ProcessManager> {
        Arc::new(
            ProcessManager::new(
                Arc::new(InMemoryStore::default()),
                ProcessManagerConfig::new(log_root.path()),
            )
            .unwrap(),
        )
    }

    fn context(workspace_root: &TempDir, projects: Vec<ProjectBinding>) -> ToolContext {
        let thread_id = ThreadId::new();
        ToolContext::new(
            thread_id,
            TurnId::new(),
            Workspace {
                id: WorkspaceId::new(),
                thread_id,
                root: workspace_root.path().to_owned(),
                created_at: Utc::now(),
            },
            projects,
            CancellationToken::new(),
        )
    }

    #[test]
    fn environment_validation_rejects_non_portable_and_unbounded_input() {
        let mut invalid_name = BTreeMap::new();
        invalid_name.insert("A=B".to_owned(), "value".to_owned());
        assert!(validate_environment(&invalid_name).is_err());

        let mut oversized = BTreeMap::new();
        oversized.insert("VALUE".to_owned(), "x".repeat(MAX_ENVIRONMENT_BYTES));
        assert!(validate_environment(&oversized).is_err());
    }

    #[tokio::test]
    async fn start_process_rejects_a_symlink_cwd_outside_the_selected_root() {
        let workspace = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();
        let logs = TempDir::new().unwrap();
        symlink(outside.path(), workspace.path().join("escape")).unwrap();
        let tool = StartProcessTool::new(manager(&logs));
        let call = ToolCall::new(
            "call-1",
            "start_process",
            json!({ "command": "pwd", "cwd": "escape" }),
        );

        let error = tool
            .execute(&call, &context(&workspace, Vec::new()))
            .await
            .unwrap_err();
        assert!(matches!(error, KodyError::InvalidInput(message) if message.contains("outside")));
    }

    #[tokio::test]
    async fn start_process_rejects_a_read_only_project() {
        let workspace = TempDir::new().unwrap();
        let project_root = TempDir::new().unwrap();
        let logs = TempDir::new().unwrap();
        let project_id = ProjectId::new();
        let project = ProjectBinding::new(
            Project {
                id: project_id,
                name: "readonly".to_owned(),
                root: project_root.path().to_owned(),
                kind: ProjectKind::Directory,
                git: None,
                created_at: Utc::now(),
            },
            ProjectAccess::ReadOnly,
        );
        let tool = StartProcessTool::new(manager(&logs));
        let call = ToolCall::new(
            "call-1",
            "start_process",
            json!({ "command": "pwd", "project_id": project_id }),
        );

        let error = tool
            .execute(&call, &context(&workspace, vec![project]))
            .await
            .unwrap_err();
        assert!(matches!(error, KodyError::Tool(message) if message.contains("read-only")));
    }

    #[test]
    fn process_tool_risks_are_semantic() {
        let logs = TempDir::new().unwrap();
        let manager = manager(&logs);
        assert_eq!(
            StartProcessTool::new(manager.clone()).risk(),
            ToolRisk::CommandExecution
        );
        assert_eq!(
            StopProcessTool::new(manager).risk(),
            ToolRisk::ProcessControl
        );
    }

    #[test]
    fn output_tool_schema_tracks_the_manager_read_limit() {
        let logs = TempDir::new().unwrap();
        let mut config = ProcessManagerConfig::new(logs.path());
        config.max_read_bytes = 17;
        let manager =
            Arc::new(ProcessManager::new(Arc::new(InMemoryStore::default()), config).unwrap());

        let schema = ReadProcessOutputTool::new(manager)
            .definition()
            .input_schema;
        assert_eq!(schema["properties"]["limit"]["maximum"], 17);
        assert_eq!(schema["properties"]["limit"]["default"], 17);
    }

    #[tokio::test]
    async fn engine_process_tools_cover_start_list_output_and_stop_across_turn_cancellation() {
        let state = TempDir::new().unwrap();
        let engine = KodyEngine::in_memory(EngineConfig {
            state_root: state.path().join("state"),
            ..EngineConfig::default()
        })
        .await
        .unwrap();
        engine
            .providers()
            .register(Arc::new(EchoProvider::default()))
            .unwrap();
        let (thread, workspace, _) = engine.create_thread("process test", None).await.unwrap();
        let turn = engine
            .runtime()
            .prepare_turn(StartTurn {
                thread_id: thread.id,
                message: "start a test process".to_owned(),
                references: Vec::new(),
                provider: "echo".to_owned(),
                model: None,
                permission_mode: None,
                temperature: None,
                max_output_tokens: None,
            })
            .await
            .unwrap();
        let cancellation = CancellationToken::new();
        let tool_context = ToolContext::new(
            thread.id,
            turn.id,
            workspace.clone(),
            Vec::new(),
            cancellation.clone(),
        );
        let start = engine
            .tools()
            .execute(
                &ToolCall::new(
                    "process-call",
                    "start_process",
                    json!({ "command": "printf ready; exec sleep 30" }),
                ),
                &tool_context,
            )
            .await
            .unwrap();
        let started: ManagedProcess = serde_json::from_value(start.metadata).unwrap();

        // Turn cancellation is intentionally not process cancellation.
        cancellation.cancel();
        let fresh_context = ToolContext::new(
            thread.id,
            turn.id,
            workspace,
            Vec::new(),
            CancellationToken::new(),
        );
        let listed = engine
            .tools()
            .execute(
                &ToolCall::new("list-call", "list_processes", json!({})),
                &fresh_context,
            )
            .await;
        let output = tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                let result = engine
                    .tools()
                    .execute(
                        &ToolCall::new(
                            "read-call",
                            "read_process_output",
                            json!({ "process_id": started.id }),
                        ),
                        &fresh_context,
                    )
                    .await?;
                let page: ProcessOutputPage = serde_json::from_value(result.metadata)?;
                if page.chunks.iter().any(|chunk| chunk.text.contains("ready")) {
                    break Ok::<_, KodyError>(page);
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await;
        // Always terminate the process before evaluating observations so a
        // failed assertion cannot leak a child from the test runtime.
        let stopped = engine
            .tools()
            .execute(
                &ToolCall::new(
                    "stop-call",
                    "stop_process",
                    json!({ "process_id": started.id }),
                ),
                &fresh_context,
            )
            .await
            .unwrap();

        let listed: Vec<ManagedProcess> = serde_json::from_value(listed.unwrap().metadata).unwrap();
        let output = output.expect("process output timed out").unwrap();
        let stopped: ManagedProcess = serde_json::from_value(stopped.metadata).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, started.id);
        assert!(listed[0].status.is_active());
        assert!(output.next_cursor >= 5);
        assert_eq!(stopped.status, ProcessStatus::Stopped);
    }

    #[test]
    fn retrying_a_failed_or_lost_start_is_reported_as_a_tool_error() {
        let call = ToolCall::new("call-1", "start_process", json!({}));
        for status in [ProcessStatus::Failed, ProcessStatus::Lost] {
            let now = Utc::now();
            let process = ManagedProcess {
                id: ProcessId::new(),
                thread_id: ThreadId::new(),
                origin: ProcessOrigin {
                    turn_id: TurnId::new(),
                    tool_call_id: call.id.clone(),
                },
                spec_fingerprint: "0".repeat(64),
                project_id: None,
                command: "command".to_owned(),
                cwd: std::env::temp_dir(),
                pid: None,
                process_group_id: None,
                status,
                exit_code: None,
                error: Some("failed".to_owned()),
                output_truncated: false,
                output_start_cursor: 0,
                output_end_cursor: 0,
                last_event_sequence: 1,
                created_at: now,
                started_at: None,
                completed_at: Some(now),
            };

            assert!(start_process_result(&call, &process).unwrap().is_error);
        }
    }
}
