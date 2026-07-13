use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::broadcast;

use crate::domain::{
    ApprovalId, EventId, InteractionId, ProcessId, ProcessOutputStream, ProjectId, ThreadId, TurnId,
};
use crate::user_input::UserInputQuestion;

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
    UserInputRequested {
        interaction_id: InteractionId,
        item_id: String,
        questions: Vec<UserInputQuestion>,
    },
    /// Signals completion without carrying answer contents. In particular,
    /// secret answers can never enter the public event stream.
    UserInputResolved {
        interaction_id: InteractionId,
        cancelled: bool,
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

/// Events emitted by a managed process have their own lifecycle and sequence
/// space. They intentionally do not use a Turn envelope: a process may keep
/// producing output after the Turn that started it has completed.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ProcessEvent {
    Started {
        pid: u32,
        #[serde(skip_serializing_if = "Option::is_none")]
        process_group_id: Option<i32>,
    },
    Output {
        stream: ProcessOutputStream,
        cursor: u64,
        next_cursor: u64,
    },
    Stopping,
    Exited {
        #[serde(skip_serializing_if = "Option::is_none")]
        exit_code: Option<i32>,
    },
    Stopped {
        #[serde(skip_serializing_if = "Option::is_none")]
        exit_code: Option<i32>,
        forced: bool,
    },
    Failed {
        error: String,
    },
    Lost {
        reason: String,
    },
}

/// A process-scoped event envelope.
///
/// `sequence` starts at one for every process and is independent from both
/// Agent Turn sequences and other managed processes.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProcessEventEnvelope {
    pub id: EventId,
    pub thread_id: ThreadId,
    pub process_id: ProcessId,
    pub sequence: u64,
    pub created_at: chrono::DateTime<Utc>,
    pub event: ProcessEvent,
}

impl ProcessEventEnvelope {
    pub fn new(
        thread_id: ThreadId,
        process_id: ProcessId,
        sequence: u64,
        event: ProcessEvent,
    ) -> Self {
        Self {
            id: EventId::new(),
            thread_id,
            process_id,
            sequence,
            created_at: Utc::now(),
            event,
        }
    }
}

/// Independent fan-out channel for process events. Keeping this separate from
/// [`EventHub`] prevents long-lived process output from consuming the Turn
/// event buffer or inheriting a Turn's terminal sequence.
#[derive(Debug, Clone)]
pub struct ProcessEventHub {
    sender: broadcast::Sender<ProcessEventEnvelope>,
}

impl ProcessEventHub {
    pub fn new(capacity: usize) -> Self {
        let (sender, _) = broadcast::channel(capacity.max(1));
        Self { sender }
    }

    pub fn publish(&self, event: ProcessEventEnvelope) {
        let _ = self.sender.send(event);
    }

    pub fn subscribe(&self) -> broadcast::Receiver<ProcessEventEnvelope> {
        self.sender.subscribe()
    }
}

impl Default for ProcessEventHub {
    fn default() -> Self {
        Self::new(4_096)
    }
}

#[cfg(test)]
mod process_event_tests {
    use super::*;

    #[test]
    fn process_output_event_announces_a_durable_cursor_without_buffering_bytes() {
        let envelope = ProcessEventEnvelope::new(
            ThreadId::new(),
            ProcessId::new(),
            2,
            ProcessEvent::Output {
                stream: ProcessOutputStream::Stderr,
                cursor: 4,
                next_cursor: 6,
            },
        );

        let value = serde_json::to_value(envelope).unwrap();
        assert_eq!(value["sequence"], 2);
        assert_eq!(value["event"]["type"], "output");
        assert_eq!(value["event"]["stream"], "stderr");
        assert_eq!(value["event"]["cursor"], 4);
        assert_eq!(value["event"]["next_cursor"], 6);
        assert!(value["event"].get("bytes").is_none());
    }
}
