use std::{os::unix::fs::PermissionsExt, path::PathBuf, time::Duration};

use serde_json::json;
use tempfile::TempDir;

use crate::codex::{
    BinarySource, CancelLoginStatus, CodexClient, CodexClientOptions, CodexDiscoveryOptions,
    CodexError, CodexNotification, ModelListParams, RpcId, ThreadResumeParams, ThreadStartParams,
    TurnInterruptParams, TurnStartParams,
};

const FAKE_CODEX: &str = r###"#!/usr/bin/env python3
import json
import sys
import time

MODE = "__MODE__"
VERSION = "__VERSION__"

if "--version" in sys.argv:
    if MODE == "bad-version":
        print("not-the-program 1.0")
        sys.exit(0)
    print("codex-cli " + VERSION)
    sys.exit(0)

if MODE == "config-fail":
    sys.stderr.write("config error access_token=never-print-this\n")
    sys.stderr.flush()
    sys.exit(22)

def send(value):
    sys.stdout.write(json.dumps(value, separators=(",", ":")) + "\n")
    sys.stdout.flush()

for raw in sys.stdin:
    message = json.loads(raw)
    if "jsonrpc" in message:
        sys.stderr.write("protocol included forbidden jsonrpc field\n")
        sys.stderr.flush()
        sys.exit(90)
    method = message.get("method")
    request_id = message.get("id")

    if method == "initialized":
        continue
    if method == "initialize":
        send({"id": request_id, "result": {
            "userAgent": "fake-codex/9.9.9",
            "platformFamily": "unix",
            "platformOs": "macos",
            "codexHome": "/tmp/fake-codex"
        }})
    elif method == "account/read":
        if MODE == "account-fail":
            send({"id": request_id, "error": {"code": -32601, "message": "method unavailable"}})
        else:
            send({"id": request_id, "result": {
                "account": {"type": "chatgpt", "email": "dev@example.test", "planType": "plus", "accessToken": "must-not-escape"},
                "requiresOpenaiAuth": True
            }})
    elif method == "account/rateLimits/read":
        send({"id": request_id, "result": {
            "rateLimits": {"limitId": "codex", "planType": "plus", "primary": {"usedPercent": 17}},
            "rateLimitsByLimitId": {"codex": {"limitId": "codex", "primary": {"usedPercent": 17}}}
        }})
    elif method == "model/list":
        cursor = message.get("params", {}).get("cursor")
        suffix = "2" if cursor else "1"
        model = {
            "id": "model-" + suffix,
            "model": "gpt-test-" + suffix,
            "displayName": "Test " + suffix,
            "description": "fake model",
            "hidden": False,
            "isDefault": cursor is None,
            "defaultReasoningEffort": "medium",
            "supportedReasoningEfforts": [{"reasoningEffort": "medium", "description": "Balanced"}]
        }
        send({"id": request_id, "result": {"data": [model], "nextCursor": "page-2" if cursor is None else None}})
    elif method == "thread/start":
        send({"id": request_id, "result": {
            "thread": {"id": "codex-thread-1", "preview": "", "turns": []},
            "cwd": message.get("params", {}).get("cwd", "/tmp"),
            "model": "gpt-test-1",
            "modelProvider": "openai",
            "approvalPolicy": "on-request",
            "approvalsReviewer": "user",
            "sandbox": {"type": "workspaceWrite"}
        }})
    elif method == "thread/resume":
        send({"id": request_id, "result": {
            "thread": {"id": message["params"]["threadId"], "preview": "resumed", "turns": []},
            "cwd": "/tmp",
            "model": "gpt-test-1",
            "modelProvider": "openai",
            "approvalPolicy": "on-request",
            "approvalsReviewer": "user",
            "sandbox": {"type": "workspaceWrite"}
        }})
    elif method == "turn/start":
        send({"id": request_id, "result": {"turn": {"id": "codex-turn-1", "status": "inProgress", "items": []}}})
    elif method == "turn/interrupt":
        send({"id": request_id, "result": {}})
    elif method == "account/login/start":
        kind = message["params"]["type"]
        if kind == "chatgpt":
            send({"id": request_id, "result": {"type": "chatgpt", "loginId": "login-browser", "authUrl": "https://example.test/login", "accessToken": "must-not-escape"}})
        else:
            send({"id": request_id, "result": {"type": "chatgptDeviceCode", "loginId": "login-device", "userCode": "ABCD-EFGH", "verificationUrl": "https://example.test/device", "refreshToken": "must-not-escape"}})
    elif method == "account/login/cancel":
        send({"id": request_id, "result": {"status": "canceled"}})
    elif method == "account/logout":
        send({"id": request_id, "result": {}})
    elif method == "test/emit":
        send({"method": "account/login/completed", "params": {"loginId": "login-browser", "success": False, "error": "access_token=notification-secret"}})
        send({"method": "account/updated", "params": {"authMode": "chatgpt", "planType": "plus"}})
        send({"id": "approval-1", "method": "item/commandExecution/requestApproval", "params": {"threadId": "codex-thread-1"}})
        send({"id": request_id, "result": {}})
    elif method == "test/timeout" or method == "test/cancel":
        time.sleep(2)
        send({"id": request_id, "result": {"late": True}})
    elif method == "test/crash":
        sys.stderr.write("Authorization: Bearer bearer-secret access_token=token-secret sk-abcdefghijklmno\n")
        sys.stderr.flush()
        sys.exit(17)
    elif method == "test/huge":
        send({"id": request_id, "result": {"text": "x" * 8192}})
    elif request_id == "approval-1" and ("result" in message or "error" in message):
        send({"method": "test/serverRequestAnswered", "params": {"ok": True}})
    elif request_id is not None:
        send({"id": request_id, "error": {"code": -32601, "message": "unknown method"}})
"###;

struct Fixture {
    _directory: TempDir,
    client: CodexClient,
}

async fn fixture(mode: &str, customize: impl FnOnce(&mut CodexClientOptions)) -> Fixture {
    let directory = tempfile::tempdir().unwrap();
    let executable = write_fake(&directory, "codex", mode);
    let mut options = options_for(executable);
    customize(&mut options);
    let client = CodexClient::discover_and_spawn(options).await.unwrap();
    Fixture {
        _directory: directory,
        client,
    }
}

fn options_for(executable: PathBuf) -> CodexClientOptions {
    CodexClientOptions {
        discovery: CodexDiscoveryOptions {
            explicit_path: Some(executable),
            path: Some(Default::default()),
            bundle_paths: Vec::new(),
            probe_timeout: Duration::from_secs(10),
        },
        startup_timeout: Duration::from_secs(2),
        request_timeout: Duration::from_secs(2),
        shutdown_timeout: Duration::from_millis(300),
        ..Default::default()
    }
}

fn write_fake(directory: &TempDir, name: &str, mode: &str) -> PathBuf {
    write_fake_version(directory, name, "9.9.9-test", mode)
}

fn write_fake_version(directory: &TempDir, name: &str, version: &str, mode: &str) -> PathBuf {
    let path = directory.path().join(name);
    let staging_path = directory.path().join(format!(".{name}.staging"));
    let script = FAKE_CODEX
        .replace("__MODE__", mode)
        .replace("__VERSION__", version);
    std::fs::write(&staging_path, script).unwrap();
    let mut permissions = std::fs::metadata(&staging_path).unwrap().permissions();
    permissions.set_mode(0o700);
    std::fs::set_permissions(&staging_path, permissions).unwrap();
    std::fs::rename(staging_path, &path).unwrap();
    path
}

#[test]
fn serializes_kody_owned_ephemeral_threads_and_user_review() {
    let started = serde_json::to_value(ThreadStartParams {
        ephemeral: Some(true),
        approval_policy: Some("on-request".into()),
        approvals_reviewer: Some("user".into()),
        ..Default::default()
    })
    .unwrap();
    assert_eq!(started["ephemeral"], true);
    assert_eq!(started["approvalPolicy"], "on-request");
    assert_eq!(started["approvalsReviewer"], "user");

    let mut resumed = ThreadResumeParams::new("codex-thread-1");
    resumed.approval_policy = Some("on-request".into());
    resumed.approvals_reviewer = Some("user".into());
    let resumed = serde_json::to_value(resumed).unwrap();
    assert_eq!(resumed["approvalPolicy"], "on-request");
    assert_eq!(resumed["approvalsReviewer"], "user");

    let mut turn = TurnStartParams::text("codex-thread-1", "hello");
    turn.approval_policy = Some("on-request".into());
    turn.approvals_reviewer = Some("user".into());
    let turn = serde_json::to_value(turn).unwrap();
    assert_eq!(turn["approvalPolicy"], "on-request");
    assert_eq!(turn["approvalsReviewer"], "user");
}

#[tokio::test]
async fn supports_protocol_lifecycle_models_threads_turns_and_safe_auth() {
    let fixture = fixture("normal", |_| {}).await;
    let client = &fixture.client;
    assert_eq!(client.binary().source(), BinarySource::KodyCodexPath);
    assert!(client.binary().version().contains("9.9.9"));
    assert_eq!(client.initialize_info().platform_os, "macos");

    let account = client.account_read().await.unwrap();
    let account = account.account.unwrap();
    assert_eq!(account.account_type, "chatgpt");
    assert_eq!(account.plan_type.as_deref(), Some("plus"));
    assert!(!format!("{account:?}").contains("must-not-escape"));

    let limits = client.rate_limits_read().await.unwrap();
    assert_eq!(
        limits.rate_limits.primary.as_ref().unwrap().used_percent,
        17
    );
    let page = client
        .models_page(ModelListParams::default())
        .await
        .unwrap();
    assert_eq!(page.next_cursor.as_deref(), Some("page-2"));
    let models = client.models_all(false).await.unwrap();
    assert_eq!(models.len(), 2);

    let started = client
        .thread_start(ThreadStartParams {
            cwd: Some(PathBuf::from("/tmp")),
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(started.thread.id, "codex-thread-1");
    let resumed = client
        .thread_resume(ThreadResumeParams::new("codex-thread-1"))
        .await
        .unwrap();
    assert_eq!(resumed.thread.preview, "resumed");
    let turn = client
        .turn_start(TurnStartParams::text("codex-thread-1", "hello"))
        .await
        .unwrap();
    assert_eq!(turn.turn.id, "codex-turn-1");
    client
        .turn_interrupt(TurnInterruptParams {
            thread_id: "codex-thread-1".into(),
            turn_id: turn.turn.id,
        })
        .await
        .unwrap();

    let browser = client.login_chatgpt().await.unwrap();
    assert_eq!(browser.login_id, "login-browser");
    assert_eq!(browser.auth_url, "https://example.test/login");
    assert!(!format!("{browser:?}").contains("must-not-escape"));
    let device = client.login_device_code().await.unwrap();
    assert_eq!(device.user_code, "ABCD-EFGH");
    assert!(!format!("{device:?}").contains("must-not-escape"));
    assert_eq!(
        client.cancel_login("login-device").await.unwrap().status,
        CancelLoginStatus::Canceled
    );
    client.logout().await.unwrap();
    client.shutdown().await.unwrap();
    assert!(!client.is_running());
}

#[tokio::test]
async fn publishes_typed_auth_notifications_and_server_requests() {
    let fixture = fixture("normal", |_| {}).await;
    let client = &fixture.client;
    let mut notifications = client.subscribe_notifications();
    let mut requests = client.subscribe_server_requests();

    client.request_raw("test/emit", json!({})).await.unwrap();
    match notifications.recv().await.unwrap() {
        CodexNotification::AccountLoginCompleted(completed) => {
            assert!(!completed.success);
            let error = completed.error.unwrap();
            assert!(!error.contains("notification-secret"));
            assert!(error.contains("<redacted>"));
        }
        other => panic!("unexpected notification: {other:?}"),
    }
    match notifications.recv().await.unwrap() {
        CodexNotification::AccountUpdated(updated) => {
            assert_eq!(updated.auth_mode.as_deref(), Some("chatgpt"));
            assert_eq!(updated.plan_type.as_deref(), Some("plus"));
        }
        other => panic!("unexpected notification: {other:?}"),
    }
    let request = requests.recv().await.unwrap();
    assert_eq!(request.id, RpcId::String("approval-1".into()));
    assert_eq!(request.method, "item/commandExecution/requestApproval");
    client
        .respond_server_request(request.id, json!({ "decision": "decline" }))
        .await
        .unwrap();
    match notifications.recv().await.unwrap() {
        CodexNotification::Other { method, .. } => {
            assert_eq!(method, "test/serverRequestAnswered")
        }
        other => panic!("unexpected notification: {other:?}"),
    }
    client.shutdown().await.unwrap();
}

#[tokio::test]
async fn interactive_server_requests_do_not_expire_while_waiting_for_the_user() {
    let fixture = fixture("normal", |options| {
        options.request_timeout = Duration::from_millis(100);
    })
    .await;
    let client = &fixture.client;
    let mut requests = client.subscribe_server_requests();

    client.request_raw("test/emit", json!({})).await.unwrap();
    let request = requests.recv().await.unwrap();
    tokio::time::sleep(Duration::from_millis(250)).await;
    client
        .respond_server_request(request.id, json!({ "decision": "accept" }))
        .await
        .unwrap();
    client.shutdown().await.unwrap();
}

#[tokio::test]
async fn times_out_and_removes_dropped_request_futures() {
    let timed_out_fixture = fixture("normal", |options| {
        options.request_timeout = Duration::from_millis(100);
    })
    .await;
    let error = timed_out_fixture
        .client
        .request_raw("test/timeout", json!({}))
        .await
        .unwrap_err();
    assert!(matches!(error, CodexError::Timeout { .. }));
    assert_eq!(timed_out_fixture.client.pending_request_count(), 0);
    timed_out_fixture.client.shutdown().await.unwrap();

    let fixture = fixture("normal", |_| {}).await;
    let client = fixture.client.clone();
    let task = tokio::spawn(async move { client.request_raw("test/cancel", json!({})).await });
    tokio::time::sleep(Duration::from_millis(50)).await;
    task.abort();
    let _ = task.await;
    tokio::task::yield_now().await;
    assert_eq!(fixture.client.pending_request_count(), 0);
    fixture.client.shutdown().await.unwrap();
}

#[tokio::test]
async fn reports_crashes_without_leaking_stderr_secrets() {
    let fixture = fixture("normal", |_| {}).await;
    let error = fixture
        .client
        .request_raw("test/crash", json!({}))
        .await
        .unwrap_err();
    tokio::time::sleep(Duration::from_millis(50)).await;
    let diagnostic = format!("{error} {}", fixture.client.stderr_tail());
    assert!(!diagnostic.contains("bearer-secret"));
    assert!(!diagnostic.contains("token-secret"));
    assert!(!diagnostic.contains("sk-abcdefghijklmno"));
    assert!(diagnostic.contains("<redacted>"));
}

#[tokio::test]
async fn rejects_oversized_jsonl_without_unbounded_buffering() {
    let fixture = fixture("normal", |options| options.max_line_bytes = 512).await;
    let outbound = fixture
        .client
        .request_raw("test/outbound", json!({ "text": "x".repeat(1024) }))
        .await
        .unwrap_err();
    assert!(format!("{outbound}").contains("512-byte limit"));
    assert_eq!(fixture.client.pending_request_count(), 0);

    let error = fixture
        .client
        .request_raw("test/huge", json!({}))
        .await
        .unwrap_err();
    assert!(format!("{error}").contains("512-byte limit"));
}

#[tokio::test]
async fn rejects_bad_config_or_account_capability_then_uses_bundle_fallback() {
    for mode in ["config-fail", "account-fail"] {
        let path_directory = tempfile::tempdir().unwrap();
        let bundle_directory = tempfile::tempdir().unwrap();
        let _bad = write_fake(&path_directory, "codex", mode);
        let good = write_fake(&bundle_directory, "bundled-codex", "normal");
        let options = CodexClientOptions {
            discovery: CodexDiscoveryOptions {
                explicit_path: None,
                path: Some(path_directory.path().as_os_str().to_owned()),
                bundle_paths: vec![good],
                probe_timeout: Duration::from_secs(10),
            },
            startup_timeout: Duration::from_secs(1),
            shutdown_timeout: Duration::from_millis(200),
            ..Default::default()
        };
        let client = CodexClient::discover_and_spawn(options).await.unwrap();
        assert_eq!(client.binary().source(), BinarySource::ChatGptBundle);
        client.shutdown().await.unwrap();
    }
}

#[tokio::test]
async fn prefers_the_newest_semver_across_path_and_bundle_candidates() {
    let path_directory = tempfile::tempdir().unwrap();
    let bundle_directory = tempfile::tempdir().unwrap();
    let _old = write_fake_version(&path_directory, "codex", "0.128.0", "normal");
    let new = write_fake_version(&bundle_directory, "bundled-codex", "0.144.0", "normal");
    let options = implicit_options(&path_directory, vec![new]);

    let client = CodexClient::discover_and_spawn(options).await.unwrap();

    assert_eq!(client.binary().source(), BinarySource::ChatGptBundle);
    assert!(client.binary().version().contains("0.144.0"));
    client.shutdown().await.unwrap();
}

#[tokio::test]
async fn falls_back_to_an_older_version_when_the_newest_is_incompatible() {
    let path_directory = tempfile::tempdir().unwrap();
    let bundle_directory = tempfile::tempdir().unwrap();
    let _old = write_fake_version(&path_directory, "codex", "0.128.0", "normal");
    let new = write_fake_version(
        &bundle_directory,
        "bundled-codex",
        "0.144.0",
        "account-fail",
    );
    let options = implicit_options(&path_directory, vec![new]);

    let client = CodexClient::discover_and_spawn(options).await.unwrap();

    assert_eq!(client.binary().source(), BinarySource::Path);
    assert!(client.binary().version().contains("0.128.0"));
    client.shutdown().await.unwrap();
}

#[tokio::test]
async fn tries_unparseable_versions_only_after_parseable_versions() {
    let path_directory = tempfile::tempdir().unwrap();
    let bundle_directory = tempfile::tempdir().unwrap();
    let _development = write_fake_version(&path_directory, "codex", "development-build", "normal");
    let released = write_fake_version(&bundle_directory, "bundled-codex", "0.144.0", "normal");
    let options = implicit_options(&path_directory, vec![released]);

    let client = CodexClient::discover_and_spawn(options).await.unwrap();

    assert_eq!(client.binary().source(), BinarySource::ChatGptBundle);
    client.shutdown().await.unwrap();
}

fn implicit_options(path_directory: &TempDir, bundle_paths: Vec<PathBuf>) -> CodexClientOptions {
    CodexClientOptions {
        discovery: CodexDiscoveryOptions {
            explicit_path: None,
            path: Some(path_directory.path().as_os_str().to_owned()),
            bundle_paths,
            probe_timeout: Duration::from_secs(10),
        },
        startup_timeout: Duration::from_secs(1),
        shutdown_timeout: Duration::from_millis(200),
        ..Default::default()
    }
}

#[tokio::test]
async fn explicit_unusable_binary_is_authoritative_and_does_not_fallback() {
    let bad_directory = tempfile::tempdir().unwrap();
    let bundle_directory = tempfile::tempdir().unwrap();
    let bad = write_fake(&bad_directory, "bad-codex", "bad-version");
    let good = write_fake(&bundle_directory, "bundled-codex", "normal");
    let mut options = options_for(bad);
    options.discovery.bundle_paths = vec![good];
    let error = match CodexClient::discover_and_spawn(options).await {
        Ok(_) => panic!("an explicit invalid binary must not fall back"),
        Err(error) => error,
    };
    assert!(matches!(error, CodexError::NoUsableBinary { .. }));
}

#[tokio::test]
#[ignore = "requires a locally installed and authenticated Codex"]
async fn manual_real_codex_compatibility_probe() {
    let client = CodexClient::discover_and_spawn(CodexClientOptions::default())
        .await
        .unwrap();
    let account = client.account_read().await.unwrap();
    assert!(account.account.is_some() || account.requires_openai_auth);
    let page = client
        .models_page(ModelListParams::default())
        .await
        .unwrap();
    assert!(!page.data.is_empty());
    client.shutdown().await.unwrap();
}
