//! Safe, process-owned client for the Codex app-server stdio protocol.
//!
//! This module deliberately treats Codex as an agent runtime sidecar rather
//! than as a model provider. Authentication is performed exclusively through
//! app-server RPC methods; Cody never reads Codex credential files.

mod client;
mod discovery;
mod error;
mod redaction;
mod types;

#[cfg(all(test, unix))]
mod tests;

pub use client::{CodexClient, CodexClientOptions};
pub use discovery::{BinarySource, CodexBinary, CodexDiscoveryOptions};
pub use error::{CodexError, Result};
pub use types::{
    AccountLoginCompleted, AccountReadResponse, AccountSummary, AccountUpdated,
    CancelLoginResponse, CancelLoginStatus, ChatGptLogin, CodexNotification, CodexServerRequest,
    CodexThread, CodexTurn, DeviceCodeLogin, InitializeResponse, ModelInfo, ModelListPage,
    ModelListParams, RateLimitSnapshot, RateLimitsResponse, ReasoningEffortOption, RpcErrorPayload,
    RpcId, ThreadResumeParams, ThreadResumeResponse, ThreadStartParams, ThreadStartResponse,
    TurnInterruptParams, TurnStartParams, TurnStartResponse, UserInput,
};
