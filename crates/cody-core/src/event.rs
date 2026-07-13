use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::broadcast;

use crate::domain::{ApprovalId, EventId, ProjectId, ThreadId, TurnId};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AgentEvent {
    TurnStarted,
    StepStarted {
        step: usize,
    },
    ModelStarted {
        provider: String,
        model: String,
    },
    ModelOutputDelta {
        delta: String,
    },
    ModelReasoningDelta {
        delta: String,
    },
    ModelCompleted {
        stop_reason: String,
    },
    ApprovalRequested {
        approval_id: ApprovalId,
        tool_call_id: String,
        name: String,
        arguments: Value,
        reason: String,
    },
    ApprovalResolved {
        approval_id: ApprovalId,
        approved: bool,
    },
    ToolStarted {
        tool_call_id: String,
        name: String,
        arguments: Value,
    },
    ToolCompleted {
        tool_call_id: String,
        name: String,
        content: String,
        is_error: bool,
        metadata: Value,
    },
    FileChanged {
        project_id: Option<ProjectId>,
        path: String,
    },
    ThreadUpdated {
        title: String,
    },
    TurnCompleted {
        final_text: String,
    },
    TurnFailed {
        error: String,
    },
    TurnCancelled,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EventEnvelope {
    pub id: EventId,
    pub thread_id: ThreadId,
    pub turn_id: TurnId,
    pub sequence: u64,
    pub created_at: chrono::DateTime<Utc>,
    pub event: AgentEvent,
}

impl EventEnvelope {
    pub fn new(thread_id: ThreadId, turn_id: TurnId, sequence: u64, event: AgentEvent) -> Self {
        Self {
            id: EventId::new(),
            thread_id,
            turn_id,
            sequence,
            created_at: Utc::now(),
            event,
        }
    }
}

/// In-process fan-out. Durable event stores can be connected behind the same
/// runtime boundary without coupling providers or tools to a transport.
#[derive(Debug, Clone)]
pub struct EventHub {
    sender: broadcast::Sender<EventEnvelope>,
}

impl EventHub {
    pub fn new(capacity: usize) -> Self {
        let (sender, _) = broadcast::channel(capacity.max(1));
        Self { sender }
    }

    pub fn publish(&self, event: EventEnvelope) {
        // It is valid to publish while no client is subscribed.
        let _ = self.sender.send(event);
    }

    pub fn subscribe(&self) -> broadcast::Receiver<EventEnvelope> {
        self.sender.subscribe()
    }
}

impl Default for EventHub {
    fn default() -> Self {
        Self::new(1_024)
    }
}
