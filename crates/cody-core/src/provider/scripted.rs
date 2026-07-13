use std::{collections::VecDeque, sync::Mutex};

use async_trait::async_trait;

use crate::error::{CodyError, Result};

use super::{
    emit_response, AuthState, ModelDeltaSink, ModelProvider, ModelRequest, ModelResponse,
    ProviderCapabilities, ProviderDescriptor,
};

#[derive(Debug)]
enum ScriptedStep {
    Response(ModelResponse),
    Error(String),
}

/// A deterministic queue-backed provider for agent-loop tests.
///
/// Every call is recorded before the next scripted step is consumed. Tests can
/// therefore assert both the final result and the exact context/tool schemas
/// sent by the runtime.
#[derive(Debug)]
pub struct ScriptedProvider {
    id: String,
    steps: Mutex<VecDeque<ScriptedStep>>,
    requests: Mutex<Vec<ModelRequest>>,
}

impl ScriptedProvider {
    pub fn new(id: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            steps: Mutex::new(VecDeque::new()),
            requests: Mutex::new(Vec::new()),
        }
    }

    pub fn with_responses(
        id: impl Into<String>,
        responses: impl IntoIterator<Item = ModelResponse>,
    ) -> Self {
        let provider = Self::new(id);
        {
            let mut steps = provider
                .steps
                .lock()
                .expect("new scripted provider mutex cannot be poisoned");
            steps.extend(responses.into_iter().map(ScriptedStep::Response));
        }
        provider
    }

    pub fn enqueue_response(&self, response: ModelResponse) -> Result<()> {
        self.steps
            .lock()
            .map_err(|_| poisoned("response queue"))?
            .push_back(ScriptedStep::Response(response));
        Ok(())
    }

    pub fn enqueue_error(&self, error: impl Into<String>) -> Result<()> {
        self.steps
            .lock()
            .map_err(|_| poisoned("response queue"))?
            .push_back(ScriptedStep::Error(error.into()));
        Ok(())
    }

    pub fn requests(&self) -> Result<Vec<ModelRequest>> {
        self.requests
            .lock()
            .map(|requests| requests.clone())
            .map_err(|_| poisoned("request log"))
    }

    pub fn remaining(&self) -> Result<usize> {
        self.steps
            .lock()
            .map(|steps| steps.len())
            .map_err(|_| poisoned("response queue"))
    }
}

impl Default for ScriptedProvider {
    fn default() -> Self {
        Self::new("scripted")
    }
}

#[async_trait]
impl ModelProvider for ScriptedProvider {
    fn id(&self) -> &str {
        &self.id
    }

    fn default_model(&self) -> Option<&str> {
        Some("scripted")
    }

    fn descriptor(&self) -> ProviderDescriptor {
        ProviderDescriptor {
            id: self.id.clone(),
            display_name: self.id.clone(),
            kind: "scripted".into(),
            auth: AuthState::NotRequired,
            capabilities: ProviderCapabilities::default(),
            default_model: Some("scripted".into()),
        }
    }

    async fn complete(
        &self,
        request: ModelRequest,
        delta_sink: Option<&dyn ModelDeltaSink>,
    ) -> Result<ModelResponse> {
        self.requests
            .lock()
            .map_err(|_| poisoned("request log"))?
            .push(request);

        let step = self
            .steps
            .lock()
            .map_err(|_| poisoned("response queue"))?
            .pop_front()
            .ok_or_else(|| {
                CodyError::Provider(format!(
                    "scripted provider '{}' has no response remaining",
                    self.id
                ))
            })?;

        match step {
            ScriptedStep::Response(response) => {
                emit_response(delta_sink, &response).await?;
                Ok(response)
            }
            ScriptedStep::Error(error) => Err(CodyError::Provider(error)),
        }
    }
}

fn poisoned(name: &str) -> CodyError {
    CodyError::Provider(format!("scripted provider {name} lock was poisoned"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn returns_steps_in_order_and_records_requests() {
        let provider = ScriptedProvider::with_responses(
            "test",
            [ModelResponse::text("one"), ModelResponse::text("two")],
        );

        let first = provider
            .complete(ModelRequest::new("model", Vec::new()), None)
            .await
            .unwrap();
        let second = provider
            .complete(ModelRequest::new("model", Vec::new()), None)
            .await
            .unwrap();

        assert_eq!(first.text_content(), "one");
        assert_eq!(second.text_content(), "two");
        assert_eq!(provider.requests().unwrap().len(), 2);
        assert_eq!(provider.remaining().unwrap(), 0);
    }
}
