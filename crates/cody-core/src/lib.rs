//! Core domain, provider abstraction, tool runtime, and agent loop for Cody.

pub mod context;
pub mod domain;
pub mod engine;
pub mod error;
pub mod event;
pub mod provider;
pub mod runtime;
pub mod store;
pub mod title;
pub mod tools;

pub use context::{ContextBuilder, DefaultContextBuilder, ResolvedContext};
pub use domain::*;
pub use engine::{CodyEngine, EngineConfig};
pub use error::{CodyError, Result};
pub use event::{AgentEvent, EventEnvelope, EventHub};
pub use provider::{ModelProvider, ProviderRegistry};
pub use runtime::{AgentRuntime, AgentRuntimeConfig, ApprovalBroker, StartTurn};
pub use store::{InMemoryStore, JsonFileStore, StateStore};
pub use title::{
    FallbackThreadTitleGenerator, LocalThreadTitleGenerator, ThreadTitleGenerator,
    ThreadTitleRequest, DEFAULT_THREAD_TITLE,
};
pub use tools::{Tool, ToolRegistry};
