//! Extensible tools and the execution context made available to them.
//!
//! Tools receive a thread-owned workspace as their default filesystem root.
//! A tool call may explicitly select one of the projects referenced by the
//! thread; project access is checked before any potentially mutating action.

mod builtins;
mod processes;

use std::{collections::BTreeMap, sync::Arc};

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use crate::{
    domain::{Project, ProjectAccess, ProjectId, ThreadId, TurnId, Workspace},
    error::{CodyError, Result},
    process::ProcessManager,
};

pub use builtins::{ListDirectoryTool, ReadFileTool, ShellTool, WriteFileTool};
pub use processes::{ListProcessesTool, ReadProcessOutputTool, StartProcessTool, StopProcessTool};

/// A provider-neutral description of a tool exposed to a model.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ToolDefinition {
    pub name: String,
    pub description: String,
    pub input_schema: Value,
}

/// Security-relevant behavior declared by a tool. Runtime approval policy is
/// based on this semantic risk instead of fragile tool-name allowlists.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolRisk {
    ReadOnly,
    FilesystemWrite,
    CommandExecution,
    ProcessControl,
}

impl ToolDefinition {
    pub fn new(
        name: impl Into<String>,
        description: impl Into<String>,
        input_schema: Value,
    ) -> Self {
        Self {
            name: name.into(),
            description: description.into(),
            input_schema,
        }
    }
}

/// A single tool invocation requested by a model.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub arguments: Value,
}

impl ToolCall {
    pub fn new(id: impl Into<String>, name: impl Into<String>, arguments: Value) -> Self {
        Self {
            id: id.into(),
            name: name.into(),
            arguments,
        }
    }
}

/// Textual output from a tool plus optional structured metadata.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ToolResult {
    pub tool_call_id: String,
    pub name: String,
    pub content: String,
    pub is_error: bool,
    #[serde(default, skip_serializing_if = "Value::is_null")]
    pub metadata: Value,
}

impl ToolResult {
    pub fn success(call: &ToolCall, content: impl Into<String>, metadata: Value) -> Self {
        Self {
            tool_call_id: call.id.clone(),
            name: call.name.clone(),
            content: content.into(),
            is_error: false,
            metadata,
        }
    }

    pub fn error(call: &ToolCall, content: impl Into<String>, metadata: Value) -> Self {
        Self {
            tool_call_id: call.id.clone(),
            name: call.name.clone(),
            content: content.into(),
            is_error: true,
            metadata,
        }
    }
}

/// A project attached to a thread and the access granted for this execution.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectBinding {
    pub project: Project,
    pub access: ProjectAccess,
}

impl ProjectBinding {
    pub fn new(project: Project, access: ProjectAccess) -> Self {
        Self { project, access }
    }
}

/// Filesystem roots and cancellation state available during a tool call.
#[derive(Debug, Clone)]
pub struct ToolContext {
    pub thread_id: ThreadId,
    pub turn_id: TurnId,
    pub workspace: Workspace,
    pub projects: Vec<ProjectBinding>,
    pub cancellation_token: CancellationToken,
}

impl ToolContext {
    pub fn new(
        thread_id: ThreadId,
        turn_id: TurnId,
        workspace: Workspace,
        projects: Vec<ProjectBinding>,
        cancellation_token: CancellationToken,
    ) -> Self {
        Self {
            thread_id,
            turn_id,
            workspace,
            projects,
            cancellation_token,
        }
    }

    pub fn project(&self, project_id: ProjectId) -> Option<&ProjectBinding> {
        self.projects
            .iter()
            .find(|binding| binding.project.id == project_id)
    }

    pub fn check_cancelled(&self) -> Result<()> {
        if self.cancellation_token.is_cancelled() {
            Err(CodyError::Cancelled)
        } else {
            Ok(())
        }
    }
}

/// An asynchronously executable, object-safe model tool.
#[async_trait]
pub trait Tool: Send + Sync {
    fn definition(&self) -> ToolDefinition;

    fn risk(&self) -> ToolRisk {
        ToolRisk::ReadOnly
    }

    fn approval_reason(&self) -> Option<&'static str> {
        match self.risk() {
            ToolRisk::CommandExecution => {
                Some("This tool starts an arbitrary command outside an OS filesystem sandbox.")
            }
            _ => None,
        }
    }

    async fn execute(&self, call: &ToolCall, context: &ToolContext) -> Result<ToolResult>;
}

/// A deterministic, cloneable registry of tools.
#[derive(Clone, Default)]
pub struct ToolRegistry {
    tools: BTreeMap<String, Arc<dyn Tool>>,
}

impl ToolRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Construct a registry containing Cody's filesystem and shell tools.
    pub fn with_builtins() -> Result<Self> {
        let mut registry = Self::new();
        registry.register(ReadFileTool)?;
        registry.register(WriteFileTool)?;
        registry.register(ListDirectoryTool)?;
        registry.register(ShellTool)?;
        Ok(registry)
    }

    /// Construct the complete tool set used by the app runtime, including
    /// long-lived process lifecycle tools backed by one shared manager.
    pub fn with_builtins_and_processes(manager: Arc<ProcessManager>) -> Result<Self> {
        let mut registry = Self::with_builtins()?;
        processes::register_process_tools(&mut registry, manager)?;
        Ok(registry)
    }

    pub fn register<T>(&mut self, tool: T) -> Result<()>
    where
        T: Tool + 'static,
    {
        self.register_arc(Arc::new(tool))
    }

    pub fn register_arc(&mut self, tool: Arc<dyn Tool>) -> Result<()> {
        let definition = tool.definition();
        let name = definition.name.trim();

        if name.is_empty() {
            return Err(CodyError::InvalidInput(
                "tool name cannot be empty".to_owned(),
            ));
        }
        if name != definition.name {
            return Err(CodyError::InvalidInput(format!(
                "tool name '{}' cannot have surrounding whitespace",
                definition.name
            )));
        }
        if !definition.input_schema.is_object() {
            return Err(CodyError::InvalidInput(format!(
                "tool '{name}' input schema must be a JSON object"
            )));
        }
        if self.tools.contains_key(name) {
            return Err(CodyError::Conflict(format!(
                "tool '{name}' is already registered"
            )));
        }

        self.tools.insert(name.to_owned(), tool);
        Ok(())
    }

    pub fn get(&self, name: &str) -> Option<Arc<dyn Tool>> {
        self.tools.get(name).cloned()
    }

    pub fn definitions(&self) -> Vec<ToolDefinition> {
        self.tools.values().map(|tool| tool.definition()).collect()
    }

    pub fn risk(&self, name: &str) -> Result<ToolRisk> {
        self.get(name)
            .map(|tool| tool.risk())
            .ok_or_else(|| CodyError::ToolNotFound(name.to_owned()))
    }

    pub fn approval_reason(&self, name: &str) -> Result<Option<&'static str>> {
        self.get(name)
            .map(|tool| tool.approval_reason())
            .ok_or_else(|| CodyError::ToolNotFound(name.to_owned()))
    }

    pub fn len(&self) -> usize {
        self.tools.len()
    }

    pub fn is_empty(&self) -> bool {
        self.tools.is_empty()
    }

    pub async fn execute(&self, call: &ToolCall, context: &ToolContext) -> Result<ToolResult> {
        context.check_cancelled()?;
        let tool = self
            .get(&call.name)
            .ok_or_else(|| CodyError::ToolNotFound(call.name.clone()))?;
        tool.execute(call, context).await
    }
}

#[cfg(test)]
mod tests {
    use crate::{process::ProcessManagerConfig, store::InMemoryStore};

    use super::*;

    #[test]
    fn builtin_definitions_are_stable_and_have_object_schemas() {
        let registry = ToolRegistry::with_builtins().unwrap();
        let definitions = registry.definitions();
        let names = definitions
            .iter()
            .map(|definition| definition.name.as_str())
            .collect::<Vec<_>>();

        assert_eq!(
            names,
            vec!["list_directory", "read_file", "shell", "write_file"]
        );
        assert!(definitions
            .iter()
            .all(|definition| definition.input_schema.is_object()));
    }

    #[test]
    fn app_tool_definitions_include_the_complete_process_lifecycle() {
        let log_root = tempfile::tempdir().unwrap();
        let manager = Arc::new(
            ProcessManager::new(
                Arc::new(InMemoryStore::default()),
                ProcessManagerConfig::new(log_root.path()),
            )
            .unwrap(),
        );
        let registry = ToolRegistry::with_builtins_and_processes(manager).unwrap();
        let names = registry
            .definitions()
            .into_iter()
            .map(|definition| definition.name)
            .collect::<Vec<_>>();

        assert_eq!(
            names,
            vec![
                "list_directory",
                "list_processes",
                "read_file",
                "read_process_output",
                "shell",
                "start_process",
                "stop_process",
                "write_file",
            ]
        );
    }

    #[tokio::test]
    async fn unknown_tool_is_reported_by_registry() {
        let registry = ToolRegistry::new();
        let context = builtins::tests::test_context(Vec::new());
        let call = ToolCall::new("call-1", "missing", serde_json::json!({}));

        let error = registry.execute(&call, &context).await.unwrap_err();
        assert!(matches!(error, CodyError::ToolNotFound(name) if name == "missing"));
    }
}
