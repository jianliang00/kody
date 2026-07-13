use crate::domain::{MessageId, ProcessId, ProjectId, ThreadId, TurnId, WorkspaceId};

pub type Result<T, E = KodyError> = std::result::Result<T, E>;

#[derive(Debug, thiserror::Error)]
pub enum KodyError {
    #[error("project {0} was not found")]
    ProjectNotFound(ProjectId),
    #[error("thread {0} was not found")]
    ThreadNotFound(ThreadId),
    #[error("workspace {0} was not found")]
    WorkspaceNotFound(WorkspaceId),
    #[error("turn {0} was not found")]
    TurnNotFound(TurnId),
    #[error("message {0} was not found")]
    MessageNotFound(MessageId),
    #[error("managed process {0} was not found")]
    ProcessNotFound(ProcessId),
    #[error("provider '{0}' is not registered")]
    ProviderNotFound(String),
    #[error("tool '{0}' is not registered")]
    ToolNotFound(String),
    #[error("conflict: {0}")]
    Conflict(String),
    #[error("invalid input: {0}")]
    InvalidInput(String),
    #[error("provider error: {0}")]
    Provider(String),
    #[error("tool error: {0}")]
    Tool(String),
    #[error("state store error: {0}")]
    Store(String),
    #[error("turn was cancelled")]
    Cancelled,
    #[error("agent reached the configured step limit ({0})")]
    StepLimit(usize),
    #[error("agent execution panicked: {0}")]
    AgentPanic(String),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
}
