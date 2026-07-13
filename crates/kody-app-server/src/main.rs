use std::{future::IntoFuture, net::SocketAddr, sync::Arc};

use kody_app_server::{app, AppState};
use kody_core::{
    provider::{EchoProvider, OpenAiCompatibleConfig, OpenAiCompatibleProvider},
    EngineConfig, KodyEngine,
};
use tokio_util::sync::CancellationToken;
use tracing::{info, warn};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "kody_app_server=info,kody_core=info".into()),
        )
        .init();

    let config = EngineConfig::from_env()?;
    let engine = Arc::new(KodyEngine::new(config).await?);
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
    // Provider adapters retain credentials in private memory. Remove ambient
    // copies before tools, managed processes, or the Codex sidecar can spawn.
    std::env::remove_var("KODY_OPENAI_API_KEY");
    std::env::remove_var("OPENAI_API_KEY");

    let state = AppState::new(engine);
    let router = app(state.clone());
    let bind = std::env::var("KODY_BIND").unwrap_or_else(|_| "127.0.0.1:8765".into());
    let address: SocketAddr = bind.parse()?;
    if !address.ip().is_loopback() && std::env::var("KODY_ALLOW_REMOTE").as_deref() != Ok("1") {
        anyhow::bail!(
            "refusing non-loopback bind {address}; set KODY_ALLOW_REMOTE=1 after configuring network security"
        );
    }
    let listener = tokio::net::TcpListener::bind(address).await?;
    info!(%address, "Kody app server listening");
    let shutdown = CancellationToken::new();
    let signal_token = shutdown.clone();
    tokio::spawn(async move {
        wait_for_shutdown_signal().await;
        signal_token.cancel();
    });

    let server = axum::serve(listener, router)
        .with_graceful_shutdown(shutdown.clone().cancelled_owned())
        .into_future();
    tokio::pin!(server);
    tokio::select! {
        result = &mut server => {
            result?;
            perform_shutdown(state).await;
        }
        _ = shutdown.cancelled() => {
            // The graceful signal has already stopped new accepts. Cleanup
            // now runs while HTTP requests and WebSockets drain.
            perform_shutdown(state).await;
            if tokio::time::timeout(std::time::Duration::from_secs(2), &mut server)
                .await
                .is_err()
            {
                warn!("timed out waiting for network connections to drain");
            }
        }
    }
    Ok(())
}

async fn wait_for_shutdown_signal() {
    #[cfg(unix)]
    {
        let mut terminate =
            match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
                Ok(signal) => signal,
                Err(error) => {
                    warn!(%error, "could not install SIGTERM handler; waiting for Ctrl-C only");
                    tokio::signal::ctrl_c().await.ok();
                    return;
                }
            };
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {}
            _ = terminate.recv() => {}
        }
    }

    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}

async fn perform_shutdown(state: AppState) {
    info!("shutting down Kody app server");
    if !state
        .turns
        .cancel_all_and_wait(std::time::Duration::from_secs(5))
        .await
    {
        warn!("timed out waiting for active Turns to persist cancellation");
    }
    if let Err(error) = state.engine.shutdown().await {
        warn!(%error, "managed process shutdown reported an error");
    }
    state.codex.shutdown().await;
}
