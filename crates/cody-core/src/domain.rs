use std::{fmt, path::PathBuf, str::FromStr};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

macro_rules! id_type {
    ($name:ident) => {
        #[derive(
            Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize,
        )]
        #[serde(transparent)]
        pub struct $name(pub Uuid);

        impl $name {
            pub fn new() -> Self {
                Self(Uuid::now_v7())
            }
        }

        impl Default for $name {
            fn default() -> Self {
                Self::new()
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                self.0.fmt(formatter)
            }
        }

        impl FromStr for $name {
            type Err = uuid::Error;

            fn from_str(value: &str) -> Result<Self, Self::Err> {
                Uuid::parse_str(value).map(Self)
            }
        }
    };
}

id_type!(ProjectId);
id_type!(ThreadId);
id_type!(WorkspaceId);
id_type!(TurnId);
id_type!(MessageId);
id_type!(EventId);
id_type!(ApprovalId);

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProjectKind {
    Directory,
    Git,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct GitMetadata {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remote: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
}

/// A durable code asset imported or created by the user.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Project {
    pub id: ProjectId,
    pub name: String,
    pub root: PathBuf,
    pub kind: ProjectKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub git: Option<GitMetadata>,
    pub created_at: DateTime<Utc>,
}

/// The ephemeral execution directory owned by exactly one thread.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Workspace {
    pub id: WorkspaceId,
    pub thread_id: ThreadId,
    pub root: PathBuf,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ThreadStatus {
    Idle,
    Running,
    Archived,
}

/// A durable, linear conversation. It always owns one workspace.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Thread {
    pub id: ThreadId,
    pub title: String,
    pub workspace_id: WorkspaceId,
    pub status: ThreadStatus,
    /// References that are always available to the conversation. A project
    /// imported from `thread/create.working_directory` is recorded here.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub default_references: Vec<ContextReference>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ThreadReferenceMode {
    #[default]
    Summary,
    Full,
    Messages,
    Artifacts,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProjectAccess {
    ReadOnly,
    #[default]
    ReadWrite,
}

/// A reference is attached to the user message where it was mentioned. The
/// context builder folds references from the linear history into later turns.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ContextReference {
    Thread {
        thread_id: ThreadId,
        #[serde(default)]
        mode: ThreadReferenceMode,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        message_ids: Vec<MessageId>,
    },
    Project {
        project_id: ProjectId,
        #[serde(default)]
        access: ProjectAccess,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MessageRole {
    System,
    User,
    Assistant,
    Tool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum MessagePart {
    Text {
        text: String,
    },
    ToolCall {
        id: String,
        name: String,
        arguments: Value,
    },
    ToolResult {
        tool_call_id: String,
        name: String,
        content: String,
        is_error: bool,
        #[serde(default, skip_serializing_if = "Value::is_null")]
        metadata: Value,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Message {
    pub id: MessageId,
    pub thread_id: ThreadId,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<TurnId>,
    pub role: MessageRole,
    pub parts: Vec<MessagePart>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub references: Vec<ContextReference>,
    pub created_at: DateTime<Utc>,
}

impl Message {
    pub fn text(&self) -> String {
        self.parts
            .iter()
            .filter_map(|part| match part {
                MessagePart::Text { text } => Some(text.as_str()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("\n")
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TurnStatus {
    Queued,
    Running,
    Completed,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Turn {
    pub id: TurnId,
    pub thread_id: ThreadId,
    pub input_message_id: MessageId,
    pub provider: String,
    pub model: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub temperature: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_output_tokens: Option<u32>,
    pub status: TurnStatus,
    pub created_at: DateTime<Utc>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started_at: Option<DateTime<Utc>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<DateTime<Utc>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn thread_reference_uses_a_flat_natural_json_shape() {
        let thread_id = ThreadId::new();
        let reference: ContextReference = serde_json::from_value(json!({
            "kind": "thread",
            "thread_id": thread_id,
            "mode": "full"
        }))
        .unwrap();
        assert_eq!(
            reference,
            ContextReference::Thread {
                thread_id,
                mode: ThreadReferenceMode::Full,
                message_ids: Vec::new(),
            }
        );

        let serialized = serde_json::to_value(reference).unwrap();
        assert_eq!(serialized["mode"], "full");
        assert!(serialized.get("message_ids").is_none());
    }
}
