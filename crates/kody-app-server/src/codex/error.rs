use std::{path::PathBuf, time::Duration};

use crate::codex::types::RpcErrorPayload;

pub type Result<T> = std::result::Result<T, CodexError>;

/// Failures from binary discovery, process supervision, or the app-server
/// protocol. Error strings contain only redacted stderr excerpts.
#[derive(Debug, thiserror::Error)]
pub enum CodexError {
    #[error("invalid Codex sidecar options: {0}")]
    InvalidOptions(String),

    #[error("no usable Codex binary was found: {attempts}")]
    NoUsableBinary { attempts: String },

    #[error("Codex binary probe failed for {path}: {reason}")]
    BinaryProbe { path: PathBuf, reason: String },

    #[error("failed to spawn Codex binary {path}: {source}")]
    Spawn {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },

    #[error("Codex I/O failed while {operation}: {source}")]
    Io {
        operation: &'static str,
        #[source]
        source: std::io::Error,
    },

    #[error("Codex protocol error: {0}")]
    Protocol(String),

    #[error("Codex {direction} line exceeded the {limit}-byte limit")]
    LineTooLong {
        direction: &'static str,
        limit: usize,
    },

    #[error("Codex RPC '{method}' timed out after {timeout:?}")]
    Timeout { method: String, timeout: Duration },

    #[error("Codex RPC '{method}' failed ({error})")]
    Rpc {
        method: String,
        error: RpcErrorPayload,
    },

    #[error("Codex sidecar is not running: {reason}")]
    Closed { reason: String },

    #[error("Codex request queue is closed")]
    QueueClosed,

    #[error("failed to encode/decode Codex protocol data: {0}")]
    Json(#[from] serde_json::Error),
}
