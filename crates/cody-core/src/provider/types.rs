use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{
    domain::{Message, MessagePart, MessageRole},
    error::Result,
    tools::{ToolCall, ToolDefinition, ToolResult},
};

/// A provider-neutral model request.
///
/// Providers should treat `model` as an opaque provider-specific identifier.
/// The runtime deliberately keeps provider selection separate from the model
/// name so one provider implementation can expose many models.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ModelRequest {
    pub model: String,
    pub messages: Vec<ModelMessage>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tools: Vec<ToolDefinition>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub temperature: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_output_tokens: Option<u32>,
}

impl ModelRequest {
    pub fn new(model: impl Into<String>, messages: Vec<ModelMessage>) -> Self {
        Self {
            model: model.into(),
            messages,
            tools: Vec::new(),
            temperature: None,
            max_output_tokens: None,
        }
    }

    pub fn with_tools(mut self, tools: Vec<ToolDefinition>) -> Self {
        self.tools = tools;
        self
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ModelRole {
    System,
    User,
    Assistant,
    Tool,
}

impl From<MessageRole> for ModelRole {
    fn from(value: MessageRole) -> Self {
        match value {
            MessageRole::System => Self::System,
            MessageRole::User => Self::User,
            MessageRole::Assistant => Self::Assistant,
            MessageRole::Tool => Self::Tool,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ModelMessage {
    pub role: ModelRole,
    pub content: Vec<ModelContent>,
}

impl ModelMessage {
    pub fn new(role: ModelRole, content: Vec<ModelContent>) -> Self {
        Self { role, content }
    }

    pub fn text(role: ModelRole, text: impl Into<String>) -> Self {
        Self {
            role,
            content: vec![ModelContent::Text { text: text.into() }],
        }
    }

    /// Returns all text parts in their original order.
    pub fn text_content(&self) -> String {
        self.content
            .iter()
            .filter_map(|part| match part {
                ModelContent::Text { text } => Some(text.as_str()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("\n")
    }
}

impl From<&Message> for ModelMessage {
    fn from(value: &Message) -> Self {
        Self {
            role: value.role.into(),
            content: value.parts.iter().map(ModelContent::from).collect(),
        }
    }
}

/// Model content mirrors the durable domain `MessagePart` representation.
/// Keeping these types separate prevents provider requests from inheriting
/// persistence-only fields such as message IDs and timestamps.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ModelContent {
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

impl ModelContent {
    pub fn as_text(&self) -> Option<&str> {
        match self {
            Self::Text { text } => Some(text),
            _ => None,
        }
    }
}

impl From<&MessagePart> for ModelContent {
    fn from(value: &MessagePart) -> Self {
        match value {
            MessagePart::Text { text } => Self::Text { text: text.clone() },
            MessagePart::ToolCall {
                id,
                name,
                arguments,
            } => Self::ToolCall {
                id: id.clone(),
                name: name.clone(),
                arguments: arguments.clone(),
            },
            MessagePart::ToolResult {
                tool_call_id,
                name,
                content,
                is_error,
                metadata,
            } => Self::ToolResult {
                tool_call_id: tool_call_id.clone(),
                name: name.clone(),
                content: content.clone(),
                is_error: *is_error,
                metadata: metadata.clone(),
            },
        }
    }
}

impl From<ModelContent> for MessagePart {
    fn from(value: ModelContent) -> Self {
        match value {
            ModelContent::Text { text } => Self::Text { text },
            ModelContent::ToolCall {
                id,
                name,
                arguments,
            } => Self::ToolCall {
                id,
                name,
                arguments,
            },
            ModelContent::ToolResult {
                tool_call_id,
                name,
                content,
                is_error,
                metadata,
            } => Self::ToolResult {
                tool_call_id,
                name,
                content,
                is_error,
                metadata,
            },
        }
    }
}

impl From<ToolCall> for ModelContent {
    fn from(value: ToolCall) -> Self {
        Self::ToolCall {
            id: value.id,
            name: value.name,
            arguments: value.arguments,
        }
    }
}

impl From<ToolResult> for ModelContent {
    fn from(value: ToolResult) -> Self {
        Self::ToolResult {
            tool_call_id: value.tool_call_id,
            name: value.name,
            content: value.content,
            is_error: value.is_error,
            metadata: value.metadata,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct ModelUsage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub total_tokens: u64,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FinishReason {
    #[default]
    Stop,
    ToolCalls,
    Length,
    ContentFilter,
    Other(String),
}

impl FinishReason {
    pub fn as_str(&self) -> &str {
        match self {
            Self::Stop => "stop",
            Self::ToolCalls => "tool_calls",
            Self::Length => "length",
            Self::ContentFilter => "content_filter",
            Self::Other(value) => value,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ModelResponse {
    pub content: Vec<ModelContent>,
    pub finish_reason: FinishReason,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage: Option<ModelUsage>,
}

impl ModelResponse {
    pub fn text(text: impl Into<String>) -> Self {
        Self {
            content: vec![ModelContent::Text { text: text.into() }],
            finish_reason: FinishReason::Stop,
            usage: None,
        }
    }

    pub fn text_content(&self) -> String {
        self.content
            .iter()
            .filter_map(ModelContent::as_text)
            .collect::<Vec<_>>()
            .join("")
    }

    pub fn tool_calls(&self) -> impl Iterator<Item = ToolCall> + '_ {
        self.content.iter().filter_map(|content| match content {
            ModelContent::ToolCall {
                id,
                name,
                arguments,
            } => Some(ToolCall {
                id: id.clone(),
                name: name.clone(),
                arguments: arguments.clone(),
            }),
            _ => None,
        })
    }
}

/// A transport-neutral streaming update. Providers that only support
/// non-streaming completion can still emit their final content through this
/// interface, which lets runtimes use one event path for every provider.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ModelDelta {
    Text {
        text: String,
    },
    /// Transient provider reasoning or reasoning summary. It is intentionally
    /// not part of durable `ModelResponse::content`.
    Reasoning {
        text: String,
    },
    ToolCall {
        id: String,
        name: String,
        arguments: Value,
    },
    Done {
        finish_reason: FinishReason,
        #[serde(skip_serializing_if = "Option::is_none")]
        usage: Option<ModelUsage>,
    },
}

#[async_trait]
pub trait ModelDeltaSink: Send + Sync {
    async fn emit(&self, delta: ModelDelta) -> Result<()>;
}

/// Shorter name for callers that do not need to distinguish model deltas from
/// other event sinks.
pub use ModelDeltaSink as DeltaSink;

pub(crate) async fn emit_response(
    sink: Option<&dyn ModelDeltaSink>,
    response: &ModelResponse,
) -> Result<()> {
    let Some(sink) = sink else {
        return Ok(());
    };

    for content in &response.content {
        let delta = match content {
            ModelContent::Text { text } => ModelDelta::Text { text: text.clone() },
            ModelContent::ToolCall {
                id,
                name,
                arguments,
            } => ModelDelta::ToolCall {
                id: id.clone(),
                name: name.clone(),
                arguments: arguments.clone(),
            },
            ModelContent::ToolResult { .. } => continue,
        };
        sink.emit(delta).await?;
    }
    sink.emit(ModelDelta::Done {
        finish_reason: response.finish_reason.clone(),
        usage: response.usage,
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::{MessageId, ThreadId};
    use chrono::Utc;

    #[test]
    fn durable_message_maps_without_persistence_fields() {
        let message = Message {
            id: MessageId::new(),
            thread_id: ThreadId::new(),
            turn_id: None,
            role: MessageRole::Assistant,
            parts: vec![MessagePart::ToolCall {
                id: "call-1".into(),
                name: "read_file".into(),
                arguments: serde_json::json!({"path": "README.md"}),
            }],
            references: Vec::new(),
            created_at: Utc::now(),
        };

        let model_message = ModelMessage::from(&message);
        assert_eq!(model_message.role, ModelRole::Assistant);
        assert_eq!(model_message.content.len(), 1);
    }
}
