use std::{sync::Arc, time::Duration};

use kody_app_server::AppState;
use kody_core::{
    AgentEvent, EngineConfig, KodyEngine, PermissionMode, StartTurn, DEFAULT_THREAD_TITLE,
};

/// Manual end-to-end proof that Kody can execute a durable Turn through the
/// user's official Codex App Server login and receive the streamed answer.
#[tokio::test]
#[ignore = "uses a locally installed Codex and the signed-in ChatGPT plan quota"]
async fn executes_a_real_turn_with_codex_plan_quota() {
    let root = tempfile::tempdir().unwrap();
    let engine = Arc::new(
        KodyEngine::in_memory(EngineConfig {
            state_root: root.path().join("engine"),
            ..EngineConfig::default()
        })
        .await
        .unwrap(),
    );
    let state = AppState::with_auth(engine.clone(), "live-test", Default::default());
    let models = state.codex.models().await.unwrap();
    let model = models
        .iter()
        .find(|model| model.is_default)
        .or_else(|| models.first())
        .expect("Codex must expose at least one model")
        .id
        .clone();
    let (thread, _, _) = engine
        .create_thread(DEFAULT_THREAD_TITLE, None::<std::path::PathBuf>)
        .await
        .unwrap();
    let mut events = engine.events().subscribe();
    let turn = state
        .turns
        .start(
            engine.runtime().clone(),
            StartTurn {
                thread_id: thread.id,
                message: "Reply with exactly KODY_CODEX_SMOKE_OK. Do not call tools.".into(),
                references: Vec::new(),
                provider: "codex".into(),
                model: Some(model),
                permission_mode: Some(PermissionMode::ReadOnly),
                temperature: None,
                max_output_tokens: None,
            },
        )
        .await
        .unwrap();

    let final_text = match tokio::time::timeout(Duration::from_secs(120), async {
        loop {
            let event = events.recv().await.unwrap();
            if event.turn_id != turn.id {
                continue;
            }
            match event.event {
                AgentEvent::TurnCompleted { final_text } => break final_text,
                AgentEvent::TurnFailed { error } => panic!("Codex Turn failed: {error}"),
                AgentEvent::TurnCancelled => panic!("Codex Turn was cancelled"),
                _ => {}
            }
        }
    })
    .await
    {
        Ok(text) => text,
        Err(_) => {
            state.turns.cancel(turn.id).await;
            panic!("timed out waiting for the Codex Turn")
        }
    };
    assert!(final_text.contains("KODY_CODEX_SMOKE_OK"));

    let messages = engine.store().list_messages(thread.id).await.unwrap();
    assert!(messages
        .iter()
        .any(|message| message.role == kody_core::MessageRole::Assistant
            && message.text().contains("KODY_CODEX_SMOKE_OK")));
    assert!(!engine
        .store()
        .get_thread(thread.id)
        .await
        .unwrap()
        .external_thread_ids
        .contains_key("codex"));
    state.codex.shutdown().await;
}
