use std::{future::pending, sync::Arc, time::Duration};

use async_trait::async_trait;
use chrono::Utc;
use cody_core::{
    provider::{
        FinishReason, ModelContent, ModelDeltaSink, ModelProvider, ModelRequest, ModelResponse,
        ModelRole, ScriptedProvider,
    },
    AgentEvent, CodyEngine, ContextReference, EngineConfig, InMemoryStore, Message, MessageId,
    MessagePart, MessageRole, Result, StartTurn, ThreadReferenceMode, ThreadStatus,
    ThreadTitleGenerator, ThreadTitleRequest, TurnStatus, DEFAULT_THREAD_TITLE,
};
use serde_json::json;
use tempfile::TempDir;
use tokio_util::sync::CancellationToken;

async fn engine() -> (CodyEngine, TempDir) {
    let state = TempDir::new().unwrap();
    let config = EngineConfig {
        state_root: state.path().join("state"),
        ..EngineConfig::default()
    };
    (CodyEngine::new(config).await.unwrap(), state)
}

async fn wait_for_title(engine: &CodyEngine, thread_id: cody_core::ThreadId) -> String {
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            let title = engine.store().get_thread(thread_id).await.unwrap().title;
            if title != DEFAULT_THREAD_TITLE {
                return title;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("background title generation timed out")
}

#[tokio::test]
async fn first_completed_echo_turn_generates_one_deterministic_title() {
    let (engine, _state) = engine().await;
    engine
        .providers()
        .register(Arc::new(cody_core::provider::EchoProvider::default()))
        .unwrap();
    let (thread, _, _) = engine
        .create_thread(DEFAULT_THREAD_TITLE, None)
        .await
        .unwrap();

    let first = engine
        .runtime()
        .prepare_turn(StartTurn {
            thread_id: thread.id,
            message: "## Implement OAuth callback handling!\nKeep existing sessions.".into(),
            references: Vec::new(),
            provider: "echo".into(),
            model: None,
            temperature: None,
            max_output_tokens: None,
        })
        .await
        .unwrap();
    engine
        .runtime()
        .execute_turn(first.id, CancellationToken::new())
        .await
        .unwrap();

    assert_eq!(
        wait_for_title(&engine, thread.id).await,
        "Implement OAuth callback handling"
    );

    let second = engine
        .runtime()
        .prepare_turn(StartTurn {
            thread_id: thread.id,
            message: "Replace the title with something else".into(),
            references: Vec::new(),
            provider: "echo".into(),
            model: None,
            temperature: None,
            max_output_tokens: None,
        })
        .await
        .unwrap();
    engine
        .runtime()
        .execute_turn(second.id, CancellationToken::new())
        .await
        .unwrap();
    tokio::task::yield_now().await;

    assert_eq!(
        engine.store().get_thread(thread.id).await.unwrap().title,
        "Implement OAuth callback handling"
    );
}

#[tokio::test]
async fn an_explicit_thread_title_is_never_overwritten() {
    let (engine, _state) = engine().await;
    engine
        .providers()
        .register(Arc::new(cody_core::provider::EchoProvider::default()))
        .unwrap();
    let (thread, _, _) = engine
        .create_thread("User-chosen architecture title", None)
        .await
        .unwrap();
    let turn = engine
        .runtime()
        .prepare_turn(StartTurn {
            thread_id: thread.id,
            message: "This message would otherwise become a title".into(),
            references: Vec::new(),
            provider: "echo".into(),
            model: None,
            temperature: None,
            max_output_tokens: None,
        })
        .await
        .unwrap();
    engine
        .runtime()
        .execute_turn(turn.id, CancellationToken::new())
        .await
        .unwrap();
    tokio::task::yield_now().await;

    assert_eq!(
        engine.store().get_thread(thread.id).await.unwrap().title,
        "User-chosen architecture title"
    );
}

#[derive(Debug)]
struct BlockingTitleGenerator {
    started: tokio::sync::Semaphore,
}

impl Default for BlockingTitleGenerator {
    fn default() -> Self {
        Self {
            started: tokio::sync::Semaphore::new(0),
        }
    }
}

#[async_trait]
impl ThreadTitleGenerator for BlockingTitleGenerator {
    async fn generate(&self, _request: &ThreadTitleRequest) -> Result<Option<String>> {
        self.started.add_permits(1);
        pending().await
    }
}

#[tokio::test]
async fn provider_backed_title_generation_never_blocks_turn_completion() {
    let state = TempDir::new().unwrap();
    let config = EngineConfig {
        state_root: state.path().join("state"),
        ..EngineConfig::default()
    };
    let generator = Arc::new(BlockingTitleGenerator::default());
    let engine = CodyEngine::with_store_and_title_generator(
        config,
        Arc::new(InMemoryStore::default()),
        generator.clone(),
    )
    .await
    .unwrap();
    engine
        .providers()
        .register(Arc::new(cody_core::provider::EchoProvider::default()))
        .unwrap();
    let (thread, _, _) = engine
        .create_thread(DEFAULT_THREAD_TITLE, None)
        .await
        .unwrap();
    let turn = engine
        .runtime()
        .prepare_turn(StartTurn {
            thread_id: thread.id,
            message: "Complete without waiting for a title model".into(),
            references: Vec::new(),
            provider: "echo".into(),
            model: None,
            temperature: None,
            max_output_tokens: None,
        })
        .await
        .unwrap();

    let completed = tokio::time::timeout(
        Duration::from_millis(250),
        engine
            .runtime()
            .execute_turn(turn.id, CancellationToken::new()),
    )
    .await
    .expect("turn completion waited for title generation")
    .unwrap();
    assert_eq!(completed.status, TurnStatus::Completed);
    generator.started.acquire().await.unwrap().forget();
    assert_eq!(
        engine.store().get_thread(thread.id).await.unwrap().title,
        DEFAULT_THREAD_TITLE
    );
}

#[tokio::test]
async fn terminal_event_is_emitted_only_after_thread_is_idle() {
    let (engine, _state) = engine().await;
    engine
        .providers()
        .register(Arc::new(cody_core::provider::EchoProvider::default()))
        .unwrap();
    let (thread, _, _) = engine.create_thread("Ordering test", None).await.unwrap();
    let turn = engine
        .runtime()
        .prepare_turn(StartTurn {
            thread_id: thread.id,
            message: "Complete this turn".into(),
            references: Vec::new(),
            provider: "echo".into(),
            model: None,
            temperature: None,
            max_output_tokens: None,
        })
        .await
        .unwrap();
    let mut events = engine.events().subscribe();
    let runtime = engine.runtime().clone();
    let turn_id = turn.id;
    let execution = tokio::spawn(async move {
        runtime
            .execute_turn(turn_id, CancellationToken::new())
            .await
    });

    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            let envelope = events.recv().await.unwrap();
            if matches!(envelope.event, AgentEvent::TurnCompleted { .. }) {
                assert_eq!(
                    engine.store().get_thread(thread.id).await.unwrap().status,
                    ThreadStatus::Idle
                );
                assert_eq!(
                    engine.store().get_turn(turn.id).await.unwrap().status,
                    TurnStatus::Completed
                );
                break;
            }
        }
    })
    .await
    .expect("terminal event was not emitted");
    assert_eq!(
        execution.await.unwrap().unwrap().status,
        TurnStatus::Completed
    );
}

#[tokio::test]
async fn agent_loop_executes_tools_persists_history_and_emits_ordered_events() {
    let (engine, _state) = engine().await;
    let project_root = TempDir::new().unwrap();
    let (thread, _, imported) = engine
        .create_thread("implement greeting", Some(project_root.path().to_owned()))
        .await
        .unwrap();
    let project = imported.unwrap();

    let provider = Arc::new(ScriptedProvider::with_responses(
        "test",
        [
            ModelResponse {
                content: vec![
                    ModelContent::Text {
                        text: "I will create the file.".into(),
                    },
                    ModelContent::ToolCall {
                        id: "call-write".into(),
                        name: "write_file".into(),
                        arguments: json!({
                            "project_id": project.id,
                            "path": "hello.txt",
                            "content": "hello from Cody\n"
                        }),
                    },
                ],
                finish_reason: FinishReason::ToolCalls,
                usage: None,
            },
            ModelResponse::text("Created `hello.txt` and verified the tool result."),
        ],
    ));
    engine.providers().register(provider.clone()).unwrap();
    let mut events = engine.events().subscribe();

    let turn = engine
        .runtime()
        .prepare_turn(StartTurn {
            thread_id: thread.id,
            message: "Create a greeting file".into(),
            references: Vec::new(),
            provider: "test".into(),
            model: None,
            temperature: Some(0.2),
            max_output_tokens: Some(1_024),
        })
        .await
        .unwrap();
    let completed = engine
        .runtime()
        .execute_turn(turn.id, CancellationToken::new())
        .await
        .unwrap();

    assert_eq!(completed.status, TurnStatus::Completed);
    assert_eq!(
        tokio::fs::read_to_string(project_root.path().join("hello.txt"))
            .await
            .unwrap(),
        "hello from Cody\n"
    );

    let messages = engine.store().list_messages(thread.id).await.unwrap();
    assert_eq!(messages.len(), 4);
    assert_eq!(messages[0].role, MessageRole::User);
    assert_eq!(messages[1].role, MessageRole::Assistant);
    assert_eq!(messages[2].role, MessageRole::Tool);
    assert_eq!(messages[3].role, MessageRole::Assistant);
    assert!(matches!(
        &messages[2].parts[0],
        MessagePart::ToolResult {
            is_error: false,
            ..
        }
    ));

    let requests = provider.requests().unwrap();
    assert_eq!(requests[0].model, "scripted");
    assert_eq!(requests.len(), 2);
    assert_eq!(requests[0].temperature, Some(0.2));
    assert_eq!(requests[0].max_output_tokens, Some(1_024));
    assert_eq!(requests[0].tools.len(), 8);
    assert!(requests[0].messages[0]
        .text_content()
        .contains(&project.id.to_string()));
    assert!(requests[1].messages.iter().any(|message| {
        message.role == ModelRole::Tool
            && message
                .content
                .iter()
                .any(|part| matches!(part, ModelContent::ToolResult { .. }))
    }));

    let mut envelopes = Vec::new();
    while let Ok(event) = events.try_recv() {
        envelopes.push(event);
    }
    assert!(!envelopes.is_empty());
    assert!(envelopes
        .iter()
        .any(|event| matches!(event.event, AgentEvent::FileChanged { .. })));
    assert!(matches!(
        envelopes.last().unwrap().event,
        AgentEvent::TurnCompleted { .. }
    ));
    assert!(envelopes
        .iter()
        .enumerate()
        .all(|(index, event)| event.sequence == (index + 1) as u64));
    assert_eq!(
        engine.store().get_thread(thread.id).await.unwrap().status,
        ThreadStatus::Idle
    );
}

#[derive(Debug)]
struct BlockingProvider {
    started: tokio::sync::Semaphore,
}

impl Default for BlockingProvider {
    fn default() -> Self {
        Self {
            started: tokio::sync::Semaphore::new(0),
        }
    }
}

#[async_trait]
impl ModelProvider for BlockingProvider {
    fn id(&self) -> &str {
        "blocking"
    }

    fn default_model(&self) -> Option<&str> {
        Some("blocking-model")
    }

    async fn complete(
        &self,
        _request: ModelRequest,
        _delta_sink: Option<&dyn ModelDeltaSink>,
    ) -> Result<ModelResponse> {
        self.started.add_permits(1);
        std::future::pending().await
    }
}

#[tokio::test]
async fn cancellation_cleans_up_and_a_duplicate_executor_cannot_claim_the_turn() {
    let (engine, _state) = engine().await;
    let (thread, _, _) = engine.create_thread("cancel", None).await.unwrap();
    let provider = Arc::new(BlockingProvider::default());
    engine.providers().register(provider.clone()).unwrap();
    let turn = engine
        .runtime()
        .prepare_turn(StartTurn {
            thread_id: thread.id,
            message: "wait".into(),
            references: Vec::new(),
            provider: "blocking".into(),
            model: None,
            temperature: None,
            max_output_tokens: None,
        })
        .await
        .unwrap();

    let cancellation = CancellationToken::new();
    let runtime = engine.runtime().clone();
    let first_token = cancellation.clone();
    let first = tokio::spawn(async move { runtime.execute_turn(turn.id, first_token).await });
    provider.started.acquire().await.unwrap().forget();

    let duplicate = engine
        .runtime()
        .execute_turn(turn.id, CancellationToken::new())
        .await
        .unwrap_err();
    assert!(matches!(duplicate, cody_core::CodyError::Conflict(_)));

    cancellation.cancel();
    assert!(matches!(
        first.await.unwrap(),
        Err(cody_core::CodyError::Cancelled)
    ));
    assert_eq!(
        engine.store().get_turn(turn.id).await.unwrap().status,
        TurnStatus::Cancelled
    );
    assert_eq!(
        engine.store().get_thread(thread.id).await.unwrap().status,
        ThreadStatus::Idle
    );
}

#[tokio::test]
async fn shell_waits_for_an_explicit_approval_decision() {
    let (engine, _state) = engine().await;
    let (thread, workspace, _) = engine.create_thread("approval", None).await.unwrap();
    let provider = Arc::new(ScriptedProvider::with_responses(
        "approval-provider",
        [
            ModelResponse {
                content: vec![ModelContent::ToolCall {
                    id: "call-shell".into(),
                    name: "shell".into(),
                    arguments: json!({ "command": "printf approved > approved.txt" }),
                }],
                finish_reason: FinishReason::ToolCalls,
                usage: None,
            },
            ModelResponse::text("approved command completed"),
        ],
    ));
    engine.providers().register(provider).unwrap();
    let turn = engine
        .runtime()
        .prepare_turn(StartTurn {
            thread_id: thread.id,
            message: "run the command".into(),
            references: Vec::new(),
            provider: "approval-provider".into(),
            model: None,
            temperature: None,
            max_output_tokens: None,
        })
        .await
        .unwrap();
    let mut events = engine.events().subscribe();
    let runtime = engine.runtime().clone();
    let turn_id = turn.id;
    let execution = tokio::spawn(async move {
        runtime
            .execute_turn(turn_id, CancellationToken::new())
            .await
    });

    let approval_id = loop {
        let event = tokio::time::timeout(std::time::Duration::from_secs(2), events.recv())
            .await
            .unwrap()
            .unwrap();
        if let AgentEvent::ApprovalRequested { approval_id, .. } = event.event {
            break approval_id;
        }
    };
    assert!(tokio::fs::metadata(workspace.root.join("approved.txt"))
        .await
        .is_err());
    let pending = engine.runtime().approvals().list(Some(thread.id)).await;
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].approval_id, approval_id);
    assert_eq!(pending[0].turn_id, turn_id);
    assert_eq!(pending[0].name, "shell");
    engine
        .runtime()
        .approvals()
        .respond(approval_id, true)
        .await
        .unwrap();
    assert!(engine
        .runtime()
        .approvals()
        .list(Some(thread.id))
        .await
        .is_empty());

    assert_eq!(
        execution.await.unwrap().unwrap().status,
        TurnStatus::Completed
    );
    assert_eq!(
        tokio::fs::read_to_string(workspace.root.join("approved.txt"))
            .await
            .unwrap(),
        "approved"
    );
}

#[tokio::test]
async fn managed_process_start_uses_command_approval_and_outlives_its_turn() {
    let (engine, _state) = engine().await;
    let (thread, workspace, _) = engine
        .create_thread("managed process approval", None)
        .await
        .unwrap();
    let provider = Arc::new(ScriptedProvider::with_responses(
        "process-approval-provider",
        [
            ModelResponse {
                content: vec![ModelContent::ToolCall {
                    id: "process-call".into(),
                    name: "start_process".into(),
                    arguments: json!({
                        "command": "printf started > process-started.txt; exec sleep 30"
                    }),
                }],
                finish_reason: FinishReason::ToolCalls,
                usage: None,
            },
            ModelResponse::text("managed process started"),
        ],
    ));
    engine.providers().register(provider).unwrap();
    let turn = engine
        .runtime()
        .prepare_turn(StartTurn {
            thread_id: thread.id,
            message: "start the managed process".into(),
            references: Vec::new(),
            provider: "process-approval-provider".into(),
            model: None,
            temperature: None,
            max_output_tokens: None,
        })
        .await
        .unwrap();
    let mut events = engine.events().subscribe();
    let runtime = engine.runtime().clone();
    let turn_id = turn.id;
    let execution = tokio::spawn(async move {
        runtime
            .execute_turn(turn_id, CancellationToken::new())
            .await
    });

    let approval_id = loop {
        let event = tokio::time::timeout(Duration::from_secs(2), events.recv())
            .await
            .unwrap()
            .unwrap();
        if let AgentEvent::ApprovalRequested {
            approval_id, name, ..
        } = event.event
        {
            assert_eq!(name, "start_process");
            break approval_id;
        }
    };
    assert!(
        tokio::fs::metadata(workspace.root.join("process-started.txt"))
            .await
            .is_err()
    );
    engine
        .runtime()
        .approvals()
        .respond(approval_id, true)
        .await
        .unwrap();

    let completed = execution.await.unwrap().unwrap();
    let process = engine.processes().list(thread.id).await.unwrap().remove(0);
    let marker = tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            match tokio::fs::read_to_string(workspace.root.join("process-started.txt")).await {
                Ok(marker) => break marker,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    tokio::task::yield_now().await;
                }
                Err(error) => panic!("failed to read process marker: {error}"),
            }
        }
    })
    .await;
    let stopped = engine.shutdown().await.unwrap();

    assert_eq!(completed.status, TurnStatus::Completed);
    assert!(process.status.is_active());
    assert_eq!(marker.unwrap(), "started");
    assert_eq!(stopped.len(), 1);
    assert_eq!(stopped[0].id, process.id);
}

#[tokio::test]
async fn referenced_thread_context_is_resolved_without_copying_messages() {
    let (engine, _state) = engine().await;
    let (source, _, _) = engine.create_thread("OAuth design", None).await.unwrap();
    engine
        .store()
        .append_message(Message {
            id: MessageId::new(),
            thread_id: source.id,
            turn_id: None,
            role: MessageRole::User,
            parts: vec![MessagePart::Text {
                text: "Use rotating refresh tokens and PKCE.".into(),
            }],
            references: Vec::new(),
            created_at: Utc::now(),
        })
        .await
        .unwrap();

    let (target, _, _) = engine
        .create_thread("OAuth implementation", None)
        .await
        .unwrap();
    let provider = Arc::new(ScriptedProvider::with_responses(
        "test-ref",
        [ModelResponse::text("Understood.")],
    ));
    engine.providers().register(provider.clone()).unwrap();

    let turn = engine
        .runtime()
        .prepare_turn(StartTurn {
            thread_id: target.id,
            message: "Implement the referenced design".into(),
            references: vec![ContextReference::Thread {
                thread_id: source.id,
                mode: ThreadReferenceMode::Summary,
                message_ids: Vec::new(),
            }],
            provider: "test-ref".into(),
            model: Some("test-model".into()),
            temperature: None,
            max_output_tokens: None,
        })
        .await
        .unwrap();
    engine
        .runtime()
        .execute_turn(turn.id, CancellationToken::new())
        .await
        .unwrap();

    let requests = provider.requests().unwrap();
    let prompt = requests[0]
        .messages
        .iter()
        .map(|message| message.text_content())
        .collect::<Vec<_>>()
        .join("\n");
    assert!(prompt.contains("Use rotating refresh tokens and PKCE."));
    assert!(prompt.contains("Reference data only"));
    assert_eq!(
        engine.store().list_messages(source.id).await.unwrap().len(),
        1
    );

    let target_messages = engine.store().list_messages(target.id).await.unwrap();
    assert!(matches!(
        &target_messages[0].references[0],
        ContextReference::Thread { thread_id, .. } if *thread_id == source.id
    ));
}

#[tokio::test]
async fn provider_failure_releases_thread_for_the_next_turn() {
    let (engine, _state) = engine().await;
    let (thread, _, _) = engine
        .create_thread("failure recovery", None)
        .await
        .unwrap();
    let provider = Arc::new(ScriptedProvider::new("failing"));
    provider.enqueue_error("upstream unavailable").unwrap();
    provider
        .enqueue_response(ModelResponse::text("recovered"))
        .unwrap();
    engine.providers().register(provider).unwrap();

    let request = || StartTurn {
        thread_id: thread.id,
        message: "try".into(),
        references: Vec::new(),
        provider: "failing".into(),
        model: Some("model".into()),
        temperature: None,
        max_output_tokens: None,
    };

    let first = engine.runtime().prepare_turn(request()).await.unwrap();
    let error = engine
        .runtime()
        .execute_turn(first.id, CancellationToken::new())
        .await
        .unwrap_err();
    assert!(error.to_string().contains("upstream unavailable"));
    assert_eq!(
        engine.store().get_turn(first.id).await.unwrap().status,
        TurnStatus::Failed
    );
    assert_eq!(
        engine.store().get_thread(thread.id).await.unwrap().status,
        ThreadStatus::Idle
    );

    let second = engine.runtime().prepare_turn(request()).await.unwrap();
    let completed = engine
        .runtime()
        .execute_turn(second.id, CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(completed.status, TurnStatus::Completed);
}

#[tokio::test]
async fn durable_engine_recovers_an_interrupted_queued_turn_on_restart() {
    let state = TempDir::new().unwrap();
    let config = EngineConfig {
        state_root: state.path().join("state"),
        ..EngineConfig::default()
    };

    let engine = CodyEngine::new(config.clone()).await.unwrap();
    engine
        .providers()
        .register(Arc::new(cody_core::provider::EchoProvider::default()))
        .unwrap();
    let (thread, _, _) = engine.create_thread("restart", None).await.unwrap();
    let turn = engine
        .runtime()
        .prepare_turn(StartTurn {
            thread_id: thread.id,
            message: "this turn will be interrupted".into(),
            references: Vec::new(),
            provider: "echo".into(),
            model: None,
            temperature: None,
            max_output_tokens: None,
        })
        .await
        .unwrap();
    drop(engine);

    let restarted = CodyEngine::new(config).await.unwrap();
    let recovered_turn = restarted.store().get_turn(turn.id).await.unwrap();
    assert_eq!(recovered_turn.status, TurnStatus::Failed);
    assert!(recovered_turn
        .error
        .as_deref()
        .unwrap()
        .contains("restarted"));
    assert_eq!(
        restarted
            .store()
            .get_thread(thread.id)
            .await
            .unwrap()
            .status,
        ThreadStatus::Idle
    );
}
