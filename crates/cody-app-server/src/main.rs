use std::{net::SocketAddr, sync::Arc};

use cody_app_server::{app, AppState};
use cody_core::{
    provider::{EchoProvider, OpenAiCompatibleConfig, OpenAiCompatibleProvider},
    CodyEngine, EngineConfig,
};
use tracing::info;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "cody_app_server=info,cody_core=info".into()),
        )
        .init();

    let config = EngineConfig::from_env()?;
    let engine = Arc::new(CodyEngine::new(config).await?);
    engine
        .providers()
        .register(Arc::new(EchoProvider::default()))?;

    if let Some(provider) = OpenAiCompatibleConfig::from_env()? {
        let provider_id = provider.id.clone();
        engine
            .providers()
            .register(Arc::new(OpenAiCompatibleProvider::new(provider)?))?;
        info!(%provider_id, "registered OpenAI-compatible provider");
    }

    let state = AppState::new(engine);
    info!(
        token = state.auth_token(),
        "app server authentication token"
    );
    let router = app(state);
    let bind = std::env::var("CODY_BIND").unwrap_or_else(|_| "127.0.0.1:8765".into());
    let address: SocketAddr = bind.parse()?;
    if !address.ip().is_loopback() && std::env::var("CODY_ALLOW_REMOTE").as_deref() != Ok("1") {
        anyhow::bail!(
            "refusing non-loopback bind {address}; set CODY_ALLOW_REMOTE=1 after configuring network security"
        );
    }
    let listener = tokio::net::TcpListener::bind(address).await?;
    info!(%address, "Cody app server listening");
    axum::serve(listener, router).await?;
    Ok(())
}
