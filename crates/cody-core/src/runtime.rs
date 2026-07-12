use std::{
    collections::HashSet,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
};

use async_trait::async_trait;
use chrono::Utc;
use futures_util::FutureExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::{oneshot, Mutex};
use tokio_util::sync::CancellationToken;

use crate::{
    context::ContextBuilder,
    domain::{
        ApprovalId, ContextReference, Message, MessageId, MessagePart, MessageRole, ProjectId,
        ThreadId, ThreadStatus, Turn, TurnId, TurnStatus,
    },
    engine::validate_reference,
    error::{CodyError, Result},
    event::{AgentEvent, EventEnvelope, EventHub},
    provider::{
        FinishReason, ModelContent, ModelDelta, ModelDeltaSink, ModelRequest, ModelResponse,
        ProviderRegistry, ToolDefinition as ProviderToolDefinition,
    },
    store::StateStore,
    tools::{ToolCall, ToolContext, ToolRegistry, ToolResult},
};

#[derive(Debug, Clone)]
pub struct AgentRuntimeConfig {
    pub max_steps: usize,
    pub temperature: Option<f32>,
    pub max_output_tokens: Option<u32>,
    /// Shell is not a filesystem sandbox, so interactive runtimes require an
    /// explicit client decision before each shell call by default.
    pub require_shell_approval: bool,
}

impl Default for AgentRuntimeConfig {
    fn default() -> Self {
        Self {
            max_steps: 24,
            temperature: None,
            max_output_tokens: None,
            require_shell_approval: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StartTurn {
    pub thread_id: ThreadId,
    #[serde(alias = "text")]
    pub message: String,
    #[serde(default)]
    pub references: Vec<ContextReference>,
    #[serde(default = "default_provider")]
    pub provider: String,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub temperature: Option<f32>,
    #[serde(default)]
    pub max_output_tokens: Option<u32>,
}

fn default_provider() -> String {
    "echo".into()
}

pub struct AgentRuntime {
    store: Arc<dyn StateStore>,
    providers: Arc<ProviderRegistry>,
    tools: Arc<ToolRegistry>,
    events: EventHub,
    context_builder: Arc<dyn ContextBuilder>,
    config: AgentRuntimeConfig,
    active_threads: Mutex<HashSet<ThreadId>>,
    approvals: ApprovalBroker,
}

impl AgentRuntime {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        store: Arc<dyn StateStore>,
        providers: Arc<ProviderRegistry>,
        tools: Arc<ToolRegistry>,
        events: EventHub,
        context_builder: Arc<dyn ContextBuilder>,
        config: AgentRuntimeConfig,
    ) -> Self {
        Self {
            store,
            providers,
            tools,
            events,
            context_builder,
            config,
            active_threads: Mutex::new(HashSet::new()),
            approvals: ApprovalBroker::default(),
        }
    }

    pub fn approvals(&self) -> &ApprovalBroker {
        &self.approvals
    }

    /// Validate and persist a queued turn. This reserves the thread so that
    /// two callers cannot interleave a linear conversation.
    pub async fn prepare_turn(&self, request: StartTurn) -> Result<Turn> {
        validate_start_turn(&request)?;
        let provider = self.providers.get(&request.provider)?;
        let model = request
            .model
            .as_deref()
            .filter(|model| !model.trim().is_empty())
            .or_else(|| provider.default_model())
            .ok_or_else(|| {
                CodyError::InvalidInput(format!(
                    "model is required because provider '{}' has no default",
                    request.provider
                ))
            })?
            .to_owned();

        let thread = self.store.get_thread(request.thread_id).await?;
        if thread.status == ThreadStatus::Archived {
            return Err(CodyError::Conflict(format!(
                "thread {} is archived",
                thread.id
            )));
        }
        for reference in &request.references {
            validate_reference(self.store.as_ref(), thread.id, reference).await?;
        }

        {
            let mut active = self.active_threads.lock().await;
            if thread.status == ThreadStatus::Running || !active.insert(thread.id) {
                return Err(CodyError::Conflict(format!(
                    "thread {} already has an active turn",
                    thread.id
                )));
            }
        }

        if let Err(error) = self
            .store
            .transition_thread_status(thread.id, ThreadStatus::Idle, ThreadStatus::Running)
            .await
        {
            self.release_thread(thread.id).await;
            return Err(error);
        }

        let result = self.persist_queued_turn(&thread, request, model).await;
        if result.is_err() {
            let _ = self.mark_thread_idle(thread.id).await;
            self.release_thread(thread.id).await;
        }
        result
    }

    async fn persist_queued_turn(
        &self,
        thread: &crate::domain::Thread,
        request: StartTurn,
        model: String,
    ) -> Result<Turn> {
        let turn_id = TurnId::new();
        let input_message_id = MessageId::new();
        let input = Message {
            id: input_message_id,
            thread_id: thread.id,
            // The turn must reference an existing message and the store also
            // validates message -> turn links, so the link is filled after
            // both records exist.
            turn_id: None,
            role: MessageRole::User,
            parts: vec![MessagePart::Text {
                text: request.message,
            }],
            references: request.references,
            created_at: Utc::now(),
        };
        self.store.append_message(input.clone()).await?;

        let turn = Turn {
            id: turn_id,
            thread_id: thread.id,
            input_message_id,
            provider: request.provider,
            model,
            temperature: request.temperature.or(self.config.temperature),
            max_output_tokens: request.max_output_tokens.or(self.config.max_output_tokens),
            status: TurnStatus::Queued,
            created_at: Utc::now(),
            started_at: None,
            completed_at: None,
            error: None,
        };
        if let Err(error) = self.store.insert_turn(turn.clone()).await {
            let _ = self.store.delete_message(input.id).await;
            return Err(error);
        }

        let mut linked_input = input;
        linked_input.turn_id = Some(turn.id);
        if let Err(error) = self.store.update_message(linked_input).await {
            let _ = self.store.delete_turn(turn.id).await;
            let _ = self.store.delete_message(input_message_id).await;
            return Err(error);
        }
        Ok(turn)
    }

    /// Execute a turn previously created by [`prepare_turn`]. Terminal state
    /// and events are persisted/emitted even when execution fails or cancels.
    pub async fn execute_turn(
        &self,
        turn_id: TurnId,
        cancellation: CancellationToken,
    ) -> Result<Turn> {
        // This compare-and-set is the ownership boundary. A duplicate caller
        // fails here and must not release the thread owned by the winner.
        let turn = self
            .store
            .transition_turn_status(turn_id, TurnStatus::Queued, TurnStatus::Running)
            .await?;
        let emitter = TurnEmitter::new(self.events.clone(), turn.thread_id, turn.id);
        emitter.emit(AgentEvent::TurnStarted);
        let execution = std::panic::AssertUnwindSafe(self.execute_loop(
            &turn,
            cancellation.clone(),
            emitter.clone(),
        ))
        .catch_unwind()
        .await;
        let outcome = match execution {
            Ok(outcome) => outcome,
            Err(payload) => Err(CodyError::AgentPanic(panic_message(payload))),
        };
        let result =
            std::panic::AssertUnwindSafe(self.finish_turn(&turn, outcome, cancellation, &emitter))
                .catch_unwind()
                .await
                .unwrap_or_else(|payload| Err(CodyError::AgentPanic(panic_message(payload))));

        // No return path after a successful claim skips this cleanup.
        let idle_result = self.mark_thread_idle(turn.thread_id).await;
        self.release_thread(turn.thread_id).await;
        match (result, idle_result) {
            (result, Ok(())) => result,
            (Ok(_), Err(cleanup_error)) => Err(cleanup_error),
            (Err(original), Err(_cleanup_error)) => Err(original),
        }
    }

    async fn finish_turn(
        &self,
        turn: &Turn,
        outcome: Result<String>,
        cancellation: CancellationToken,
        emitter: &TurnEmitter,
    ) -> Result<Turn> {
        match outcome {
            Ok(_) if cancellation.is_cancelled() => {
                self.store
                    .transition_turn_status(turn.id, TurnStatus::Running, TurnStatus::Cancelled)
                    .await?;
                emitter.emit(AgentEvent::TurnCancelled);
                Err(CodyError::Cancelled)
            }
            Ok(final_text) => {
                let mut terminal = self
                    .store
                    .transition_turn_status(turn.id, TurnStatus::Running, TurnStatus::Completed)
                    .await?;
                terminal.error = None;
                let terminal = self.store.update_turn(terminal).await?;
                emitter.emit(AgentEvent::TurnCompleted { final_text });
                Ok(terminal)
            }
            Err(CodyError::Cancelled) => {
                self.store
                    .transition_turn_status(turn.id, TurnStatus::Running, TurnStatus::Cancelled)
                    .await?;
                emitter.emit(AgentEvent::TurnCancelled);
                Err(CodyError::Cancelled)
            }
            Err(error) => {
                let message = error.to_string();
                let mut terminal = self
                    .store
                    .transition_turn_status(turn.id, TurnStatus::Running, TurnStatus::Failed)
                    .await?;
                terminal.error = Some(message.clone());
                self.store.update_turn(terminal).await?;
                emitter.emit(AgentEvent::TurnFailed { error: message });
                Err(error)
            }
        }
    }

    async fn execute_loop(
        &self,
        turn: &Turn,
        cancellation: CancellationToken,
        emitter: TurnEmitter,
    ) -> Result<String> {
        let provider = self.providers.get(&turn.provider)?;
        let tool_definitions = self
            .tools
            .definitions()
            .into_iter()
            .map(|definition| ProviderToolDefinition {
                name: definition.name,
                description: definition.description,
                input_schema: definition.input_schema,
            })
            .collect::<Vec<_>>();

        for step in 1..=self.config.max_steps {
            check_cancelled(&cancellation)?;
            emitter.emit(AgentEvent::StepStarted { step });
            let resolved = self
                .context_builder
                .build(self.store.as_ref(), turn)
                .await?;
            let tool_context =
                ToolContext::new(resolved.workspace, resolved.projects, cancellation.clone());
            let request = ModelRequest {
                model: turn.model.clone(),
                messages: resolved.messages,
                tools: tool_definitions.clone(),
                temperature: turn.temperature,
                max_output_tokens: turn.max_output_tokens,
            };
            emitter.emit(AgentEvent::ModelStarted {
                provider: turn.provider.clone(),
                model: turn.model.clone(),
            });
            let delta_sink = RuntimeDeltaSink {
                emitter: emitter.clone(),
            };
            let response = tokio::select! {
                biased;
                _ = cancellation.cancelled() => return Err(CodyError::Cancelled),
                response = provider.complete(request, Some(&delta_sink)) => response?,
            };
            check_cancelled(&cancellation)?;
            validate_model_response(&response)?;
            emitter.emit(AgentEvent::ModelCompleted {
                stop_reason: finish_reason_name(&response.finish_reason),
            });

            self.persist_model_response(turn, &response).await?;
            let tool_calls = response
                .content
                .iter()
                .filter_map(|content| match content {
                    ModelContent::ToolCall {
                        id,
                        name,
                        arguments,
                    } => Some(ToolCall::new(id.clone(), name.clone(), arguments.clone())),
                    _ => None,
                })
                .collect::<Vec<_>>();

            if tool_calls.is_empty() {
                return Ok(response_text(&response));
            }

            for call in tool_calls {
                check_cancelled(&cancellation)?;
                if call.name == "shell" && self.config.require_shell_approval {
                    let approved = self
                        .request_tool_approval(&call, &cancellation, &emitter)
                        .await?;
                    if !approved {
                        let result = ToolResult::error(
                            &call,
                            "shell execution was denied by the user",
                            json!({ "error_kind": "approval_denied" }),
                        );
                        emitter.emit(AgentEvent::ToolCompleted {
                            tool_call_id: result.tool_call_id.clone(),
                            name: result.name.clone(),
                            content: result.content.clone(),
                            is_error: true,
                            metadata: result.metadata.clone(),
                        });
                        self.persist_tool_result(turn, result).await?;
                        continue;
                    }
                }
                emitter.emit(AgentEvent::ToolStarted {
                    tool_call_id: call.id.clone(),
                    name: call.name.clone(),
                    arguments: call.arguments.clone(),
                });
                let result = match self.tools.execute(&call, &tool_context).await {
                    Ok(result) => result,
                    Err(CodyError::Cancelled) => return Err(CodyError::Cancelled),
                    Err(error) => ToolResult::error(
                        &call,
                        error.to_string(),
                        json!({ "error_kind": "tool_execution" }),
                    ),
                };
                emitter.emit(AgentEvent::ToolCompleted {
                    tool_call_id: result.tool_call_id.clone(),
                    name: result.name.clone(),
                    content: result.content.clone(),
                    is_error: result.is_error,
                    metadata: result.metadata.clone(),
                });
                if call.name == "write_file" && !result.is_error {
                    emit_file_changed(&emitter, &result.metadata);
                }
                self.persist_tool_result(turn, result).await?;
            }
        }

        Err(CodyError::StepLimit(self.config.max_steps))
    }

    async fn request_tool_approval(
        &self,
        call: &ToolCall,
        cancellation: &CancellationToken,
        emitter: &TurnEmitter,
    ) -> Result<bool> {
        let approval_id = ApprovalId::new();
        let receiver = self.approvals.register(approval_id).await?;
        emitter.emit(AgentEvent::ApprovalRequested {
            approval_id,
            tool_call_id: call.id.clone(),
            name: call.name.clone(),
            arguments: call.arguments.clone(),
            reason: "shell commands run outside an OS filesystem sandbox".into(),
        });
        let decision = tokio::select! {
            biased;
            _ = cancellation.cancelled() => {
                self.approvals.remove(approval_id).await;
                return Err(CodyError::Cancelled);
            }
            decision = receiver => decision.map_err(|_| {
                CodyError::Conflict(format!("approval {approval_id} was closed without a decision"))
            })?,
        };
        emitter.emit(AgentEvent::ApprovalResolved {
            approval_id,
            approved: decision,
        });
        Ok(decision)
    }

    async fn persist_model_response(&self, turn: &Turn, response: &ModelResponse) -> Result<()> {
        let message = Message {
            id: MessageId::new(),
            thread_id: turn.thread_id,
            turn_id: Some(turn.id),
            role: MessageRole::Assistant,
            parts: response.content.iter().map(model_part_to_domain).collect(),
            references: Vec::new(),
            created_at: Utc::now(),
        };
        self.store.append_message(message).await?;
        Ok(())
    }

    async fn persist_tool_result(&self, turn: &Turn, result: ToolResult) -> Result<()> {
        let message = Message {
            id: MessageId::new(),
            thread_id: turn.thread_id,
            turn_id: Some(turn.id),
            role: MessageRole::Tool,
            parts: vec![MessagePart::ToolResult {
                tool_call_id: result.tool_call_id,
                name: result.name,
                content: result.content,
                is_error: result.is_error,
                metadata: result.metadata,
            }],
            references: Vec::new(),
            created_at: Utc::now(),
        };
        self.store.append_message(message).await?;
        Ok(())
    }

    async fn mark_thread_idle(&self, thread_id: ThreadId) -> Result<()> {
        let thread = self.store.get_thread(thread_id).await?;
        if thread.status == ThreadStatus::Running {
            self.store
                .transition_thread_status(thread_id, ThreadStatus::Running, ThreadStatus::Idle)
                .await?;
        }
        Ok(())
    }

    async fn release_thread(&self, thread_id: ThreadId) {
        self.active_threads.lock().await.remove(&thread_id);
    }
}

#[derive(Clone, Default)]
pub struct ApprovalBroker {
    pending: Arc<Mutex<std::collections::HashMap<ApprovalId, oneshot::Sender<bool>>>>,
}

impl ApprovalBroker {
    async fn register(&self, approval_id: ApprovalId) -> Result<oneshot::Receiver<bool>> {
        let (sender, receiver) = oneshot::channel();
        if self
            .pending
            .lock()
            .await
            .insert(approval_id, sender)
            .is_some()
        {
            return Err(CodyError::Conflict(format!(
                "approval {approval_id} is already pending"
            )));
        }
        Ok(receiver)
    }

    pub async fn respond(&self, approval_id: ApprovalId, approved: bool) -> Result<()> {
        let sender = self
            .pending
            .lock()
            .await
            .remove(&approval_id)
            .ok_or_else(|| {
                CodyError::InvalidInput(format!(
                    "approval {approval_id} does not exist or was already resolved"
                ))
            })?;
        sender.send(approved).map_err(|_| {
            CodyError::Conflict(format!("approval {approval_id} is no longer waiting"))
        })
    }

    async fn remove(&self, approval_id: ApprovalId) {
        self.pending.lock().await.remove(&approval_id);
    }
}

fn validate_start_turn(request: &StartTurn) -> Result<()> {
    if request.message.trim().is_empty() {
        return Err(CodyError::InvalidInput(
            "turn message cannot be empty".into(),
        ));
    }
    if request.message.chars().count() > 128_000 {
        return Err(CodyError::InvalidInput(
            "turn message exceeds the 128,000 character limit".into(),
        ));
    }
    if request.provider.trim().is_empty() {
        return Err(CodyError::InvalidInput("provider cannot be empty".into()));
    }
    if request
        .model
        .as_deref()
        .is_some_and(|model| model.trim().is_empty())
    {
        return Err(CodyError::InvalidInput(
            "model cannot be blank when provided".into(),
        ));
    }
    if let Some(temperature) = request.temperature {
        if !temperature.is_finite() || !(0.0..=2.0).contains(&temperature) {
            return Err(CodyError::InvalidInput(
                "temperature must be between 0 and 2".into(),
            ));
        }
    }
    if request.max_output_tokens == Some(0) {
        return Err(CodyError::InvalidInput(
            "max_output_tokens must be greater than zero".into(),
        ));
    }
    Ok(())
}

fn validate_model_response(response: &ModelResponse) -> Result<()> {
    let mut tool_call_ids = HashSet::new();
    let mut tool_call_count = 0_usize;
    for content in &response.content {
        match content {
            ModelContent::ToolCall { id, name, .. } => {
                tool_call_count += 1;
                if id.trim().is_empty() || name.trim().is_empty() {
                    return Err(CodyError::Provider(
                        "provider returned a tool call with an empty id or name".into(),
                    ));
                }
                if !tool_call_ids.insert(id) {
                    return Err(CodyError::Provider(format!(
                        "provider returned duplicate tool call id '{id}'"
                    )));
                }
            }
            ModelContent::ToolResult { .. } => {
                return Err(CodyError::Provider(
                    "provider returned a tool result in assistant output".into(),
                ));
            }
            ModelContent::Text { .. } => {}
        }
    }
    if matches!(response.finish_reason, FinishReason::ToolCalls) && tool_call_count == 0 {
        return Err(CodyError::Provider(
            "provider reported tool_calls without returning a tool call".into(),
        ));
    }
    if tool_call_count > 0 && !matches!(response.finish_reason, FinishReason::ToolCalls) {
        return Err(CodyError::Provider(
            "provider returned tool calls with a non-tool finish reason".into(),
        ));
    }
    Ok(())
}

fn panic_message(payload: Box<dyn std::any::Any + Send>) -> String {
    if let Some(message) = payload.downcast_ref::<&str>() {
        (*message).to_owned()
    } else if let Some(message) = payload.downcast_ref::<String>() {
        message.clone()
    } else {
        "unknown panic payload".into()
    }
}

fn check_cancelled(cancellation: &CancellationToken) -> Result<()> {
    if cancellation.is_cancelled() {
        Err(CodyError::Cancelled)
    } else {
        Ok(())
    }
}

fn model_part_to_domain(content: &ModelContent) -> MessagePart {
    match content {
        ModelContent::Text { text } => MessagePart::Text { text: text.clone() },
        ModelContent::ToolCall {
            id,
            name,
            arguments,
        } => MessagePart::ToolCall {
            id: id.clone(),
            name: name.clone(),
            arguments: arguments.clone(),
        },
        ModelContent::ToolResult {
            tool_call_id,
            name,
            content,
            is_error,
            metadata,
        } => MessagePart::ToolResult {
            tool_call_id: tool_call_id.clone(),
            name: name.clone(),
            content: content.clone(),
            is_error: *is_error,
            metadata: metadata.clone(),
        },
    }
}

fn response_text(response: &ModelResponse) -> String {
    response
        .content
        .iter()
        .filter_map(|content| match content {
            ModelContent::Text { text } => Some(text.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("")
}

fn finish_reason_name(reason: &FinishReason) -> String {
    match reason {
        FinishReason::Stop => "stop".into(),
        FinishReason::ToolCalls => "tool_calls".into(),
        FinishReason::Length => "length".into(),
        FinishReason::ContentFilter => "content_filter".into(),
        FinishReason::Other(value) => value.clone(),
    }
}

fn emit_file_changed(emitter: &TurnEmitter, metadata: &Value) {
    let Some(path) = metadata.get("path").and_then(Value::as_str) else {
        return;
    };
    let project_id = metadata
        .get("project_id")
        .cloned()
        .and_then(|value| serde_json::from_value::<ProjectId>(value).ok());
    emitter.emit(AgentEvent::FileChanged {
        project_id,
        path: path.to_owned(),
    });
}

#[derive(Clone)]
struct TurnEmitter {
    events: EventHub,
    thread_id: ThreadId,
    turn_id: TurnId,
    sequence: Arc<AtomicU64>,
}

impl TurnEmitter {
    fn new(events: EventHub, thread_id: ThreadId, turn_id: TurnId) -> Self {
        Self {
            events,
            thread_id,
            turn_id,
            sequence: Arc::new(AtomicU64::new(0)),
        }
    }

    fn emit(&self, event: AgentEvent) {
        let sequence = self.sequence.fetch_add(1, Ordering::Relaxed) + 1;
        self.events.publish(EventEnvelope::new(
            self.thread_id,
            self.turn_id,
            sequence,
            event,
        ));
    }
}

struct RuntimeDeltaSink {
    emitter: TurnEmitter,
}

#[async_trait]
impl ModelDeltaSink for RuntimeDeltaSink {
    async fn emit(&self, delta: ModelDelta) -> Result<()> {
        if let ModelDelta::Text { text } = delta {
            self.emitter
                .emit(AgentEvent::ModelOutputDelta { delta: text });
        }
        Ok(())
    }
}
