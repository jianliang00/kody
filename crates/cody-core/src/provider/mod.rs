//! Provider-neutral model API and built-in provider adapters.

mod echo;
mod openai_compatible;
mod scripted;
mod types;

use std::{
    collections::HashMap,
    fmt,
    sync::{Arc, RwLock},
};

use async_trait::async_trait;

use crate::error::{CodyError, Result};

pub use crate::tools::{ToolCall, ToolDefinition, ToolResult};
pub use echo::EchoProvider;
pub use openai_compatible::{OpenAiCompatibleConfig, OpenAiCompatibleProvider};
pub use scripted::ScriptedProvider;
pub use types::{
    DeltaSink, FinishReason, ModelContent, ModelDelta, ModelDeltaSink, ModelMessage, ModelRequest,
    ModelResponse, ModelRole, ModelUsage,
};

use types::emit_response;

/// Object-safe abstraction over a model service.
///
/// Implementations own authentication, transport, and provider-specific wire
/// formats. The rest of Cody only sees the neutral request and response types.
#[async_trait]
pub trait ModelProvider: fmt::Debug + Send + Sync {
    /// Stable registry key for this provider instance.
    fn id(&self) -> &str;

    /// Provider-level fallback used when a turn does not explicitly select a
    /// model. Providers exposing many models may leave this unset.
    fn default_model(&self) -> Option<&str> {
        None
    }

    /// Produces one complete model response. A provider may optionally emit
    /// incremental updates to `delta_sink`; callers must always use the return
    /// value as the authoritative completed response.
    async fn complete(
        &self,
        request: ModelRequest,
        delta_sink: Option<&dyn ModelDeltaSink>,
    ) -> Result<ModelResponse>;
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
        let id = provider.id().trim();
        if id.is_empty() {
            return Err(CodyError::InvalidInput(
                "provider id must not be empty".into(),
            ));
        }
        if id != provider.id() {
            return Err(CodyError::InvalidInput(
                "provider id must not contain leading or trailing whitespace".into(),
            ));
        }

        let mut providers = self.write()?;
        if providers.contains_key(id) {
            return Err(CodyError::Conflict(format!(
                "provider '{id}' is already registered"
            )));
        }
        providers.insert(id.to_owned(), provider);
        Ok(())
    }

    pub fn get(&self, id: &str) -> Result<Arc<dyn ModelProvider>> {
        self.read()?
            .get(id)
            .cloned()
            .ok_or_else(|| CodyError::ProviderNotFound(id.to_owned()))
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
            .map_err(|_| CodyError::Provider("provider registry lock was poisoned".into()))
    }

    fn write(
        &self,
    ) -> Result<std::sync::RwLockWriteGuard<'_, HashMap<String, Arc<dyn ModelProvider>>>> {
        self.providers
            .write()
            .map_err(|_| CodyError::Provider("provider registry lock was poisoned".into()))
    }
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
            Err(CodyError::Conflict(_))
        ));
    }
}
