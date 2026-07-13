use async_trait::async_trait;

use crate::error::Result;

use super::{
    emit_response, AuthState, ModelDeltaSink, ModelProvider, ModelRequest, ModelResponse,
    ModelRole, ProviderCapabilities, ProviderDescriptor,
};

/// Deterministic provider that returns the most recent user message's text.
/// It is useful for smoke tests and for running the app server without model
/// credentials.
#[derive(Debug, Clone)]
pub struct EchoProvider {
    id: String,
}

impl EchoProvider {
    pub fn new(id: impl Into<String>) -> Self {
        Self { id: id.into() }
    }
}

impl Default for EchoProvider {
    fn default() -> Self {
        Self::new("echo")
    }
}

#[async_trait]
impl ModelProvider for EchoProvider {
    fn id(&self) -> &str {
        &self.id
    }

    fn default_model(&self) -> Option<&str> {
        Some("echo")
    }

    fn descriptor(&self) -> ProviderDescriptor {
        ProviderDescriptor {
            id: self.id.clone(),
            display_name: "Echo".into(),
            kind: "echo".into(),
            auth: AuthState::NotRequired,
            capabilities: ProviderCapabilities {
                custom_models: false,
                ..ProviderCapabilities::default()
            },
            default_model: Some("echo".into()),
        }
    }

    async fn complete(
        &self,
        request: ModelRequest,
        delta_sink: Option<&dyn ModelDeltaSink>,
    ) -> Result<ModelResponse> {
        let text = request
            .messages
            .iter()
            .rev()
            .find(|message| message.role == ModelRole::User)
            .map(|message| message.text_content())
            .unwrap_or_default();
        let response = ModelResponse::text(text);
        emit_response(delta_sink, &response).await?;
        Ok(response)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::provider::ModelMessage;

    #[tokio::test]
    async fn echoes_latest_user_text() {
        let provider = EchoProvider::default();
        let request = ModelRequest::new(
            "ignored",
            vec![
                ModelMessage::text(ModelRole::User, "first"),
                ModelMessage::text(ModelRole::Assistant, "answer"),
                ModelMessage::text(ModelRole::User, "second"),
            ],
        );

        let response = provider.complete(request, None).await.unwrap();
        assert_eq!(response.text_content(), "second");
    }
}
