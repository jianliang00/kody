//! Provider-neutral image generation, durable artifact storage, and the
//! model-visible `generate_image` tool.

use std::{
    collections::HashMap,
    fmt,
    path::{Component, Path, PathBuf},
    sync::{Arc, RwLock},
    time::Duration,
};

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

use async_trait::async_trait;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use chrono::Utc;
use futures_util::StreamExt;
use reqwest::{header, Client, Method, Url};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::{io::AsyncWriteExt, sync::Mutex};
use tokio_util::sync::CancellationToken;

use crate::{
    domain::{
        Artifact, ArtifactId, ArtifactKind, Message, MessageId, MessagePart, MessageRole, ThreadId,
        ThreadStatus, TurnId,
    },
    error::{KodyError, Result},
    provider::AuthState,
    store::StateStore,
    tools::{Tool, ToolCall, ToolContext, ToolDefinition, ToolResult, ToolRisk},
};

const DEFAULT_OPENAI_BASE_URL: &str = "https://api.openai.com/v1";
const DEFAULT_IMAGE_MODEL: &str = "gpt-image-2";
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(300);
const MAX_RESPONSE_BYTES: usize = 96 * 1024 * 1024;
const MAX_IMAGE_BYTES: usize = 32 * 1024 * 1024;
const MAX_PROMPT_CHARS: usize = 64_000;
const MAX_IMAGES: u8 = 4;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct ImageModelCapabilities {
    pub generation: bool,
    pub editing: bool,
    pub masking: bool,
    pub max_images: u8,
    pub sizes: Vec<String>,
    pub qualities: Vec<String>,
    pub output_formats: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ImageModelDescriptor {
    pub id: String,
    pub display_name: String,
    #[serde(default)]
    pub is_default: bool,
    pub capabilities: ImageModelCapabilities,
}

impl ImageModelDescriptor {
    pub fn generation(id: impl Into<String>, is_default: bool) -> Self {
        let id = id.into();
        Self {
            display_name: id.clone(),
            id,
            is_default,
            capabilities: ImageModelCapabilities {
                generation: true,
                editing: false,
                masking: false,
                max_images: MAX_IMAGES,
                sizes: vec![
                    "auto".into(),
                    "1024x1024".into(),
                    "1024x1536".into(),
                    "1536x1024".into(),
                ],
                qualities: vec!["auto".into(), "low".into(), "medium".into(), "high".into()],
                output_formats: vec!["png".into(), "jpeg".into(), "webp".into()],
            },
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ImageProviderDescriptor {
    pub id: String,
    pub display_name: String,
    pub kind: String,
    pub auth: AuthState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_model: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ImageRequest {
    pub model: String,
    pub prompt: String,
    #[serde(default = "default_image_count")]
    pub count: u8,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quality: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_format: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub background: Option<String>,
}

fn default_image_count() -> u8 {
    1
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImageOutput {
    pub bytes: Vec<u8>,
    pub mime_type: String,
    pub revised_prompt: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GenerateImageRequest {
    pub thread_id: ThreadId,
    pub provider: String,
    #[serde(default)]
    pub model: Option<String>,
    pub prompt: String,
    #[serde(default = "default_image_count")]
    pub count: u8,
    #[serde(default)]
    pub size: Option<String>,
    #[serde(default)]
    pub quality: Option<String>,
    #[serde(default)]
    pub output_format: Option<String>,
    #[serde(default)]
    pub background: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ImageGenerationResult {
    pub provider: String,
    pub model: String,
    pub artifacts: Vec<Artifact>,
}

#[async_trait]
pub trait ImageProvider: fmt::Debug + Send + Sync {
    fn id(&self) -> &str;
    fn default_model(&self) -> Option<&str> {
        None
    }
    fn descriptor(&self) -> ImageProviderDescriptor;
    async fn list_models(&self) -> Result<Vec<ImageModelDescriptor>>;
    async fn generate(
        &self,
        request: ImageRequest,
        cancellation: CancellationToken,
    ) -> Result<Vec<ImageOutput>>;
}

#[derive(Clone, Default)]
pub struct ImageProviderRegistry {
    providers: Arc<RwLock<HashMap<String, Arc<dyn ImageProvider>>>>,
}

impl fmt::Debug for ImageProviderRegistry {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ImageProviderRegistry")
            .field("ids", &self.ids().unwrap_or_default())
            .finish()
    }
}

impl ImageProviderRegistry {
    pub fn replace(
        &self,
        provider: Arc<dyn ImageProvider>,
    ) -> Result<Option<Arc<dyn ImageProvider>>> {
        let id = provider.id().trim();
        if id.is_empty() || id != provider.id() {
            return Err(KodyError::InvalidInput(
                "image provider id must be non-empty without surrounding whitespace".into(),
            ));
        }
        Ok(self.write()?.insert(id.to_owned(), provider))
    }

    pub fn get(&self, id: &str) -> Result<Arc<dyn ImageProvider>> {
        self.read()?
            .get(id)
            .cloned()
            .ok_or_else(|| KodyError::ProviderNotFound(id.to_owned()))
    }

    pub fn remove(&self, id: &str) -> Result<Option<Arc<dyn ImageProvider>>> {
        Ok(self.write()?.remove(id))
    }

    pub fn ids(&self) -> Result<Vec<String>> {
        let mut ids = self.read()?.keys().cloned().collect::<Vec<_>>();
        ids.sort();
        Ok(ids)
    }

    pub fn descriptors(&self) -> Result<Vec<ImageProviderDescriptor>> {
        let mut descriptors = self
            .read()?
            .values()
            .map(|provider| provider.descriptor())
            .collect::<Vec<_>>();
        descriptors.sort_by(|left, right| left.id.cmp(&right.id));
        Ok(descriptors)
    }

    fn read(
        &self,
    ) -> Result<std::sync::RwLockReadGuard<'_, HashMap<String, Arc<dyn ImageProvider>>>> {
        self.providers
            .read()
            .map_err(|_| KodyError::Provider("image provider registry lock was poisoned".into()))
    }

    fn write(
        &self,
    ) -> Result<std::sync::RwLockWriteGuard<'_, HashMap<String, Arc<dyn ImageProvider>>>> {
        self.providers
            .write()
            .map_err(|_| KodyError::Provider("image provider registry lock was poisoned".into()))
    }
}

#[derive(Clone)]
pub struct OpenAiImageConfig {
    pub id: String,
    pub display_name: String,
    pub base_url: String,
    pub api_key: Option<String>,
    pub require_api_key: bool,
    pub default_model: Option<String>,
    pub configured_models: Vec<String>,
    pub timeout: Duration,
}

impl OpenAiImageConfig {
    pub fn new(id: impl Into<String>, base_url: impl Into<String>) -> Self {
        let id = id.into();
        Self {
            display_name: id.clone(),
            id,
            base_url: base_url.into(),
            api_key: None,
            require_api_key: true,
            default_model: Some(DEFAULT_IMAGE_MODEL.into()),
            configured_models: Vec::new(),
            timeout: DEFAULT_TIMEOUT,
        }
    }
}

impl Default for OpenAiImageConfig {
    fn default() -> Self {
        Self::new("openai-images", DEFAULT_OPENAI_BASE_URL)
    }
}

impl fmt::Debug for OpenAiImageConfig {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("OpenAiImageConfig")
            .field("id", &self.id)
            .field("display_name", &self.display_name)
            .field("base_url", &self.base_url)
            .field("api_key", &self.api_key.as_ref().map(|_| "[REDACTED]"))
            .field("default_model", &self.default_model)
            .field("configured_models", &self.configured_models)
            .finish()
    }
}

#[derive(Clone)]
pub struct OpenAiImageProvider {
    config: OpenAiImageConfig,
    client: Client,
    endpoint: Url,
}

impl fmt::Debug for OpenAiImageProvider {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("OpenAiImageProvider")
            .field("config", &self.config)
            .field("endpoint", &self.endpoint)
            .finish()
    }
}

impl OpenAiImageProvider {
    pub fn new(config: OpenAiImageConfig) -> Result<Self> {
        if config.id.trim().is_empty() || config.id != config.id.trim() {
            return Err(KodyError::InvalidInput(
                "image provider id must be non-empty without surrounding whitespace".into(),
            ));
        }
        if config.timeout.is_zero() {
            return Err(KodyError::InvalidInput(
                "image provider timeout must be greater than zero".into(),
            ));
        }
        let endpoint = image_endpoint(&config.base_url)?;
        let client = Client::builder()
            .timeout(config.timeout)
            .build()
            .map_err(|error| {
                KodyError::Provider(format!("failed to build image client: {error}"))
            })?;
        Ok(Self {
            config,
            client,
            endpoint,
        })
    }

    fn redact(&self, value: &str) -> String {
        self.config
            .api_key
            .as_deref()
            .filter(|secret| !secret.is_empty())
            .map_or_else(
                || value.to_owned(),
                |secret| value.replace(secret, "[REDACTED]"),
            )
    }
}

#[async_trait]
impl ImageProvider for OpenAiImageProvider {
    fn id(&self) -> &str {
        &self.config.id
    }

    fn default_model(&self) -> Option<&str> {
        self.config.default_model.as_deref()
    }

    fn descriptor(&self) -> ImageProviderDescriptor {
        ImageProviderDescriptor {
            id: self.config.id.clone(),
            display_name: self.config.display_name.clone(),
            kind: "openai_images".into(),
            auth: if !self.config.require_api_key {
                AuthState::NotRequired
            } else if self.config.api_key.is_some() {
                AuthState::Configured
            } else {
                AuthState::Missing
            },
            default_model: self.config.default_model.clone(),
        }
    }

    async fn list_models(&self) -> Result<Vec<ImageModelDescriptor>> {
        let mut models = self.config.configured_models.clone();
        if let Some(model) = &self.config.default_model {
            models.push(model.clone());
        }
        models.retain(|model| !model.trim().is_empty());
        models.sort();
        models.dedup();
        Ok(models
            .into_iter()
            .map(|model| {
                let is_default = self.config.default_model.as_deref() == Some(model.as_str());
                ImageModelDescriptor::generation(model, is_default)
            })
            .collect())
    }

    async fn generate(
        &self,
        request: ImageRequest,
        cancellation: CancellationToken,
    ) -> Result<Vec<ImageOutput>> {
        validate_image_request(&request)?;
        let requested_count = request.count as usize;
        if self.config.require_api_key && self.config.api_key.is_none() {
            return Err(KodyError::Provider(
                "the image provider requires an API key".into(),
            ));
        }
        let mut body = serde_json::Map::new();
        body.insert("model".into(), Value::String(request.model));
        body.insert("prompt".into(), Value::String(request.prompt));
        body.insert("n".into(), Value::from(request.count));
        if let Some(value) = request.size {
            body.insert("size".into(), Value::String(value));
        }
        if let Some(value) = request.quality {
            body.insert("quality".into(), Value::String(value));
        }
        if let Some(value) = request.output_format {
            body.insert("output_format".into(), Value::String(value));
        }
        if let Some(value) = request.background {
            body.insert("background".into(), Value::String(value));
        }

        let mut builder = self
            .client
            .request(Method::POST, self.endpoint.clone())
            .header(header::ACCEPT, "application/json")
            .json(&Value::Object(body));
        if let Some(api_key) = self.config.api_key.as_deref() {
            builder = builder.bearer_auth(api_key);
        }
        let response = tokio::select! {
            biased;
            _ = cancellation.cancelled() => return Err(KodyError::Cancelled),
            response = builder.send() => response.map_err(|error| {
                KodyError::Provider(self.redact(&format!("image request failed: {error}")))
            })?,
        };
        let status = response.status();
        let bytes = read_bounded_response(response, cancellation).await?;
        if !status.is_success() {
            return Err(KodyError::Provider(self.redact(&format!(
                "image API returned {status}: {}",
                api_error_message(&bytes)
            ))));
        }
        let payload: OpenAiImageResponse = serde_json::from_slice(&bytes).map_err(|error| {
            KodyError::Provider(format!("image API returned invalid JSON: {error}"))
        })?;
        if payload.data.is_empty() {
            return Err(KodyError::Provider(
                "image API returned no generated images".into(),
            ));
        }
        if payload.data.len() > requested_count || payload.data.len() > MAX_IMAGES as usize {
            return Err(KodyError::Provider(
                "image API returned more images than requested".into(),
            ));
        }
        payload
            .data
            .into_iter()
            .map(|item| {
                let encoded = item.b64_json.ok_or_else(|| {
                    KodyError::Provider("image API response omitted base64 image data".into())
                })?;
                let decoded = BASE64.decode(encoded).map_err(|error| {
                    KodyError::Provider(format!("image API returned invalid base64: {error}"))
                })?;
                if decoded.is_empty() || decoded.len() > MAX_IMAGE_BYTES {
                    return Err(KodyError::Provider(format!(
                        "generated image size must be between 1 byte and {MAX_IMAGE_BYTES} bytes"
                    )));
                }
                let (mime_type, _) = detect_image_format(&decoded)?;
                Ok(ImageOutput {
                    bytes: decoded,
                    mime_type: mime_type.into(),
                    revised_prompt: item.revised_prompt,
                })
            })
            .collect()
    }
}

#[derive(Debug, Deserialize)]
struct OpenAiImageResponse {
    #[serde(default)]
    data: Vec<OpenAiImageData>,
}

#[derive(Debug, Deserialize)]
struct OpenAiImageData {
    #[serde(default)]
    b64_json: Option<String>,
    #[serde(default)]
    revised_prompt: Option<String>,
}

#[derive(Clone)]
pub struct ImageService {
    store: Arc<dyn StateStore>,
    providers: Arc<ImageProviderRegistry>,
    generation_locks: Arc<Mutex<HashMap<ThreadId, Arc<Mutex<()>>>>>,
}

struct ToolImageGenerationRequest {
    thread_id: ThreadId,
    turn_id: TurnId,
    provider: Option<String>,
    model: Option<String>,
    prompt: String,
    count: u8,
    size: Option<String>,
    quality: Option<String>,
    output_format: Option<String>,
    background: Option<String>,
}

impl fmt::Debug for ImageService {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ImageService")
            .field("providers", &self.providers)
            .finish_non_exhaustive()
    }
}

impl ImageService {
    pub fn new(store: Arc<dyn StateStore>, providers: Arc<ImageProviderRegistry>) -> Self {
        Self {
            store,
            providers,
            generation_locks: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn providers(&self) -> &Arc<ImageProviderRegistry> {
        &self.providers
    }

    pub async fn generate_and_record(
        &self,
        request: GenerateImageRequest,
        cancellation: CancellationToken,
    ) -> Result<ImageGenerationResult> {
        let generation_lock = {
            let mut locks = self.generation_locks.lock().await;
            locks
                .entry(request.thread_id)
                .or_insert_with(|| Arc::new(Mutex::new(())))
                .clone()
        };
        let _generation_guard = generation_lock.try_lock_owned().map_err(|_| {
            KodyError::Conflict(format!(
                "thread {} already has an active image generation",
                request.thread_id
            ))
        })?;
        let thread = self.store.get_thread(request.thread_id).await?;
        if thread.status != ThreadStatus::Idle {
            return Err(KodyError::Conflict(format!(
                "thread {} already has active work",
                thread.id
            )));
        }
        let provider = self.providers.get(&request.provider)?;
        let model = resolve_image_model(provider.as_ref(), request.model.as_deref())?;
        let provider_request = to_provider_request(&request, &model);
        validate_image_request(&provider_request)?;
        let outputs = provider
            .generate(provider_request, cancellation.clone())
            .await?;
        validate_provider_outputs(&outputs, request.count)?;
        let assistant_id = MessageId::new();
        let artifacts = self
            .persist_outputs(
                request.thread_id,
                Some(assistant_id),
                &request.provider,
                &model,
                &request.prompt,
                outputs,
                &cancellation,
            )
            .await?;
        let now = Utc::now();
        let user = Message {
            id: MessageId::new(),
            thread_id: request.thread_id,
            turn_id: None,
            role: MessageRole::User,
            parts: vec![MessagePart::Text {
                text: request.prompt.clone(),
            }],
            references: Vec::new(),
            created_at: now,
        };
        let mut parts = vec![MessagePart::Text {
            text: format!(
                "Generated {} image{} with `{}`.",
                artifacts.len(),
                if artifacts.len() == 1 { "" } else { "s" },
                model
            ),
        }];
        parts.extend(artifacts.iter().map(artifact_message_part));
        let assistant = Message {
            id: assistant_id,
            thread_id: request.thread_id,
            turn_id: None,
            role: MessageRole::Assistant,
            parts,
            references: Vec::new(),
            created_at: Utc::now(),
        };
        if let Err(error) = self
            .store
            .append_image_generation(user, assistant, artifacts.clone())
            .await
        {
            self.remove_artifact_files(&artifacts).await;
            return Err(error);
        }
        Ok(ImageGenerationResult {
            provider: request.provider,
            model,
            artifacts,
        })
    }

    async fn generate_for_tool(
        &self,
        request: ToolImageGenerationRequest,
        cancellation: CancellationToken,
    ) -> Result<ImageGenerationResult> {
        let turn = self.store.get_turn(request.turn_id).await?;
        if turn.thread_id != request.thread_id {
            return Err(KodyError::Conflict(
                "image tool Turn belongs to a different Thread".into(),
            ));
        }
        let provider_id = request.provider.unwrap_or(turn.provider);
        let provider = self.providers.get(&provider_id)?;
        let model = resolve_image_model(provider.as_ref(), request.model.as_deref())?;
        let generation_request = GenerateImageRequest {
            thread_id: request.thread_id,
            provider: provider_id.clone(),
            model: Some(model.clone()),
            prompt: request.prompt,
            count: request.count,
            size: request.size,
            quality: request.quality,
            output_format: request.output_format,
            background: request.background,
        };
        let provider_request = to_provider_request(&generation_request, &model);
        validate_image_request(&provider_request)?;
        let outputs = provider
            .generate(provider_request, cancellation.clone())
            .await?;
        validate_provider_outputs(&outputs, generation_request.count)?;
        let artifacts = self
            .persist_outputs(
                generation_request.thread_id,
                None,
                &provider_id,
                &model,
                &generation_request.prompt,
                outputs,
                &cancellation,
            )
            .await?;
        if let Err(error) = self.store.insert_artifacts(artifacts.clone()).await {
            self.remove_artifact_files(&artifacts).await;
            return Err(error);
        }
        Ok(ImageGenerationResult {
            provider: provider_id,
            model,
            artifacts,
        })
    }

    pub async fn read_artifact(&self, artifact_id: ArtifactId) -> Result<(Artifact, Vec<u8>)> {
        let artifact = self.store.get_artifact(artifact_id).await?;
        let workspace = self
            .store
            .get_workspace_for_thread(artifact.thread_id)
            .await?;
        validate_artifact_relative_path(&artifact.relative_path)?;
        let root = tokio::fs::canonicalize(&workspace.root).await?;
        let target = tokio::fs::canonicalize(workspace.root.join(&artifact.relative_path)).await?;
        if !target.starts_with(&root) {
            return Err(KodyError::Store(format!(
                "artifact {} escapes its Thread Workspace",
                artifact.id
            )));
        }
        let bytes = tokio::fs::read(target).await?;
        if bytes.len() as u64 != artifact.byte_size || bytes.len() > MAX_IMAGE_BYTES {
            return Err(KodyError::Store(format!(
                "artifact {} has inconsistent file metadata",
                artifact.id
            )));
        }
        let (mime_type, _) = detect_image_format(&bytes)?;
        if mime_type != artifact.mime_type {
            return Err(KodyError::Store(format!(
                "artifact {} MIME type does not match its bytes",
                artifact.id
            )));
        }
        Ok((artifact, bytes))
    }

    #[allow(clippy::too_many_arguments)]
    async fn persist_outputs(
        &self,
        thread_id: ThreadId,
        message_id: Option<MessageId>,
        provider: &str,
        model: &str,
        prompt: &str,
        outputs: Vec<ImageOutput>,
        cancellation: &CancellationToken,
    ) -> Result<Vec<Artifact>> {
        let workspace = self.store.get_workspace_for_thread(thread_id).await?;
        let artifact_directory = workspace.root.join("artifacts");
        let temporary_directory = workspace.root.join("tmp");
        ensure_private_directory(&artifact_directory).await?;
        ensure_private_directory(&temporary_directory).await?;
        let mut artifacts = Vec::with_capacity(outputs.len());
        for output in outputs {
            if cancellation.is_cancelled() {
                self.remove_artifact_files(&artifacts).await;
                return Err(KodyError::Cancelled);
            }
            if output.bytes.is_empty() || output.bytes.len() > MAX_IMAGE_BYTES {
                self.remove_artifact_files(&artifacts).await;
                return Err(KodyError::Provider(format!(
                    "generated image size must be between 1 byte and {MAX_IMAGE_BYTES} bytes"
                )));
            }
            if output
                .revised_prompt
                .as_ref()
                .is_some_and(|value| value.chars().count() > MAX_PROMPT_CHARS)
            {
                self.remove_artifact_files(&artifacts).await;
                return Err(KodyError::Provider(
                    "image provider returned an oversized revised prompt".into(),
                ));
            }
            let (detected_mime_type, extension) = detect_image_format(&output.bytes)?;
            if output.mime_type != detected_mime_type {
                self.remove_artifact_files(&artifacts).await;
                return Err(KodyError::Provider(
                    "image provider MIME type did not match the returned bytes".into(),
                ));
            }
            let id = ArtifactId::new();
            let file_name = format!("generated-{id}.{extension}");
            let relative_path = PathBuf::from("artifacts").join(&file_name);
            let temporary = workspace.root.join("tmp").join(format!(".{id}.tmp"));
            let target = workspace.root.join(&relative_path);
            let write_result: Result<()> = async {
                let mut options = tokio::fs::OpenOptions::new();
                options.create_new(true).write(true);
                let mut file = options.open(&temporary).await?;
                #[cfg(unix)]
                tokio::fs::set_permissions(&temporary, std::fs::Permissions::from_mode(0o600))
                    .await?;
                file.write_all(&output.bytes).await?;
                file.flush().await?;
                file.sync_all().await?;
                drop(file);
                tokio::fs::rename(&temporary, &target).await?;
                Ok(())
            }
            .await;
            if let Err(error) = write_result {
                let _ = tokio::fs::remove_file(&temporary).await;
                self.remove_artifact_files(&artifacts).await;
                return Err(error);
            }
            artifacts.push(Artifact {
                id,
                thread_id,
                message_id,
                kind: ArtifactKind::Image,
                mime_type: detected_mime_type.into(),
                file_name,
                relative_path,
                byte_size: output.bytes.len() as u64,
                provider: provider.to_owned(),
                model: model.to_owned(),
                prompt: output.revised_prompt.unwrap_or_else(|| prompt.to_owned()),
                created_at: Utc::now(),
            });
        }
        Ok(artifacts)
    }

    async fn remove_artifact_files(&self, artifacts: &[Artifact]) {
        for artifact in artifacts {
            if let Ok(workspace) = self
                .store
                .get_workspace_for_thread(artifact.thread_id)
                .await
            {
                let _ = tokio::fs::remove_file(workspace.root.join(&artifact.relative_path)).await;
            }
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct GenerateImageArguments {
    prompt: String,
    #[serde(default)]
    provider: Option<String>,
    #[serde(default)]
    model: Option<String>,
    #[serde(default = "default_image_count")]
    count: u8,
    #[serde(default)]
    size: Option<String>,
    #[serde(default)]
    quality: Option<String>,
    #[serde(default)]
    output_format: Option<String>,
    #[serde(default)]
    background: Option<String>,
}

#[derive(Debug, Clone)]
pub struct GenerateImageTool {
    service: Arc<ImageService>,
}

impl GenerateImageTool {
    pub fn new(service: Arc<ImageService>) -> Self {
        Self { service }
    }
}

#[async_trait]
impl Tool for GenerateImageTool {
    fn definition(&self) -> ToolDefinition {
        ToolDefinition::new(
            "generate_image",
            "Generate one or more image artifacts. Omit provider to use the current Turn's provider; that provider must have image generation configured.",
            json!({
                "type": "object",
                "properties": {
                    "prompt": { "type": "string", "minLength": 1, "maxLength": MAX_PROMPT_CHARS },
                    "provider": { "type": "string", "description": "Optional configured image provider ID." },
                    "model": { "type": "string", "description": "Optional image model ID; provider default is used when omitted." },
                    "count": { "type": "integer", "minimum": 1, "maximum": MAX_IMAGES, "default": 1 },
                    "size": { "type": "string", "description": "Provider-supported size such as 1024x1024 or auto." },
                    "quality": { "type": "string", "description": "Provider-supported quality such as low, medium, high, or auto." },
                    "output_format": { "type": "string", "enum": ["png", "jpeg", "webp"] },
                    "background": { "type": "string", "description": "Provider-supported background mode." }
                },
                "required": ["prompt"],
                "additionalProperties": false
            }),
        )
    }

    fn risk(&self) -> ToolRisk {
        ToolRisk::ExternalAction
    }

    fn approval_reason(&self) -> Option<&'static str> {
        Some("Image generation calls an external paid model and writes the returned artifact to this Thread Workspace.")
    }

    async fn execute(&self, call: &ToolCall, context: &ToolContext) -> Result<ToolResult> {
        let arguments: GenerateImageArguments = serde_json::from_value(call.arguments.clone())
            .map_err(|error| {
                KodyError::InvalidInput(format!("invalid generate_image arguments: {error}"))
            })?;
        let result = self
            .service
            .generate_for_tool(
                ToolImageGenerationRequest {
                    thread_id: context.thread_id,
                    turn_id: context.turn_id,
                    provider: arguments.provider,
                    model: arguments.model,
                    prompt: arguments.prompt,
                    count: arguments.count,
                    size: arguments.size,
                    quality: arguments.quality,
                    output_format: arguments.output_format,
                    background: arguments.background,
                },
                context.cancellation_token.clone(),
            )
            .await?;
        Ok(ToolResult::success(
            call,
            format!(
                "generated {} image artifact{} with {}",
                result.artifacts.len(),
                if result.artifacts.len() == 1 { "" } else { "s" },
                result.model
            ),
            json!({ "artifacts": result.artifacts }),
        ))
    }
}

fn resolve_image_model(provider: &dyn ImageProvider, requested: Option<&str>) -> Result<String> {
    requested
        .filter(|model| !model.trim().is_empty())
        .map(str::to_owned)
        .or_else(|| provider.default_model().map(str::to_owned))
        .ok_or_else(|| {
            KodyError::InvalidInput(format!(
                "image model is required for provider '{}'",
                provider.id()
            ))
        })
}

fn to_provider_request(request: &GenerateImageRequest, model: &str) -> ImageRequest {
    ImageRequest {
        model: model.to_owned(),
        prompt: request.prompt.clone(),
        count: request.count,
        size: request.size.clone(),
        quality: request.quality.clone(),
        output_format: request.output_format.clone(),
        background: request.background.clone(),
    }
}

fn artifact_message_part(artifact: &Artifact) -> MessagePart {
    MessagePart::Artifact {
        artifact_id: artifact.id,
        kind: artifact.kind,
        mime_type: artifact.mime_type.clone(),
        file_name: artifact.file_name.clone(),
    }
}

fn validate_image_request(request: &ImageRequest) -> Result<()> {
    if request.model.trim().is_empty()
        || request.model != request.model.trim()
        || request.model.chars().count() > 200
    {
        return Err(KodyError::InvalidInput(
            "image model must contain 1 to 200 characters without surrounding whitespace".into(),
        ));
    }
    let prompt_chars = request.prompt.chars().count();
    if prompt_chars == 0 || prompt_chars > MAX_PROMPT_CHARS {
        return Err(KodyError::InvalidInput(format!(
            "image prompt must contain between 1 and {MAX_PROMPT_CHARS} characters"
        )));
    }
    if !(1..=MAX_IMAGES).contains(&request.count) {
        return Err(KodyError::InvalidInput(format!(
            "image count must be between 1 and {MAX_IMAGES}"
        )));
    }
    if let Some(format) = request.output_format.as_deref() {
        if !matches!(format, "png" | "jpeg" | "webp") {
            return Err(KodyError::InvalidInput(
                "image output_format must be png, jpeg, or webp".into(),
            ));
        }
    }
    for (label, value) in [
        ("size", request.size.as_deref()),
        ("quality", request.quality.as_deref()),
        ("background", request.background.as_deref()),
    ] {
        if let Some(value) = value {
            if value.is_empty()
                || value != value.trim()
                || value.chars().count() > 100
                || value.chars().any(char::is_control)
            {
                return Err(KodyError::InvalidInput(format!(
                    "image {label} must contain 1 to 100 printable characters without surrounding whitespace"
                )));
            }
        }
    }
    Ok(())
}

fn validate_provider_outputs(outputs: &[ImageOutput], requested_count: u8) -> Result<()> {
    if outputs.is_empty() || outputs.len() > requested_count as usize {
        return Err(KodyError::Provider(
            "image provider returned an unexpected number of images".into(),
        ));
    }
    for output in outputs {
        if output.bytes.is_empty() || output.bytes.len() > MAX_IMAGE_BYTES {
            return Err(KodyError::Provider(format!(
                "generated image size must be between 1 byte and {MAX_IMAGE_BYTES} bytes"
            )));
        }
        if output
            .revised_prompt
            .as_ref()
            .is_some_and(|value| value.chars().count() > MAX_PROMPT_CHARS)
        {
            return Err(KodyError::Provider(
                "image provider returned an oversized revised prompt".into(),
            ));
        }
        let (detected_mime_type, _) = detect_image_format(&output.bytes)?;
        if output.mime_type != detected_mime_type {
            return Err(KodyError::Provider(
                "image provider MIME type did not match the returned bytes".into(),
            ));
        }
    }
    Ok(())
}

fn image_endpoint(base_url: &str) -> Result<Url> {
    let trimmed = base_url.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return Err(KodyError::InvalidInput(
            "image provider base URL must not be empty".into(),
        ));
    }
    let root = trimmed
        .strip_suffix("/images/generations")
        .or_else(|| trimmed.strip_suffix("/responses"))
        .or_else(|| trimmed.strip_suffix("/chat/completions"))
        .unwrap_or(trimmed);
    let parsed = Url::parse(root).map_err(|error| {
        KodyError::InvalidInput(format!(
            "invalid image provider base URL '{base_url}': {error}"
        ))
    })?;
    if !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return Err(KodyError::InvalidInput(
            "image provider base URL must not contain credentials, a query, or a fragment".into(),
        ));
    }
    Url::parse(&format!(
        "{}/images/generations",
        parsed.as_str().trim_end_matches('/')
    ))
    .map_err(|error| KodyError::InvalidInput(error.to_string()))
}

async fn read_bounded_response(
    response: reqwest::Response,
    cancellation: CancellationToken,
) -> Result<Vec<u8>> {
    if response
        .content_length()
        .is_some_and(|length| length > MAX_RESPONSE_BYTES as u64)
    {
        return Err(KodyError::Provider(
            "image API response exceeded the 96 MiB limit".into(),
        ));
    }
    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    loop {
        let next = tokio::select! {
            biased;
            _ = cancellation.cancelled() => return Err(KodyError::Cancelled),
            next = stream.next() => next,
        };
        let Some(chunk) = next else { break };
        let chunk = chunk.map_err(|error| {
            KodyError::Provider(format!("failed to read image API response: {error}"))
        })?;
        if bytes.len().saturating_add(chunk.len()) > MAX_RESPONSE_BYTES {
            return Err(KodyError::Provider(
                "image API response exceeded the 96 MiB limit".into(),
            ));
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

fn api_error_message(bytes: &[u8]) -> String {
    serde_json::from_slice::<Value>(bytes)
        .ok()
        .and_then(|value| {
            value
                .pointer("/error/message")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .unwrap_or_else(|| {
            let text = String::from_utf8_lossy(bytes);
            text.chars().take(2_000).collect()
        })
}

fn detect_image_format(bytes: &[u8]) -> Result<(&'static str, &'static str)> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Ok(("image/png", "png"));
    }
    if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        return Ok(("image/jpeg", "jpg"));
    }
    if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return Ok(("image/webp", "webp"));
    }
    Err(KodyError::Provider(
        "image provider returned an unsupported or invalid image file".into(),
    ))
}

fn validate_artifact_relative_path(path: &Path) -> Result<()> {
    let components = path.components().collect::<Vec<_>>();
    if components.len() != 2
        || components.first() != Some(&Component::Normal("artifacts".as_ref()))
        || !matches!(components.get(1), Some(Component::Normal(_)))
    {
        return Err(KodyError::Store(format!(
            "invalid persisted artifact path '{}'",
            path.display()
        )));
    }
    Ok(())
}

async fn ensure_private_directory(path: &Path) -> Result<()> {
    tokio::fs::create_dir_all(path).await?;
    #[cfg(unix)]
    tokio::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
        sync::oneshot,
    };

    use crate::{engine::EngineConfig, KodyEngine};

    use super::*;

    async fn spawn_image_api(
        body: Value,
    ) -> (
        String,
        oneshot::Receiver<String>,
        tokio::task::JoinHandle<()>,
    ) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let response_body = serde_json::to_vec(&body).unwrap();
        let (request_sender, request_receiver) = oneshot::channel();
        let task = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let request = read_http_request(&mut socket).await;
            let _ = request_sender.send(String::from_utf8_lossy(&request).into_owned());
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                response_body.len()
            );
            socket.write_all(response.as_bytes()).await.unwrap();
            socket.write_all(&response_body).await.unwrap();
        });
        (format!("http://{address}/v1"), request_receiver, task)
    }

    async fn read_http_request(socket: &mut tokio::net::TcpStream) -> Vec<u8> {
        let mut request = Vec::new();
        let mut buffer = [0_u8; 4_096];
        let mut expected = None;
        loop {
            let read = socket.read(&mut buffer).await.unwrap();
            if read == 0 {
                break;
            }
            request.extend_from_slice(&buffer[..read]);
            if expected.is_none() {
                if let Some(header_end) = request.windows(4).position(|part| part == b"\r\n\r\n") {
                    let headers = String::from_utf8_lossy(&request[..header_end]);
                    let content_length = headers
                        .lines()
                        .find_map(|line| {
                            let (name, value) = line.split_once(':')?;
                            name.eq_ignore_ascii_case("content-length")
                                .then(|| value.trim().parse::<usize>().ok())
                                .flatten()
                        })
                        .unwrap_or_default();
                    expected = Some(header_end + 4 + content_length);
                }
            }
            if expected.is_some_and(|length| request.len() >= length) {
                break;
            }
        }
        request
    }

    #[test]
    fn image_endpoint_accepts_api_roots_and_endpoint_urls() {
        assert_eq!(
            image_endpoint("https://api.openai.com/v1")
                .unwrap()
                .as_str(),
            "https://api.openai.com/v1/images/generations"
        );
        assert_eq!(
            image_endpoint("https://example.test/v1/responses")
                .unwrap()
                .as_str(),
            "https://example.test/v1/images/generations"
        );
    }

    #[test]
    fn detects_supported_image_signatures() {
        assert_eq!(
            detect_image_format(b"\x89PNG\r\n\x1a\nrest").unwrap().0,
            "image/png"
        );
        assert_eq!(
            detect_image_format(&[0xff, 0xd8, 0xff, 0x00]).unwrap().0,
            "image/jpeg"
        );
        assert_eq!(
            detect_image_format(b"RIFF0000WEBPrest").unwrap().0,
            "image/webp"
        );
        assert!(detect_image_format(b"not-an-image").is_err());
    }

    #[tokio::test]
    async fn openai_adapter_persists_a_durable_conversation_artifact() {
        const PNG_BASE64: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+3MxZ5wAAAABJRU5ErkJggg==";
        let (base_url, request_receiver, server) = spawn_image_api(json!({
            "created": 1,
            "data": [{
                "b64_json": PNG_BASE64,
                "revised_prompt": "A tiny coral square"
            }]
        }))
        .await;
        let state_root = tempfile::tempdir().unwrap();
        let engine_config = EngineConfig {
            state_root: state_root.path().to_path_buf(),
            ..EngineConfig::default()
        };
        let engine = KodyEngine::in_memory(engine_config).await.unwrap();
        let mut provider_config = OpenAiImageConfig::new("images", base_url);
        provider_config.api_key = Some("test-image-secret".into());
        provider_config.default_model = Some("image-test-1".into());
        engine
            .image_providers()
            .replace(Arc::new(OpenAiImageProvider::new(provider_config).unwrap()))
            .unwrap();
        let (thread, _, _) = engine.create_thread("Generate a logo", None).await.unwrap();

        let result = engine
            .images()
            .generate_and_record(
                GenerateImageRequest {
                    thread_id: thread.id,
                    provider: "images".into(),
                    model: None,
                    prompt: "A coral square logo".into(),
                    count: 1,
                    size: Some("1024x1024".into()),
                    quality: Some("high".into()),
                    output_format: Some("png".into()),
                    background: Some("transparent".into()),
                },
                CancellationToken::new(),
            )
            .await
            .unwrap();

        let request = request_receiver.await.unwrap();
        server.await.unwrap();
        assert!(request.starts_with("POST /v1/images/generations HTTP/1.1\r\n"));
        assert!(request
            .to_ascii_lowercase()
            .contains("authorization: bearer test-image-secret"));
        let request_body = request.split_once("\r\n\r\n").unwrap().1;
        let request_json: Value = serde_json::from_str(request_body).unwrap();
        assert_eq!(request_json["model"], "image-test-1");
        assert_eq!(request_json["prompt"], "A coral square logo");
        assert_eq!(request_json["n"], 1);
        assert_eq!(request_json["size"], "1024x1024");
        assert_eq!(request_json["quality"], "high");
        assert_eq!(request_json["output_format"], "png");
        assert_eq!(request_json["background"], "transparent");

        assert_eq!(result.provider, "images");
        assert_eq!(result.model, "image-test-1");
        assert_eq!(result.artifacts.len(), 1);
        let artifact = &result.artifacts[0];
        assert_eq!(artifact.prompt, "A tiny coral square");
        assert_eq!(artifact.mime_type, "image/png");
        assert!(artifact.message_id.is_some());
        let messages = engine.store().list_messages(thread.id).await.unwrap();
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0].role, MessageRole::User);
        assert_eq!(messages[1].role, MessageRole::Assistant);
        assert!(messages[1].parts.iter().any(|part| {
            matches!(part, MessagePart::Artifact { artifact_id, .. } if *artifact_id == artifact.id)
        }));
        let (stored, bytes) = engine.images().read_artifact(artifact.id).await.unwrap();
        assert_eq!(stored, *artifact);
        assert_eq!(bytes, BASE64.decode(PNG_BASE64).unwrap());
        assert!(tokio::fs::metadata(
            state_root
                .path()
                .join("workspaces")
                .join(thread.id.to_string())
                .join(&artifact.relative_path)
        )
        .await
        .unwrap()
        .is_file());
    }
}
