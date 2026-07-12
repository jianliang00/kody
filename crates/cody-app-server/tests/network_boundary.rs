use std::{collections::HashSet, sync::Arc, time::Duration};

use anyhow::{bail, Context, Result};
use cody_app_server::{app, AppState};
use cody_core::{provider::EchoProvider, CodyEngine, EngineConfig};
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

const TOKEN: &str = "integration-test-token";
const ALLOWED_ORIGIN: &str = "https://allowed.example";

type TestSocket = WebSocketStream<MaybeTlsStream<TcpStream>>;

struct TestServer {
    http_base: String,
    ws_url: String,
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

        let state = AppState::with_auth(engine, TOKEN, HashSet::from([ALLOWED_ORIGIN.to_owned()]));
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
            "params": { "title": "Network integration" }
        }),
    )
    .await?;
    let created = receive_json(&mut socket).await?;
    assert_eq!(created["id"], "create-thread");
    let thread_id = created["result"]["thread"]["id"]
        .as_str()
        .context("thread/create response did not contain a thread id")?
        .to_owned();
    assert_eq!(created["result"]["thread"]["title"], "Network integration");

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
