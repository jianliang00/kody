use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex as StdMutex},
};

use async_trait::async_trait;
use chrono::Utc;
use futures_util::FutureExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::{oneshot, Mutex};
use tokio_util::sync::CancellationToken;
use tracing::warn;

use crate::{
    context::{ContextBuilder, ResolvedContext},
    domain::{
        ApprovalId, ContextReference, Message, MessageId, MessagePart, MessageRole, ProjectId,
        ThreadId, ThreadStatus, Turn, TurnId, TurnStatus,
    },
    engine::validate_reference,
    error::{KodyError, Result},
    event::{AgentEvent, EventEnvelope, EventHub},
    provider::{
        FinishReason, ModelContent, ModelDelta, ModelDeltaSink, ModelProvider, ModelRequest,
        ModelResponse, ProviderRegistry, ToolDefinition as ProviderToolDefinition,
    },
    store::StateStore,
    title::{
        is_default_thread_title, normalize_title_candidate, FallbackThreadTitleGenerator,
        LocalThreadTitleGenerator, ThreadTitleGenerator, ThreadTitleRequest,
    },
    tools::{ToolCall, ToolContext, ToolRegistry, ToolResult},
    user_input::UserInputBroker,
};

#[derive(Debug, Clone)]
pub struct AgentRuntimeConfig {
    pub max_steps: usize,
    pub temperature: Option<f32>,
    pub max_output_tokens: Option<u32>,
    /// Arbitrary command execution is not an OS sandbox boundary, so
    /// interactive runtimes require an explicit client decision by default.
    pub require_command_approval: bool,
}

impl Default for AgentRuntimeConfig {
    fn default() -> Self {
        Self {
            max_steps: 24,
            temperature: None,
            max_output_tokens: None,
            require_command_approval: true,
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

/// Executes a prepared Turn through an agent runtime that owns its own loop.
///
/// This boundary is intentionally separate from [`ModelProvider`]: backends
/// such as Codex App Server already plan, call tools, and handle approvals.
/// Treating them as one model completion would nest two agent loops and make
/// cancellation, tools, and durable state ambiguous.
#[async_trait]
pub trait ExternalTurnBackend: std::fmt::Debug + Send + Sync {
    async fn execute(
        &self,
        turn: &Turn,
        context: ResolvedContext,
        cancellation: CancellationToken,
        events: TurnEventEmitter,
    ) -> Result<String>;
}

fn default_provider() -> String {
    "echo".into()
}

struct PersistedTurnOutcome {
    turn: Turn,
    event: AgentEvent,
    error: Option<KodyError>,
}

pub struct AgentRuntime {
    store: Arc<dyn StateStore>,
    providers: Arc<ProviderRegistry>,
    tools: Arc<ToolRegistry>,
    events: EventHub,
    context_builder: Arc<dyn ContextBuilder>,
    title_generator: Arc<dyn ThreadTitleGenerator>,
    config: AgentRuntimeConfig,
    active_threads: Mutex<HashSet<ThreadId>>,
    provider_leases: Mutex<HashMap<TurnId, Arc<dyn ModelProvider>>>,
    approvals: ApprovalBroker,
    user_inputs: UserInputBroker,
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
        Self::new_with_resolved_title_generator(
            store,
            providers,
            tools,
            events,
            context_builder,
            Arc::new(LocalThreadTitleGenerator),
            config,
        )
    }

    /// Builds a runtime with an application- or provider-backed title
    /// generator. Its output is normalized and failures fall back to the
    /// deterministic local generator.
    #[allow(clippy::too_many_arguments)]
    pub fn new_with_title_generator(
        store: Arc<dyn StateStore>,
        providers: Arc<ProviderRegistry>,
        tools: Arc<ToolRegistry>,
        events: EventHub,
        context_builder: Arc<dyn ContextBuilder>,
        title_generator: Arc<dyn ThreadTitleGenerator>,
        config: AgentRuntimeConfig,
    ) -> Self {
        Self::new_with_resolved_title_generator(
            store,
            providers,
            tools,
            events,
            context_builder,
            Arc::new(FallbackThreadTitleGenerator::new(title_generator)),
            config,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn new_with_resolved_title_generator(
        store: Arc<dyn StateStore>,
        providers: Arc<ProviderRegistry>,
        tools: Arc<ToolRegistry>,
        events: EventHub,
        context_builder: Arc<dyn ContextBuilder>,
        title_generator: Arc<dyn ThreadTitleGenerator>,
        config: AgentRuntimeConfig,
    ) -> Self {
        Self {
            store,
            providers,
            tools,
            events,
            context_builder,
            title_generator,
            config,
            active_threads: Mutex::new(HashSet::new()),
            provider_leases: Mutex::new(HashMap::new()),
            approvals: ApprovalBroker::default(),
            user_inputs: UserInputBroker::default(),
        }
    }

    pub fn approvals(&self) -> &ApprovalBroker {
        &self.approvals
    }

    pub fn user_inputs(&self) -> &UserInputBroker {
        &self.user_inputs
    }

    pub fn store(&self) -> &Arc<dyn StateStore> {
        &self.store
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
                KodyError::InvalidInput(format!(
                    "model is required because provider '{}' has no default",
                    request.provider
                ))
            })?
            .to_owned();

        let thread = self.store.get_thread(request.thread_id).await?;
        if thread.status == ThreadStatus::Archived {
            return Err(KodyError::Conflict(format!(
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
                return Err(KodyError::Conflict(format!(
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
        if let Ok(turn) = &result {
            self.provider_leases.lock().await.insert(turn.id, provider);
        }
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
        let provider = match self.provider_leases.lock().await.remove(&turn.id) {
            Some(provider) => Ok(provider),
            None => self.providers.get(&turn.provider),
        };
        let emitter = TurnEventEmitter::new(self.events.clone(), turn.thread_id, turn.id);
        emitter.emit(AgentEvent::TurnStarted);
        let execution = std::panic::AssertUnwindSafe(async {
            self.execute_loop(&turn, cancellation.clone(), emitter.clone(), provider?)
                .await
        })
        .catch_unwind()
        .await;
        let outcome = match execution {
            Ok(outcome) => outcome,
            Err(payload) => Err(KodyError::AgentPanic(panic_message(payload))),
        };
        let persisted =
            std::panic::AssertUnwindSafe(self.finish_turn(&turn, outcome, cancellation))
                .catch_unwind()
                .await
                .unwrap_or_else(|payload| Err(KodyError::AgentPanic(panic_message(payload))));
        self.user_inputs.remove_for_turn(turn.id).await;

        // No return path after a successful claim skips this cleanup. Terminal
        // events are deliberately withheld until the durable Thread is Idle,
        // so an event-triggered read cannot observe a stale Running status.
        let idle_result = self.mark_thread_idle(turn.thread_id).await;
        self.release_thread(turn.thread_id).await;
        match (persisted, idle_result) {
            (Ok(outcome), Ok(())) => {
                let completed_text = match &outcome.event {
                    AgentEvent::TurnCompleted { final_text } => Some(final_text.clone()),
                    _ => None,
                };
                emitter.emit_terminal(outcome.event);
                if let Some(final_text) = completed_text {
                    self.schedule_thread_title(turn, final_text, emitter);
                }
                match outcome.error {
                    Some(error) => Err(error),
                    None => Ok(outcome.turn),
                }
            }
            (Ok(outcome), Err(cleanup_error)) => match outcome.error {
                Some(original) => Err(original),
                None => Err(cleanup_error),
            },
            (Err(original), _) => Err(original),
        }
    }

    /// Execute a queued Turn through an external agent backend while keeping
    /// Kody's durable Turn lifecycle, event ordering, cancellation semantics,
    /// and automatic first-message title generation authoritative.
    pub async fn execute_turn_with_backend(
        &self,
        turn_id: TurnId,
        cancellation: CancellationToken,
        backend: Arc<dyn ExternalTurnBackend>,
    ) -> Result<Turn> {
        let turn = self
            .store
            .transition_turn_status(turn_id, TurnStatus::Queued, TurnStatus::Running)
            .await?;
        // External agent backends do not use the model-completion lease, but
        // preparation still acquired it to make provider reconfiguration
        // atomic and to validate the selected model.
        self.provider_leases.lock().await.remove(&turn.id);
        let emitter = TurnEventEmitter::new(self.events.clone(), turn.thread_id, turn.id);
        emitter.emit(AgentEvent::TurnStarted);

        let execution = std::panic::AssertUnwindSafe(async {
            check_cancelled(&cancellation)?;
            let context = self
                .context_builder
                .build(self.store.as_ref(), &turn)
                .await?;
            // Cancellation remains authoritative at the Kody runtime boundary.
            // A backend receives the token so it can interrupt its remote work,
            // but correctness must not depend on every implementation polling it.
            let final_text = tokio::select! {
                biased;
                _ = cancellation.cancelled() => return Err(KodyError::Cancelled),
                response = backend.execute(
                    &turn,
                    context,
                    cancellation.clone(),
                    emitter.clone(),
                ) => response?,
            };
            check_cancelled(&cancellation)?;
            self.persist_external_response(&turn, final_text.clone())
                .await?;
            Ok(final_text)
        })
        .catch_unwind()
        .await;
        let outcome = match execution {
            Ok(outcome) => outcome,
            Err(payload) => Err(KodyError::AgentPanic(panic_message(payload))),
        };
        // Once the final assistant message has been written, completion is the
        // committed result. A cancellation racing after that write must not
        // leave a durable assistant answer attached to a Cancelled turn.
        let terminal_cancellation = if outcome.is_ok() {
            CancellationToken::new()
        } else {
            cancellation
        };
        let persisted =
            std::panic::AssertUnwindSafe(self.finish_turn(&turn, outcome, terminal_cancellation))
                .catch_unwind()
                .await
                .unwrap_or_else(|payload| Err(KodyError::AgentPanic(panic_message(payload))));
        self.user_inputs.remove_for_turn(turn.id).await;

        let idle_result = self.mark_thread_idle(turn.thread_id).await;
        self.release_thread(turn.thread_id).await;
        match (persisted, idle_result) {
            (Ok(outcome), Ok(())) => {
                let completed_text = match &outcome.event {
                    AgentEvent::TurnCompleted { final_text } => Some(final_text.clone()),
                    _ => None,
                };
                emitter.emit_terminal(outcome.event);
                if let Some(final_text) = completed_text {
                    self.schedule_thread_title(turn, final_text, emitter);
                }
                match outcome.error {
                    Some(error) => Err(error),
                    None => Ok(outcome.turn),
                }
            }
            (Ok(outcome), Err(cleanup_error)) => match outcome.error {
                Some(original) => Err(original),
                None => Err(cleanup_error),
            },
            (Err(original), _) => Err(original),
        }
    }

    async fn finish_turn(
        &self,
        turn: &Turn,
        outcome: Result<String>,
        cancellation: CancellationToken,
    ) -> Result<PersistedTurnOutcome> {
        match outcome {
            Ok(_) if cancellation.is_cancelled() => {
                let terminal = self
                    .store
                    .transition_turn_status(turn.id, TurnStatus::Running, TurnStatus::Cancelled)
                    .await?;
                Ok(PersistedTurnOutcome {
                    turn: terminal,
                    event: AgentEvent::TurnCancelled,
                    error: Some(KodyError::Cancelled),
                })
            }
            Ok(final_text) => {
                let mut terminal = self
                    .store
                    .transition_turn_status(turn.id, TurnStatus::Running, TurnStatus::Completed)
                    .await?;
                terminal.error = None;
                let terminal = self.store.update_turn(terminal).await?;
                Ok(PersistedTurnOutcome {
                    turn: terminal,
                    event: AgentEvent::TurnCompleted { final_text },
                    error: None,
                })
            }
            Err(KodyError::Cancelled) => {
                let terminal = self
                    .store
                    .transition_turn_status(turn.id, TurnStatus::Running, TurnStatus::Cancelled)
                    .await?;
                Ok(PersistedTurnOutcome {
                    turn: terminal,
                    event: AgentEvent::TurnCancelled,
                    error: Some(KodyError::Cancelled),
                })
            }
            Err(error) => {
                let message = error.to_string();
                let mut terminal = self
                    .store
                    .transition_turn_status(turn.id, TurnStatus::Running, TurnStatus::Failed)
                    .await?;
                terminal.error = Some(message.clone());
                let terminal = self.store.update_turn(terminal).await?;
                Ok(PersistedTurnOutcome {
                    turn: terminal,
                    event: AgentEvent::TurnFailed { error: message },
                    error: Some(error),
                })
            }
        }
    }

    async fn execute_loop(
        &self,
        turn: &Turn,
        cancellation: CancellationToken,
        emitter: TurnEventEmitter,
        provider: Arc<dyn ModelProvider>,
    ) -> Result<String> {
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
            let tool_context = ToolContext::new(
                turn.thread_id,
                turn.id,
                resolved.workspace,
                resolved.projects,
                cancellation.clone(),
            );
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
                _ = cancellation.cancelled() => return Err(KodyError::Cancelled),
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
                let requires_approval = self.config.require_command_approval
                    && self.tools.risk(&call.name)? == crate::tools::ToolRisk::CommandExecution;
                if requires_approval {
                    let approved = self
                        .request_tool_approval(turn, &call, &cancellation, &emitter)
                        .await?;
                    if !approved {
                        let result = ToolResult::error(
                            &call,
                            "command execution was denied by the user",
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
                    Err(KodyError::Cancelled) => return Err(KodyError::Cancelled),
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

        Err(KodyError::StepLimit(self.config.max_steps))
    }

    async fn request_tool_approval(
        &self,
        turn: &Turn,
        call: &ToolCall,
        cancellation: &CancellationToken,
        emitter: &TurnEventEmitter,
    ) -> Result<bool> {
        let approval_id = ApprovalId::new();
        let reason = self
            .tools
            .approval_reason(&call.name)?
            .unwrap_or("This tool requires explicit approval.")
            .to_owned();
        let receiver = self
            .approvals
            .register(PendingApproval {
                approval_id,
                thread_id: turn.thread_id,
                turn_id: turn.id,
                tool_call_id: call.id.clone(),
                name: call.name.clone(),
                arguments: call.arguments.clone(),
                reason: reason.clone(),
            })
            .await?;
        emitter.emit(AgentEvent::ApprovalRequested {
            approval_id,
            tool_call_id: call.id.clone(),
            name: call.name.clone(),
            arguments: call.arguments.clone(),
            reason,
        });
        let decision = tokio::select! {
            biased;
            _ = cancellation.cancelled() => {
                self.approvals.remove(approval_id).await;
                return Err(KodyError::Cancelled);
            }
            decision = receiver => decision.map_err(|_| {
                KodyError::Conflict(format!("approval {approval_id} was closed without a decision"))
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

    async fn persist_external_response(&self, turn: &Turn, text: String) -> Result<()> {
        let message = Message {
            id: MessageId::new(),
            thread_id: turn.thread_id,
            turn_id: Some(turn.id),
            role: MessageRole::Assistant,
            parts: vec![MessagePart::Text { text }],
            references: Vec::new(),
            created_at: Utc::now(),
        };
        self.store.append_message(message).await.map(|_| ())
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

    fn schedule_thread_title(
        &self,
        turn: Turn,
        assistant_response: String,
        emitter: TurnEventEmitter,
    ) {
        let store = self.store.clone();
        let generator = self.title_generator.clone();
        tokio::spawn(async move {
            match generate_first_completed_turn_title(
                store.as_ref(),
                generator.as_ref(),
                &turn,
                assistant_response,
            )
            .await
            {
                Ok(Some(title)) => emitter.emit_thread_updated(title),
                Ok(None) => {}
                Err(error) => {
                    // Title generation is presentation metadata. A completed turn
                    // must stay completed even when enrichment or persistence
                    // fails.
                    warn!(
                        thread_id = %turn.thread_id,
                        turn_id = %turn.id,
                        %error,
                        "background thread title generation failed"
                    );
                }
            }
        });
    }
}

async fn generate_first_completed_turn_title(
    store: &dyn StateStore,
    generator: &dyn ThreadTitleGenerator,
    turn: &Turn,
    assistant_response: String,
) -> Result<Option<String>> {
    let thread = store.get_thread(turn.thread_id).await?;
    if !is_default_thread_title(&thread.title) {
        return Ok(None);
    }

    let turns = store.list_turns(turn.thread_id).await?;
    let first_completed = turns
        .iter()
        .filter(|candidate| candidate.status == TurnStatus::Completed)
        .min_by(|left, right| {
            left.created_at
                .cmp(&right.created_at)
                .then_with(|| left.id.cmp(&right.id))
        });
    if first_completed.map(|candidate| candidate.id) != Some(turn.id) {
        return Ok(None);
    }

    let input = store.get_message(turn.input_message_id).await?;
    let request = ThreadTitleRequest {
        thread_id: turn.thread_id,
        turn_id: turn.id,
        user_message: input.text(),
        assistant_response,
        provider: turn.provider.clone(),
        model: turn.model.clone(),
    };
    let Some(candidate) = generator.generate(&request).await? else {
        return Ok(None);
    };
    let Some(title) = normalize_title_candidate(&candidate) else {
        return Ok(None);
    };
    if is_default_thread_title(&title) {
        return Ok(None);
    }

    // The store-level CAS changes only the title. A later Turn may transition
    // status while a provider-backed generator is running, and that unrelated
    // state must neither make title enrichment fail nor be overwritten.
    match store
        .update_thread_title_if_default(turn.thread_id, title.clone())
        .await?
    {
        Some(_) => Ok(Some(title)),
        None => Ok(None),
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PendingApproval {
    pub approval_id: ApprovalId,
    pub thread_id: ThreadId,
    pub turn_id: TurnId,
    pub tool_call_id: String,
    pub name: String,
    pub arguments: Value,
    pub reason: String,
}

struct PendingApprovalEntry {
    approval: PendingApproval,
    decision: oneshot::Sender<bool>,
}

#[derive(Clone, Default)]
pub struct ApprovalBroker {
    pending: Arc<Mutex<std::collections::HashMap<ApprovalId, PendingApprovalEntry>>>,
}

impl ApprovalBroker {
    pub async fn register(&self, approval: PendingApproval) -> Result<oneshot::Receiver<bool>> {
        let (sender, receiver) = oneshot::channel();
        let approval_id = approval.approval_id;
        if self
            .pending
            .lock()
            .await
            .insert(
                approval_id,
                PendingApprovalEntry {
                    approval,
                    decision: sender,
                },
            )
            .is_some()
        {
            return Err(KodyError::Conflict(format!(
                "approval {approval_id} is already pending"
            )));
        }
        Ok(receiver)
    }

    /// Returns a snapshot of actionable approvals so a reconnecting client can
    /// recover even when it missed the original live event.
    pub async fn list(&self, thread_id: Option<ThreadId>) -> Vec<PendingApproval> {
        self.pending
            .lock()
            .await
            .values()
            .filter(|entry| thread_id.is_none_or(|id| entry.approval.thread_id == id))
            .map(|entry| entry.approval.clone())
            .collect()
    }

    /// Resolves an approval if it is still actionable. A missing entry or a
    /// receiver that has already gone away is a normal stale-client race, not
    /// an RPC failure: callers can refresh the durable Thread snapshot and
    /// converge on the already-resolved state.
    pub async fn respond(&self, approval_id: ApprovalId, approved: bool) -> Result<bool> {
        let Some(entry) = self.pending.lock().await.remove(&approval_id) else {
            return Ok(false);
        };
        Ok(entry.decision.send(approved).is_ok())
    }

    pub async fn remove(&self, approval_id: ApprovalId) {
        self.pending.lock().await.remove(&approval_id);
    }
}

fn validate_start_turn(request: &StartTurn) -> Result<()> {
    if request.message.trim().is_empty() {
        return Err(KodyError::InvalidInput(
            "turn message cannot be empty".into(),
        ));
    }
    if request.message.chars().count() > 128_000 {
        return Err(KodyError::InvalidInput(
            "turn message exceeds the 128,000 character limit".into(),
        ));
    }
    if request.provider.trim().is_empty() {
        return Err(KodyError::InvalidInput("provider cannot be empty".into()));
    }
    if request
        .model
        .as_deref()
        .is_some_and(|model| model.trim().is_empty())
    {
        return Err(KodyError::InvalidInput(
            "model cannot be blank when provided".into(),
        ));
    }
    if let Some(temperature) = request.temperature {
        if !temperature.is_finite() || !(0.0..=2.0).contains(&temperature) {
            return Err(KodyError::InvalidInput(
                "temperature must be between 0 and 2".into(),
            ));
        }
    }
    if request.max_output_tokens == Some(0) {
        return Err(KodyError::InvalidInput(
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
                    return Err(KodyError::Provider(
                        "provider returned a tool call with an empty id or name".into(),
                    ));
                }
                if !tool_call_ids.insert(id) {
                    return Err(KodyError::Provider(format!(
                        "provider returned duplicate tool call id '{id}'"
                    )));
                }
            }
            ModelContent::ToolResult { .. } => {
                return Err(KodyError::Provider(
                    "provider returned a tool result in assistant output".into(),
                ));
            }
            ModelContent::Text { .. } => {}
        }
    }
    if matches!(response.finish_reason, FinishReason::ToolCalls) && tool_call_count == 0 {
        return Err(KodyError::Provider(
            "provider reported tool_calls without returning a tool call".into(),
        ));
    }
    if tool_call_count > 0 && !matches!(response.finish_reason, FinishReason::ToolCalls) {
        return Err(KodyError::Provider(
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
        Err(KodyError::Cancelled)
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

fn emit_file_changed(emitter: &TurnEventEmitter, metadata: &Value) {
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

#[derive(Debug, Clone)]
pub struct TurnEventEmitter {
    events: EventHub,
    thread_id: ThreadId,
    turn_id: TurnId,
    state: Arc<StdMutex<TurnEventState>>,
}

#[derive(Debug, Default)]
struct TurnEventState {
    sequence: u64,
    terminal_emitted: bool,
}

impl TurnEventEmitter {
    fn new(events: EventHub, thread_id: ThreadId, turn_id: TurnId) -> Self {
        Self {
            events,
            thread_id,
            turn_id,
            state: Arc::new(StdMutex::new(TurnEventState::default())),
        }
    }

    /// Emits a non-terminal execution event. Terminal and title events remain
    /// runtime-owned so an external backend cannot complete a Turn or mutate
    /// presentation metadata independently of durable state.
    pub fn emit(&self, event: AgentEvent) {
        if is_runtime_owned_event(&event) {
            return;
        }
        let mut state = self.lock_state();
        if state.terminal_emitted {
            return;
        }
        self.publish(&mut state, event);
    }

    fn emit_terminal(&self, event: AgentEvent) {
        debug_assert!(is_terminal_event(&event));
        let mut state = self.lock_state();
        if state.terminal_emitted || !is_terminal_event(&event) {
            return;
        }
        state.terminal_emitted = true;
        self.publish(&mut state, event);
    }

    fn emit_thread_updated(&self, title: String) {
        let mut state = self.lock_state();
        if !state.terminal_emitted {
            return;
        }
        self.publish(&mut state, AgentEvent::ThreadUpdated { title });
    }

    fn lock_state(&self) -> std::sync::MutexGuard<'_, TurnEventState> {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn publish(&self, state: &mut TurnEventState, event: AgentEvent) {
        state.sequence += 1;
        self.events.publish(EventEnvelope::new(
            self.thread_id,
            self.turn_id,
            state.sequence,
            event,
        ));
    }
}

fn is_terminal_event(event: &AgentEvent) -> bool {
    matches!(
        event,
        AgentEvent::TurnCompleted { .. }
            | AgentEvent::TurnFailed { .. }
            | AgentEvent::TurnCancelled
    )
}

fn is_runtime_owned_event(event: &AgentEvent) -> bool {
    is_terminal_event(event) || matches!(event, AgentEvent::ThreadUpdated { .. })
}

struct RuntimeDeltaSink {
    emitter: TurnEventEmitter,
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
