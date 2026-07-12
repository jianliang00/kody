//! JSON-RPC 2.0 app server and WebSocket event transport.

pub mod rpc;
pub mod server;

pub use rpc::{RpcDispatcher, RpcError, RpcRequest, RpcResponse};
pub use server::{app, AppState, TurnManager};
