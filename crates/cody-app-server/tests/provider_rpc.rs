use std::sync::Arc;

use cody_app_server::{AppState, RpcDispatcher, RpcRequest};
use cody_core::{provider::EchoProvider, CodyEngine, EngineConfig};
use serde_json::{json, Value};

async fn fixture() -> (tempfile::TempDir, RpcDispatcher) {
    let root = tempfile::tempdir().unwrap();
    let engine = Arc::new(
        CodyEngine::in_memory(EngineConfig {
            state_root: root.path().join("state"),
            ..EngineConfig::default()
        })
        .await
        .unwrap(),
    );
    engine
        .providers()
        .register(Arc::new(EchoProvider::default()))
        .unwrap();
    let dispatcher = RpcDispatcher::new(AppState::with_auth(
        engine,
        "test-token",
        Default::default(),
    ));
    (root, dispatcher)
}

async fn rpc(dispatcher: &RpcDispatcher, method: &str, params: Value) -> Value {
    let response = dispatcher
        .handle(RpcRequest {
            jsonrpc: "2.0".into(),
            id: Some(json!(1)),
            method: method.into(),
            params,
        })
        .await
        .unwrap();
    if let Some(error) = response.error {
        panic!("RPC {method} failed: {} {:?}", error.message, error.data);
    }
    response.result.unwrap()
}

#[tokio::test]
async fn provider_profiles_are_structured_and_model_selection_is_explicit() {
    let (_root, dispatcher) = fixture().await;

    let descriptor = rpc(
        &dispatcher,
        "provider/configure",
        json!({
            "id": "local-test",
            "display_name": "Local test models",
            "kind": "openai-compatible",
            "base_url": "http://127.0.0.1:9/v1",
            "api_key": "must-not-appear",
            "default_model": "default-model",
            "custom_models": ["other-model", "default-model"]
        }),
    )
    .await;
    assert_eq!(descriptor["id"], "local-test");
    assert_eq!(descriptor["display_name"], "Local test models");
    assert_eq!(descriptor["auth"], "configured");
    assert!(!descriptor.to_string().contains("must-not-appear"));

    let models = rpc(
        &dispatcher,
        "provider/models",
        json!({ "provider_id": "local-test" }),
    )
    .await;
    assert_eq!(models["models"].as_array().unwrap().len(), 2);
    assert!(models["models"]
        .as_array()
        .unwrap()
        .iter()
        .any(|model| model["id"] == "default-model" && model["is_default"] == true));

    let catalog = rpc(&dispatcher, "provider/list", json!({})).await;
    let providers = catalog["providers"].as_array().unwrap();
    assert!(providers.iter().any(|provider| provider["id"] == "codex"));
    assert!(providers.iter().any(|provider| provider["id"] == "echo"));
    assert!(providers
        .iter()
        .any(|provider| provider["id"] == "local-test"));
    assert!(!catalog.to_string().contains("must-not-appear"));

    let removed = rpc(
        &dispatcher,
        "provider/remove",
        json!({ "provider_id": "local-test" }),
    )
    .await;
    assert_eq!(removed["removed"], true);
}

#[tokio::test]
async fn provider_configuration_cannot_replace_builtins() {
    let (_root, dispatcher) = fixture().await;
    let response = dispatcher
        .handle(RpcRequest {
            jsonrpc: "2.0".into(),
            id: Some(json!(2)),
            method: "provider/configure".into(),
            params: json!({
                "id": "codex",
                "display_name": "Imposter",
                "kind": "openai-compatible",
                "base_url": "http://127.0.0.1:9/v1",
                "default_model": "fake",
                "custom_models": []
            }),
        })
        .await
        .unwrap();
    assert_eq!(response.error.unwrap().code, -32009);
}
