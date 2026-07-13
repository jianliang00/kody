use serde::{Deserialize, Serialize};

/// Whether a provider instance has the authentication material it expects.
/// The descriptor deliberately exposes state only, never credential values.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AuthState {
    NotRequired,
    Configured,
    Missing,
    Unknown,
}

/// Provider features a client may use to render model and runtime controls.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct ProviderCapabilities {
    pub streaming: bool,
    pub reasoning: bool,
    pub tools: bool,
    pub model_catalog: bool,
    pub custom_models: bool,
}

/// Public, credential-free metadata for one configured provider instance.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProviderDescriptor {
    pub id: String,
    pub display_name: String,
    pub kind: String,
    pub auth: AuthState,
    pub capabilities: ProviderCapabilities,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_model: Option<String>,
}

impl ProviderDescriptor {
    pub fn minimal(id: impl Into<String>, default_model: Option<&str>) -> Self {
        let id = id.into();
        Self {
            display_name: id.clone(),
            kind: "custom".into(),
            id,
            auth: AuthState::Unknown,
            capabilities: ProviderCapabilities::default(),
            default_model: default_model.map(str::to_owned),
        }
    }
}

/// One model returned by a provider catalog. Model IDs remain opaque to Cody.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModelDescriptor {
    pub id: String,
    pub display_name: String,
    /// Whether this is the provider instance's currently configured default.
    #[serde(default)]
    pub is_default: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_reasoning_effort: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub reasoning_efforts: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub owned_by: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_at: Option<i64>,
}

impl ModelDescriptor {
    pub fn new(id: impl Into<String>) -> Self {
        let id = id.into();
        Self {
            display_name: id.clone(),
            id,
            is_default: false,
            description: None,
            default_reasoning_effort: None,
            reasoning_efforts: Vec::new(),
            owned_by: None,
            created_at: None,
        }
    }

    pub fn with_default(mut self, is_default: bool) -> Self {
        self.is_default = is_default;
        self
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderHealthStatus {
    Healthy,
    Degraded,
    Unavailable,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProviderHealth {
    pub status: ProviderHealthStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

impl ProviderHealth {
    pub fn healthy() -> Self {
        Self {
            status: ProviderHealthStatus::Healthy,
            message: None,
        }
    }

    pub fn unavailable(message: impl Into<String>) -> Self {
        Self {
            status: ProviderHealthStatus::Unavailable,
            message: Some(message.into()),
        }
    }
}

/// Stable categories for provider transport and protocol failures.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderErrorKind {
    Authentication,
    RateLimited,
    Timeout,
    Transport,
    InvalidRequest,
    Upstream,
    Protocol,
    Cancelled,
}

impl ProviderErrorKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Authentication => "authentication",
            Self::RateLimited => "rate_limited",
            Self::Timeout => "timeout",
            Self::Transport => "transport",
            Self::InvalidRequest => "invalid_request",
            Self::Upstream => "upstream",
            Self::Protocol => "protocol",
            Self::Cancelled => "cancelled",
        }
    }
}

/// A sanitized provider failure. `message` must never contain credentials.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProviderFailure {
    pub kind: ProviderErrorKind,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry_after_seconds: Option<u64>,
}

impl ProviderFailure {
    pub fn new(kind: ProviderErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
            retry_after_seconds: None,
        }
    }
}

impl std::fmt::Display for ProviderFailure {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}: {}", self.kind.as_str(), self.message)?;
        if let Some(seconds) = self.retry_after_seconds {
            write!(formatter, " (retry after {seconds}s)")?;
        }
        Ok(())
    }
}

impl std::error::Error for ProviderFailure {}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::ModelDescriptor;

    #[test]
    fn model_descriptor_accepts_catalogs_without_optional_metadata() {
        let model: ModelDescriptor = serde_json::from_value(json!({
            "id": "model-1",
            "display_name": "Model 1"
        }))
        .unwrap();

        assert!(!model.is_default);
        assert!(model.description.is_none());
        assert!(model.default_reasoning_effort.is_none());
        assert!(model.reasoning_efforts.is_empty());
    }

    #[test]
    fn model_descriptor_skips_empty_optional_catalog_metadata() {
        let value = serde_json::to_value(ModelDescriptor::new("model-1")).unwrap();

        assert_eq!(value["is_default"], false);
        assert!(value.get("description").is_none());
        assert!(value.get("default_reasoning_effort").is_none());
        assert!(value.get("reasoning_efforts").is_none());
    }
}
