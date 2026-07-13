use std::{collections::BTreeMap, collections::HashSet, sync::Arc, time::Duration};

use anyhow::{bail, Context, Result};
use cody_app_server::{app, AppState};
use cody_core::{
    process::StartProcessRequest, provider::EchoProvider, CodyEngine, EngineConfig, ProcessOrigin,
    StartTurn,
};
use futures_util::{SinkExt, StreamExt};
use reqwest::{header, StatusCode};
use serde_json::{json, Value};
use tempfile::TempDir;
use tokio::{net::TcpStream, task::JoinHandle, time::timeout};
use tokio_tungstenite::{
    connect_async,
    tungstenite::{
        client::IntoClientRequest,
        http::{HeaderValue, StatusCode as WsStatusCode},
        Error as WsError, Message,
    },
    MaybeTlsStream, WebSocketStream,
};
use tokio_util::sync::CancellationToken;

const TOKEN: &str = "integration-test-token";
const ALLOWED_ORIGIN: &str = "https://allowed.example";

type TestSocket = WebSocketStream<MaybeTlsStream<TcpStream>>;

struct TestServer {
    http_base: String,
    ws_url: String,
    engine: Arc<CodyEngine>,
    task: JoinHandle<()>,
    _state_root: TempDir,
}

impl TestServer {
    async fn start() -> Result<Self> {
        let state_root = tempfile::tempdir()?;
        let config = EngineConfig {
            state_root: state_root.path().join("state"),
            ..EngineConfig::default()
        };
        let engine = Arc::new(CodyEngine::new(config).await?);
        engine
            .providers()
            .register(Arc::new(EchoProvider::default()))?;

        let state = AppState::with_auth(
            engine.clone(),
            TOKEN,
            HashSet::from([ALLOWED_ORIGIN.to_owned()]),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let address = listener.local_addr()?;
        let task = tokio::spawn(async move {
            axum::serve(listener, app(state))
                .await
                .expect("test app server failed");
        });

        Ok(Self {
            http_base: format!("http://{address}"),
            ws_url: format!("ws://{address}/v1/ws"),
            engine,
            task,
            _state_root: state_root,
        })
    }

    fn rpc_url(&self) -> String {
        format!("{}/v1/rpc", self.http_base)
    }
}

impl Drop for TestServer {
    fn drop(&mut self) {
        self.task.abort();
    }
}

#[tokio::test]
async fn http_rpc_requires_authentication_and_json_content_type() -> Result<()> {
    let server = TestServer::start().await?;
    let client = reqwest::Client::builder().no_proxy().build()?;
    let initialize = json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {}
    });

    let unauthorized = client
        .post(server.rpc_url())
        .header(header::CONTENT_TYPE, "application/json")
        .body(initialize.to_string())
        .send()
        .await?;
    assert_eq!(unauthorized.status(), StatusCode::UNAUTHORIZED);
    assert_json_content_type(&unauthorized);
    assert_eq!(
        unauthorized.json::<Value>().await?["error"],
        "missing or invalid bearer token"
    );

    let wrong_token = client
        .post(server.rpc_url())
        .bearer_auth("wrong-token")
        .json(&initialize)
        .send()
        .await?;
    assert_eq!(wrong_token.status(), StatusCode::UNAUTHORIZED);

    let missing_content_type = client
        .post(server.rpc_url())
        .bearer_auth(TOKEN)
        .body(initialize.to_string())
        .send()
        .await?;
    assert_eq!(
        missing_content_type.status(),
        StatusCode::UNSUPPORTED_MEDIA_TYPE
    );
    assert_json_content_type(&missing_content_type);

    let initialized = client
        .post(server.rpc_url())
        .bearer_auth(TOKEN)
        .header(header::CONTENT_TYPE, "Application/JSON; Charset=UTF-8")
        .body(initialize.to_string())
        .send()
        .await?;
    assert_eq!(initialized.status(), StatusCode::OK);
    assert_json_content_type(&initialized);
    let initialized = initialized.json::<Value>().await?;
    assert_eq!(initialized["jsonrpc"], "2.0");
    assert_eq!(initialized["id"], 1);
    assert_eq!(
        initialized["result"]["server_info"]["name"],
        "cody-app-server"
    );

    Ok(())
}

#[tokio::test]
async fn websocket_rejects_a_disallowed_origin() -> Result<()> {
    let server = TestServer::start().await?;
    let mut request = format!("{}?token={TOKEN}", server.ws_url).into_client_request()?;
    request.headers_mut().insert(
        "Origin",
        HeaderValue::from_static("https://untrusted.example"),
    );

    let error = match connect_async(request).await {
        Ok(_) => bail!("websocket handshake unexpectedly accepted a disallowed origin"),
        Err(error) => error,
    };
    match error {
        WsError::Http(response) => {
            assert_eq!(response.status(), WsStatusCode::FORBIDDEN);
            assert_eq!(
                response
                    .headers()
                    .get("content-type")
                    .and_then(|value| value.to_str().ok()),
                Some("application/json")
            );
        }
        other => bail!("expected an HTTP handshake rejection, got {other}"),
    }

    Ok(())
}

#[tokio::test]
async fn create_and_start_rolls_back_when_turn_preparation_fails() -> Result<()> {
    let server = TestServer::start().await?;
    let project_root = tempfile::tempdir()?;
    let client = reqwest::Client::builder().no_proxy().build()?;
    let failed = client
        .post(server.rpc_url())
        .bearer_auth(TOKEN)
        .json(&json!({
            "jsonrpc": "2.0",
            "id": "create-failure",
            "method": "thread/create-and-start",
            "params": {
                "client_request_id": "rollback-request",
                "message": "this must not leave an empty thread",
                "provider": "missing-provider",
                "working_directory": project_root.path(),
            }
        }))
        .send()
        .await?
        .json::<Value>()
        .await?;
    assert_eq!(failed["error"]["code"], -32004);

    for (method, collection) in [("thread/list", "threads"), ("project/list", "projects")] {
        let listed = client
            .post(server.rpc_url())
            .bearer_auth(TOKEN)
            .json(&json!({
                "jsonrpc": "2.0",
                "id": method,
                "method": method,
                "params": {}
            }))
            .send()
            .await?
            .json::<Value>()
            .await?;
        assert_eq!(
            listed["result"][collection].as_array().map(Vec::len),
            Some(0)
        );
    }

    let workspace_root = server._state_root.path().join("state/workspaces");
    let mut entries = tokio::fs::read_dir(workspace_root).await?;
    assert!(entries.next_entry().await?.is_none());
    Ok(())
}

#[tokio::test]
async fn websocket_create_and_start_is_idempotent_and_streams_from_the_first_event() -> Result<()> {
    let server = TestServer::start().await?;
    let mut request = server.ws_url.clone().into_client_request()?;
    request.headers_mut().insert(
        "Authorization",
        HeaderValue::from_str(&format!("Bearer {TOKEN}"))?,
    );
    let (mut socket, _) = connect_async(request).await?;
    let create = |id: &str| {
        json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": "thread/create-and-start",
            "params": {
                "client_request_id": "stable-draft-request",
                "message": "Explain the provider neutral agent loop",
                "references": [],
                "provider": "echo"
            }
        })
    };
    send_json(&mut socket, create("create-first")).await?;

    // create-and-start subscribes atomically, but the acknowledgement frame is
    // always sent before execution begins and any event can be observed.
    let created = receive_json(&mut socket).await?;
    assert_eq!(created["id"], "create-first");
    let thread_id = created["result"]["thread"]["id"]
        .as_str()
        .context("create-and-start returned no Thread")?
        .to_owned();
    let turn_id = created["result"]["turn"]["id"]
        .as_str()
        .context("create-and-start returned no Turn")?
        .to_owned();
    let mut event_types = Vec::new();
    let mut last_sequence = 0_u64;
    for _ in 0..48 {
        let message = receive_json(&mut socket).await?;
        if message["method"] != "turn/event" {
            continue;
        }
        let sequence = message["params"]["sequence"]
            .as_u64()
            .context("turn/event had no sequence")?;
        assert!(sequence > last_sequence);
        last_sequence = sequence;
        if let Some(event_type) = message["params"]["event"]["type"].as_str() {
            event_types.push(event_type.to_owned());
        }
        if event_types.iter().any(|event| event == "thread_updated") {
            break;
        }
    }
    assert_eq!(
        event_types.first().map(String::as_str),
        Some("turn_started")
    );
    assert!(event_types.iter().any(|event| event == "turn_completed"));
    assert!(event_types.iter().any(|event| event == "thread_updated"));

    send_json(&mut socket, create("create-retry")).await?;
    let retried = receive_json(&mut socket).await?;
    assert_eq!(retried["id"], "create-retry");
    assert_eq!(retried["result"]["thread"]["id"], thread_id);
    assert_eq!(retried["result"]["turn"]["id"], turn_id);
    assert_eq!(retried["result"]["thread"]["status"], "idle");
    assert_eq!(
        retried["result"]["thread"]["title"],
        "Explain the provider neutral agent loop"
    );
    assert_eq!(retried["result"]["turn"]["status"], "completed");

    send_json(
        &mut socket,
        json!({
            "jsonrpc": "2.0",
            "id": "create-conflicting-retry",
            "method": "thread/create-and-start",
            "params": {
                "client_request_id": "stable-draft-request",
                "message": "A different draft must not reuse the cached entities",
                "references": [],
                "provider": "echo"
            }
        }),
    )
    .await?;
    let conflict = receive_json(&mut socket).await?;
    assert_eq!(conflict["id"], "create-conflicting-retry");
    assert_eq!(conflict["error"]["code"], -32009);

    send_json(
        &mut socket,
        json!({
            "jsonrpc": "2.0",
            "id": "list-after-retry",
            "method": "thread/list",
            "params": {}
        }),
    )
    .await?;
    let listed = receive_json(&mut socket).await?;
    assert_eq!(
        listed["result"]["threads"].as_array().map(Vec::len),
        Some(1)
    );
    socket.close(None).await?;
    Ok(())
}

#[tokio::test]
async fn authorized_websocket_runs_echo_turn_and_streams_subscribed_events() -> Result<()> {
    let server = TestServer::start().await?;
    let mut request = server.ws_url.clone().into_client_request()?;
    request.headers_mut().insert(
        "Authorization",
        HeaderValue::from_str(&format!("Bearer {TOKEN}"))?,
    );
    let (mut socket, response) = connect_async(request).await?;
    assert_eq!(response.status(), WsStatusCode::SWITCHING_PROTOCOLS);

    send_json(
        &mut socket,
        json!({
            "jsonrpc": "2.0",
            "id": "initialize",
            "method": "initialize",
            "params": {}
        }),
    )
    .await?;
    let initialized = receive_json(&mut socket).await?;
    assert_eq!(initialized["id"], "initialize");
    assert_eq!(
        initialized["result"]["capabilities"]["event_notification"],
        "turn/event"
    );

    send_json(
        &mut socket,
        json!({
            "jsonrpc": "2.0",
            "id": "create-thread",
            "method": "thread/create",
            "params": {}
        }),
    )
    .await?;
    let created = receive_json(&mut socket).await?;
    assert_eq!(created["id"], "create-thread");
    let thread_id = created["result"]["thread"]["id"]
        .as_str()
        .context("thread/create response did not contain a thread id")?
        .to_owned();
    assert_eq!(created["result"]["thread"]["title"], "New thread");

    send_json(
        &mut socket,
        json!({
            "jsonrpc": "2.0",
            "id": "start-turn",
            "method": "turn/start",
            "params": {
                "thread_id": thread_id,
                "message": "echo across the network",
                "provider": "echo"
            }
        }),
    )
    .await?;

    let mut turn_id = None;
    let mut saw_output_delta = false;
    let mut saw_completed = false;
    for _ in 0..32 {
        let message = receive_json(&mut socket).await?;
        if message["id"] == "start-turn" {
            assert_eq!(message["result"]["status"], "queued");
            turn_id = message["result"]["id"].as_str().map(str::to_owned);
            continue;
        }
        if message["method"] != "turn/event" {
            continue;
        }

        assert_eq!(message["params"]["thread_id"], thread_id);
        if let Some(turn_id) = &turn_id {
            assert_eq!(message["params"]["turn_id"], turn_id.as_str());
        }
        match message["params"]["event"]["type"].as_str() {
            Some("model_output_delta") => {
                assert_eq!(
                    message["params"]["event"]["delta"],
                    "echo across the network"
                );
                saw_output_delta = true;
            }
            Some("turn_completed") => {
                assert_eq!(
                    message["params"]["event"]["final_text"],
                    "echo across the network"
                );
                saw_completed = true;
            }
            _ => {}
        }
        if turn_id.is_some() && saw_completed {
            break;
        }
    }

    let turn_id = turn_id.context("turn/start response was not received")?;
    assert!(saw_output_delta, "model output delta was not streamed");
    assert!(saw_completed, "turn completion event was not streamed");

    // Confirm the streamed terminal event agrees with the durable turn state.
    send_json(
        &mut socket,
        json!({
            "jsonrpc": "2.0",
            "id": "get-turn",
            "method": "turn/get",
            "params": { "turn_id": turn_id }
        }),
    )
    .await?;
    let turn = receive_json(&mut socket).await?;
    assert_eq!(turn["id"], "get-turn");
    assert_eq!(turn["result"]["status"], "completed");

    // Title enrichment is intentionally outside the terminal turn path, so
    // poll the durable Thread snapshot rather than delaying turn completion.
    let generated_title = timeout(Duration::from_secs(2), async {
        loop {
            send_json(
                &mut socket,
                json!({
                    "jsonrpc": "2.0",
                    "id": "get-thread-title",
                    "method": "thread/get",
                    "params": { "thread_id": thread_id }
                }),
            )
            .await?;
            let snapshot = loop {
                let message = receive_json(&mut socket).await?;
                if message["id"] == "get-thread-title" {
                    break message;
                }
            };
            let title = snapshot["result"]["thread"]["title"]
                .as_str()
                .context("thread/get response did not contain a title")?;
            if title != "New thread" {
                break Ok::<_, anyhow::Error>(title.to_owned());
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .context("timed out waiting for the generated thread title")??;
    assert_eq!(generated_title, "echo across the network");

    socket.close(None).await?;
    Ok(())
}

#[tokio::test]
async fn websocket_exposes_managed_process_events_output_and_stop() -> Result<()> {
    let server = TestServer::start().await?;
    let (thread, workspace, _) = server
        .engine
        .create_thread("Process network test", None)
        .await?;
    let turn = server
        .engine
        .runtime()
        .prepare_turn(StartTurn {
            thread_id: thread.id,
            message: "prepare a durable process origin".into(),
            references: Vec::new(),
            provider: "echo".into(),
            model: None,
            temperature: None,
            max_output_tokens: None,
        })
        .await?;
    server
        .engine
        .runtime()
        .execute_turn(turn.id, CancellationToken::new())
        .await?;

    let mut request = server.ws_url.clone().into_client_request()?;
    request.headers_mut().insert(
        "Authorization",
        HeaderValue::from_str(&format!("Bearer {TOKEN}"))?,
    );
    let (mut socket, _) = connect_async(request).await?;
    send_json(
        &mut socket,
        json!({
            "jsonrpc": "2.0",
            "id": "subscribe-process-thread",
            "method": "thread/get",
            "params": { "thread_id": thread.id }
        }),
    )
    .await?;
    let subscribed = receive_response(&mut socket, "subscribe-process-thread").await?;
    assert_eq!(
        subscribed["result"]["processes"].as_array().map(Vec::len),
        Some(0)
    );

    let process = server
        .engine
        .processes()
        .start(StartProcessRequest {
            thread_id: thread.id,
            origin: ProcessOrigin {
                turn_id: turn.id,
                tool_call_id: "network-process".into(),
            },
            project_id: None,
            command: "printf 'ready\\n'; sleep 30".into(),
            cwd: workspace.root.clone(),
            environment: BTreeMap::from([
                ("HOME".into(), workspace.root.display().to_string()),
                ("PATH".into(), "/usr/bin:/bin".into()),
                ("PWD".into(), workspace.root.display().to_string()),
            ]),
        })
        .await?;

    let mut last_sequence = 0_u64;
    let mut saw_started = false;
    let mut saw_output = false;
    timeout(Duration::from_secs(5), async {
        while !saw_started || !saw_output {
            let message = receive_json(&mut socket).await?;
            if message["method"] != "process/event" {
                continue;
            }
            assert_eq!(message["params"]["thread_id"], thread.id.to_string());
            assert_eq!(message["params"]["process_id"], process.id.to_string());
            let sequence = message["params"]["sequence"]
                .as_u64()
                .context("process/event had no sequence")?;
            assert!(sequence > last_sequence);
            last_sequence = sequence;
            match message["params"]["event"]["type"].as_str() {
                Some("started") => saw_started = true,
                Some("output") => {
                    assert_eq!(message["params"]["event"]["cursor"], 0);
                    assert_eq!(message["params"]["event"]["next_cursor"], 6);
                    assert!(message["params"]["event"].get("bytes").is_none());
                    saw_output = true;
                }
                _ => {}
            }
        }
        Ok::<_, anyhow::Error>(())
    })
    .await
    .context("timed out waiting for process events")??;

    send_json(
        &mut socket,
        json!({
            "jsonrpc": "2.0",
            "id": "list-processes",
            "method": "process/list",
            "params": { "thread_id": thread.id }
        }),
    )
    .await?;
    let listed = receive_response(&mut socket, "list-processes").await?;
    assert_eq!(
        listed["result"]["processes"][0]["id"],
        process.id.to_string()
    );
    assert_eq!(listed["result"]["processes"][0]["status"], "running");

    send_json(
        &mut socket,
        json!({
            "jsonrpc": "2.0",
            "id": "read-process-output",
            "method": "process/read-output",
            "params": {
                "thread_id": thread.id,
                "process_id": process.id,
                "after_cursor": 0,
                "limit": 1024
            }
        }),
    )
    .await?;
    let output = receive_response(&mut socket, "read-process-output").await?;
    assert_eq!(output["result"]["chunks"][0]["text"], "ready\n");
    assert_eq!(output["result"]["has_more"], false);

    send_json(
        &mut socket,
        json!({
            "jsonrpc": "2.0",
            "id": "stop-process",
            "method": "process/stop",
            "params": { "thread_id": thread.id, "process_id": process.id }
        }),
    )
    .await?;
    let mut stop_response = None;
    let mut saw_stopping = false;
    let mut saw_stopped = false;
    timeout(Duration::from_secs(5), async {
        while stop_response.is_none() || !saw_stopping || !saw_stopped {
            let message = receive_json(&mut socket).await?;
            if message["id"] == "stop-process" {
                stop_response = Some(message);
                continue;
            }
            if message["method"] != "process/event"
                || message["params"]["process_id"] != process.id.to_string()
            {
                continue;
            }
            match message["params"]["event"]["type"].as_str() {
                Some("stopping") => saw_stopping = true,
                Some("stopped") => saw_stopped = true,
                _ => {}
            }
        }
        Ok::<_, anyhow::Error>(())
    })
    .await
    .context("timed out waiting for process stop")??;
    assert_eq!(stop_response.unwrap()["result"]["status"], "stopped");

    send_json(
        &mut socket,
        json!({
            "jsonrpc": "2.0",
            "id": "process-thread-snapshot",
            "method": "thread/get",
            "params": { "thread_id": thread.id }
        }),
    )
    .await?;
    let snapshot = receive_response(&mut socket, "process-thread-snapshot").await?;
    assert_eq!(snapshot["result"]["processes"][0]["status"], "stopped");

    socket.close(None).await?;
    Ok(())
}

fn assert_json_content_type(response: &reqwest::Response) {
    let content_type = response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    assert!(
        content_type
            .to_ascii_lowercase()
            .starts_with("application/json"),
        "expected a JSON response, got {content_type:?}"
    );
}

async fn send_json(socket: &mut TestSocket, value: Value) -> Result<()> {
    socket.send(Message::Text(value.to_string().into())).await?;
    Ok(())
}

async fn receive_json(socket: &mut TestSocket) -> Result<Value> {
    loop {
        let message = timeout(Duration::from_secs(5), socket.next())
            .await
            .context("timed out waiting for a websocket message")?
            .context("websocket closed before the expected message")??;
        match message {
            Message::Text(text) => return Ok(serde_json::from_str(text.as_str())?),
            Message::Binary(bytes) => return Ok(serde_json::from_slice(&bytes)?),
            Message::Ping(payload) => socket.send(Message::Pong(payload)).await?,
            Message::Pong(_) | Message::Frame(_) => {}
            Message::Close(frame) => bail!("websocket closed unexpectedly: {frame:?}"),
        }
    }
}

async fn receive_response(socket: &mut TestSocket, id: &str) -> Result<Value> {
    loop {
        let message = receive_json(socket).await?;
        if message["id"] == id {
            return Ok(message);
        }
    }
}
