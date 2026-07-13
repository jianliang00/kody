//! Provider-neutral model API and built-in provider adapters.

mod echo;
mod metadata;
mod openai_compatible;
mod openai_responses;
mod scripted;
mod types;

use std::{
    collections::HashMap,
    fmt,
    sync::{Arc, RwLock},
};

use async_trait::async_trait;
use tokio_util::sync::CancellationToken;

use crate::error::{KodyError, Result};

pub use crate::tools::{ToolCall, ToolDefinition, ToolResult};
pub use echo::EchoProvider;
pub use metadata::{
    AuthState, ModelDescriptor, ProviderCapabilities, ProviderDescriptor, ProviderErrorKind,
    ProviderFailure, ProviderHealth, ProviderHealthStatus,
};
pub use openai_compatible::{OpenAiCompatibleConfig, OpenAiCompatibleProvider};
pub use openai_responses::{OpenAiResponsesConfig, OpenAiResponsesProvider};
pub use scripted::ScriptedProvider;
pub use types::{
    DeltaSink, FinishReason, ModelContent, ModelDelta, ModelDeltaSink, ModelMessage, ModelRequest,
    ModelResponse, ModelRole, ModelUsage,
};

use types::emit_response;

/// Object-safe abstraction over a model service.
///
/// Implementations own authentication, transport, and provider-specific wire
/// formats. The rest of Kody only sees the neutral request and response types.
#[async_trait]
pub trait ModelProvider: fmt::Debug + Send + Sync {
    /// Stable registry key for this provider instance.
    fn id(&self) -> &str;

    /// Provider-level fallback used when a turn does not explicitly select a
    /// model. Providers exposing many models may leave this unset.
    fn default_model(&self) -> Option<&str> {
        None
    }

    /// Credential-free metadata suitable for clients and persistence.
    fn descriptor(&self) -> ProviderDescriptor {
        ProviderDescriptor::minimal(self.id(), self.default_model())
    }

    /// Lists currently available models. Providers without a remote catalog
    /// return their configured default model when one exists.
    async fn list_models(&self) -> Result<Vec<ModelDescriptor>> {
        Ok(self
            .default_model()
            .map(|id| ModelDescriptor::new(id).with_default(true))
            .into_iter()
            .collect())
    }

    /// Performs a provider-specific readiness check without exposing secrets.
    async fn health(&self) -> Result<ProviderHealth> {
        Ok(ProviderHealth::healthy())
    }

    /// Produces one complete model response. A provider may optionally emit
    /// incremental updates to `delta_sink`; callers must always use the return
    /// value as the authoritative completed response.
    async fn complete(
        &self,
        request: ModelRequest,
        delta_sink: Option<&dyn ModelDeltaSink>,
    ) -> Result<ModelResponse>;

    /// Cancellation-aware completion entry point for direct provider users.
    /// Dropping the losing request future also cancels reqwest streaming I/O.
    async fn complete_cancellable(
        &self,
        request: ModelRequest,
        delta_sink: Option<&dyn ModelDeltaSink>,
        cancellation: CancellationToken,
    ) -> Result<ModelResponse> {
        tokio::select! {
            biased;
            _ = cancellation.cancelled() => Err(KodyError::Cancelled),
            response = self.complete(request, delta_sink) => response,
        }
    }
}

/// Thread-safe process-local provider registry. Clones share registrations.
#[derive(Clone, Default)]
pub struct ProviderRegistry {
    providers: Arc<RwLock<HashMap<String, Arc<dyn ModelProvider>>>>,
}

impl fmt::Debug for ProviderRegistry {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ProviderRegistry")
            .field("ids", &self.ids().unwrap_or_default())
            .finish()
    }
}

impl ProviderRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Registers a provider without replacing an existing provider. Provider
    /// IDs are trimmed and must be non-empty.
    pub fn register(&self, provider: Arc<dyn ModelProvider>) -> Result<()> {
        let id = validate_provider(&provider)?.to_owned();

        let mut providers = self.write()?;
        if providers.contains_key(&id) {
            return Err(KodyError::Conflict(format!(
                "provider '{id}' is already registered"
            )));
        }
        providers.insert(id, provider);
        Ok(())
    }

    /// Atomically installs a provider and returns the previous registration.
    /// Existing callers retain their cloned `Arc` lease and can finish safely.
    pub fn replace(
        &self,
        provider: Arc<dyn ModelProvider>,
    ) -> Result<Option<Arc<dyn ModelProvider>>> {
        let id = validate_provider(&provider)?.to_owned();
        Ok(self.write()?.insert(id, provider))
    }

    pub fn get(&self, id: &str) -> Result<Arc<dyn ModelProvider>> {
        self.read()?
            .get(id)
            .cloned()
            .ok_or_else(|| KodyError::ProviderNotFound(id.to_owned()))
    }

    pub fn contains(&self, id: &str) -> Result<bool> {
        Ok(self.read()?.contains_key(id))
    }

    /// Removes and returns a provider. Existing `Arc` handles continue to work.
    pub fn remove(&self, id: &str) -> Result<Option<Arc<dyn ModelProvider>>> {
        Ok(self.write()?.remove(id))
    }

    pub fn ids(&self) -> Result<Vec<String>> {
        let mut ids = self.read()?.keys().cloned().collect::<Vec<_>>();
        ids.sort();
        Ok(ids)
    }

    pub fn descriptors(&self) -> Result<Vec<ProviderDescriptor>> {
        let providers = self.read()?.values().cloned().collect::<Vec<_>>();
        let mut descriptors = providers
            .into_iter()
            .map(|provider| provider.descriptor())
            .collect::<Vec<_>>();
        descriptors.sort_by(|left, right| left.id.cmp(&right.id));
        Ok(descriptors)
    }

    pub fn len(&self) -> Result<usize> {
        Ok(self.read()?.len())
    }

    pub fn is_empty(&self) -> Result<bool> {
        Ok(self.read()?.is_empty())
    }

    fn read(
        &self,
    ) -> Result<std::sync::RwLockReadGuard<'_, HashMap<String, Arc<dyn ModelProvider>>>> {
        self.providers
            .read()
            .map_err(|_| KodyError::Provider("provider registry lock was poisoned".into()))
    }

    fn write(
        &self,
    ) -> Result<std::sync::RwLockWriteGuard<'_, HashMap<String, Arc<dyn ModelProvider>>>> {
        self.providers
            .write()
            .map_err(|_| KodyError::Provider("provider registry lock was poisoned".into()))
    }
}

fn validate_provider(provider: &Arc<dyn ModelProvider>) -> Result<&str> {
    let id = provider.id().trim();
    if id.is_empty() {
        return Err(KodyError::InvalidInput(
            "provider id must not be empty".into(),
        ));
    }
    if id != provider.id() {
        return Err(KodyError::InvalidInput(
            "provider id must not contain leading or trailing whitespace".into(),
        ));
    }
    let descriptor = provider.descriptor();
    if descriptor.id != id {
        return Err(KodyError::InvalidInput(format!(
            "provider descriptor id '{}' does not match registry id '{id}'",
            descriptor.id
        )));
    }
    Ok(id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_rejects_duplicates_and_sorts_ids() {
        let registry = ProviderRegistry::new();
        registry
            .register(Arc::new(EchoProvider::new("z-provider")))
            .unwrap();
        registry
            .register(Arc::new(EchoProvider::new("a-provider")))
            .unwrap();

        assert_eq!(registry.ids().unwrap(), ["a-provider", "z-provider"]);
        assert!(matches!(
            registry.register(Arc::new(EchoProvider::new("a-provider"))),
            Err(KodyError::Conflict(_))
        ));
    }

    #[test]
    fn replace_is_atomic_and_existing_arc_remains_usable() {
        let registry = ProviderRegistry::new();
        let first: Arc<dyn ModelProvider> = Arc::new(EchoProvider::new("echo"));
        registry.register(first.clone()).unwrap();
        let lease = registry.get("echo").unwrap();
        let second: Arc<dyn ModelProvider> = Arc::new(EchoProvider::new("echo"));

        let replaced = registry.replace(second.clone()).unwrap().unwrap();
        assert!(Arc::ptr_eq(&first, &lease));
        assert!(Arc::ptr_eq(&first, &replaced));
        assert!(Arc::ptr_eq(&second, &registry.get("echo").unwrap()));
        assert!(!Arc::ptr_eq(&lease, &registry.get("echo").unwrap()));
    }
}
