use std::sync::Arc;

use async_trait::async_trait;
use cody_core::{
    provider::{
        ModelDeltaSink, ModelMessage, ModelProvider, ModelRequest, ModelResponse, ModelRole,
    },
    ProviderRegistry, Result,
};

#[derive(Debug)]
struct ReverseProvider;

#[async_trait]
impl ModelProvider for ReverseProvider {
    fn id(&self) -> &str {
        "reverse"
    }

    fn default_model(&self) -> Option<&str> {
        Some("reverse-v1")
    }

    async fn complete(
        &self,
        request: ModelRequest,
        _delta_sink: Option<&dyn ModelDeltaSink>,
    ) -> Result<ModelResponse> {
        let input = request
            .messages
            .iter()
            .rev()
            .find(|message| message.role == ModelRole::User)
            .map(ModelMessage::text_content)
            .unwrap_or_default();
        Ok(ModelResponse::text(input.chars().rev().collect::<String>()))
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    let providers = ProviderRegistry::new();
    providers.register(Arc::new(ReverseProvider))?;

    let provider = providers.get("reverse")?;
    let response = provider
        .complete(
            ModelRequest::new(
                provider.default_model().unwrap_or("reverse-v1"),
                vec![ModelMessage::text(ModelRole::User, "Cody")],
            ),
            None,
        )
        .await?;
    println!("{}", response.text_content());
    Ok(())
}
