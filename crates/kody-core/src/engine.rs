use std::{
    path::{Path, PathBuf},
    sync::Arc,
};

use chrono::Utc;
use tokio::process::Command;

use crate::{
    context::DefaultContextBuilder,
    domain::{
        ContextReference, GitMetadata, Project, ProjectId, ProjectKind, Thread, ThreadId,
        ThreadStatus, Workspace, WorkspaceId,
    },
    error::{KodyError, Result},
    event::EventHub,
    image::{GenerateImageTool, ImageProviderRegistry, ImageService},
    process::{ProcessManager, ProcessManagerConfig},
    provider::ProviderRegistry,
    runtime::{AgentRuntime, AgentRuntimeConfig},
    store::{InMemoryStore, JsonFileStore, StateStore},
    title::{ThreadTitleGenerator, DEFAULT_THREAD_TITLE},
    tools::ToolRegistry,
};

#[derive(Debug, Clone)]
pub struct EngineConfig {
    /// Runtime-owned state. Thread workspaces are created below this directory.
    pub state_root: PathBuf,
    pub event_buffer: usize,
    pub agent: AgentRuntimeConfig,
    /// Optional process-manager override. When omitted, durable process logs
    /// live below `state_root/processes` with the standard resource limits.
    pub process_manager: Option<ProcessManagerConfig>,
}

impl EngineConfig {
    pub fn from_env() -> Result<Self> {
        let state_root = match std::env::var_os("KODY_HOME") {
            Some(value) => PathBuf::from(value),
            None => std::env::current_dir()?.join(".kody"),
        };
        let max_steps = std::env::var("KODY_MAX_STEPS")
            .ok()
            .map(|value| {
                value.parse::<usize>().map_err(|_| {
                    KodyError::InvalidInput("KODY_MAX_STEPS must be a positive integer".into())
                })
            })
            .transpose()?
            .unwrap_or(24);
        let approval_value = std::env::var("KODY_REQUIRE_COMMAND_APPROVAL");
        let require_command_approval = match approval_value {
            Ok(value) if value == "0" || value.eq_ignore_ascii_case("false") => false,
            Ok(value) if value == "1" || value.eq_ignore_ascii_case("true") => true,
            Ok(_) => {
                return Err(KodyError::InvalidInput(
                    "KODY_REQUIRE_COMMAND_APPROVAL must be true/false or 1/0".into(),
                ))
            }
            Err(std::env::VarError::NotPresent) => true,
            Err(std::env::VarError::NotUnicode(_)) => {
                return Err(KodyError::InvalidInput(
                    "KODY_REQUIRE_COMMAND_APPROVAL is not Unicode".into(),
                ))
            }
        };

        if max_steps == 0 {
            return Err(KodyError::InvalidInput(
                "KODY_MAX_STEPS must be greater than zero".into(),
            ));
        }

        Ok(Self {
            state_root,
            event_buffer: 1_024,
            agent: AgentRuntimeConfig {
                max_steps,
                require_command_approval,
                ..AgentRuntimeConfig::default()
            },
            process_manager: None,
        })
    }
}

impl Default for EngineConfig {
    fn default() -> Self {
        let state_root = std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(".kody");
        Self {
            state_root,
            event_buffer: 1_024,
            agent: AgentRuntimeConfig::default(),
            process_manager: None,
        }
    }
}

#[derive(Clone)]
pub struct KodyEngine {
    config: EngineConfig,
    store: Arc<dyn StateStore>,
    providers: Arc<ProviderRegistry>,
    tools: Arc<ToolRegistry>,
    image_providers: Arc<ImageProviderRegistry>,
    images: Arc<ImageService>,
    processes: Arc<ProcessManager>,
    events: EventHub,
    runtime: Arc<AgentRuntime>,
}

impl KodyEngine {
    pub async fn new(config: EngineConfig) -> Result<Self> {
        let store: Arc<dyn StateStore> =
            Arc::new(JsonFileStore::open(config.state_root.join("state.json")).await?);
        recover_interrupted_turns(store.as_ref()).await?;
        Self::with_store(config, store).await
    }

    pub async fn in_memory(config: EngineConfig) -> Result<Self> {
        Self::with_store(config, Arc::new(InMemoryStore::default())).await
    }

    pub async fn with_store(config: EngineConfig, store: Arc<dyn StateStore>) -> Result<Self> {
        Self::build(config, store, None).await
    }

    /// Builds an engine with a provider-backed or application-specific title
    /// generator. The runtime preserves its deterministic local fallback and
    /// runs title enrichment outside the turn completion path.
    pub async fn with_store_and_title_generator(
        config: EngineConfig,
        store: Arc<dyn StateStore>,
        title_generator: Arc<dyn ThreadTitleGenerator>,
    ) -> Result<Self> {
        Self::build(config, store, Some(title_generator)).await
    }

    async fn build(
        config: EngineConfig,
        store: Arc<dyn StateStore>,
        title_generator: Option<Arc<dyn ThreadTitleGenerator>>,
    ) -> Result<Self> {
        tokio::fs::create_dir_all(config.state_root.join("workspaces")).await?;
        let providers = Arc::new(ProviderRegistry::default());
        let process_config = config
            .process_manager
            .clone()
            .unwrap_or_else(|| ProcessManagerConfig::new(config.state_root.join("processes")));
        let processes = Arc::new(ProcessManager::new(store.clone(), process_config)?);
        processes.recover_interrupted().await?;
        let image_providers = Arc::new(ImageProviderRegistry::default());
        let images = Arc::new(ImageService::new(store.clone(), image_providers.clone()));
        let mut tool_registry = ToolRegistry::with_builtins_and_processes(processes.clone())?;
        tool_registry.register(GenerateImageTool::new(images.clone()))?;
        let tools = Arc::new(tool_registry);
        let events = EventHub::new(config.event_buffer);
        let context_builder = Arc::new(DefaultContextBuilder::default());
        let runtime = Arc::new(match title_generator {
            Some(title_generator) => AgentRuntime::new_with_title_generator(
                store.clone(),
                providers.clone(),
                tools.clone(),
                events.clone(),
                context_builder,
                title_generator,
                config.agent.clone(),
            ),
            None => AgentRuntime::new(
                store.clone(),
                providers.clone(),
                tools.clone(),
                events.clone(),
                context_builder,
                config.agent.clone(),
            ),
        });

        Ok(Self {
            config,
            store,
            providers,
            tools,
            image_providers,
            images,
            processes,
            events,
            runtime,
        })
    }

    pub fn store(&self) -> &Arc<dyn StateStore> {
        &self.store
    }

    pub fn providers(&self) -> &Arc<ProviderRegistry> {
        &self.providers
    }

    pub fn tools(&self) -> &Arc<ToolRegistry> {
        &self.tools
    }

    pub fn image_providers(&self) -> &Arc<ImageProviderRegistry> {
        &self.image_providers
    }

    pub fn images(&self) -> &Arc<ImageService> {
        &self.images
    }

    pub fn processes(&self) -> &Arc<ProcessManager> {
        &self.processes
    }

    pub fn events(&self) -> &EventHub {
        &self.events
    }

    pub fn runtime(&self) -> &Arc<AgentRuntime> {
        &self.runtime
    }

    /// Gracefully stop every process still supervised by this engine. App
    /// servers should await this before dropping their runtime state.
    pub async fn shutdown(&self) -> Result<Vec<crate::domain::ManagedProcess>> {
        self.processes.shutdown_all().await
    }

    pub async fn import_project(
        &self,
        path: impl AsRef<Path>,
        name: Option<String>,
    ) -> Result<Project> {
        let root = tokio::fs::canonicalize(path.as_ref())
            .await
            .map_err(|error| {
                KodyError::InvalidInput(format!(
                    "cannot import project '{}': {error}",
                    path.as_ref().display()
                ))
            })?;
        if !tokio::fs::metadata(&root).await?.is_dir() {
            return Err(KodyError::InvalidInput(format!(
                "project root '{}' is not a directory",
                root.display()
            )));
        }

        if let Some(existing) = self
            .store
            .list_projects()
            .await?
            .into_iter()
            .find(|project| project.root == root)
        {
            return Ok(existing);
        }

        let is_git = tokio::fs::metadata(root.join(".git")).await.is_ok();
        let project = Project {
            id: ProjectId::new(),
            name: name.unwrap_or_else(|| {
                root.file_name()
                    .and_then(|value| value.to_str())
                    .unwrap_or("project")
                    .to_owned()
            }),
            root: root.clone(),
            kind: if is_git {
                ProjectKind::Git
            } else {
                ProjectKind::Directory
            },
            git: if is_git {
                Some(read_git_metadata(&root).await)
            } else {
                None
            },
            created_at: Utc::now(),
        };
        match self.store.insert_project(project.clone()).await {
            Ok(_) => Ok(project),
            Err(KodyError::Conflict(_)) => self
                .store
                .list_projects()
                .await?
                .into_iter()
                .find(|existing| existing.root == root)
                .ok_or_else(|| {
                    KodyError::Conflict(format!(
                        "project root '{}' was imported concurrently",
                        root.display()
                    ))
                }),
            Err(error) => Err(error),
        }
    }

    pub async fn create_project(
        &self,
        path: impl AsRef<Path>,
        name: Option<String>,
    ) -> Result<Project> {
        let path = path.as_ref();
        if tokio::fs::metadata(path).await.is_ok() {
            return Err(KodyError::Conflict(format!(
                "path '{}' already exists; use project/import",
                path.display()
            )));
        }
        tokio::fs::create_dir_all(path).await?;
        self.import_project(path, name).await
    }

    pub async fn create_thread(
        &self,
        title: impl Into<String>,
        working_directory: Option<PathBuf>,
    ) -> Result<(Thread, Workspace, Option<Project>)> {
        let title = title.into();
        let title = if title.trim().is_empty() {
            DEFAULT_THREAD_TITLE.to_owned()
        } else {
            title
        };
        let imported_project = match working_directory {
            Some(path) => Some(self.import_project(path, None).await?),
            None => None,
        };

        let thread_id = ThreadId::new();
        let workspace_id = WorkspaceId::new();
        let workspace_root = self
            .config
            .state_root
            .join("workspaces")
            .join(thread_id.to_string());
        tokio::fs::create_dir_all(workspace_root.join("artifacts")).await?;
        tokio::fs::create_dir_all(workspace_root.join("tmp")).await?;

        let now = Utc::now();
        let thread = Thread {
            id: thread_id,
            title,
            workspace_id,
            status: ThreadStatus::Idle,
            default_references: imported_project
                .iter()
                .map(|project| ContextReference::Project {
                    project_id: project.id,
                    access: crate::domain::ProjectAccess::ReadWrite,
                })
                .collect(),
            summary: None,
            external_thread_ids: Default::default(),
            created_at: now,
            updated_at: now,
        };
        let workspace = Workspace {
            id: workspace_id,
            thread_id,
            root: workspace_root.clone(),
            created_at: now,
        };

        if let Err(error) = self
            .store
            .insert_thread_with_workspace(thread.clone(), workspace.clone())
            .await
        {
            let _ = tokio::fs::remove_dir_all(&workspace_root).await;
            return Err(error);
        }

        Ok((thread, workspace, imported_project))
    }

    pub async fn add_default_reference(
        &self,
        thread_id: ThreadId,
        reference: ContextReference,
    ) -> Result<Thread> {
        validate_reference(self.store.as_ref(), thread_id, &reference).await?;
        let mut thread = self.store.get_thread(thread_id).await?;
        if thread.status == ThreadStatus::Running {
            return Err(KodyError::Conflict(format!(
                "cannot change references while thread {thread_id} has an active turn"
            )));
        }
        if !thread.default_references.contains(&reference) {
            thread.default_references.push(reference);
            thread.updated_at = Utc::now();
            self.store.update_thread(thread.clone()).await?;
        }
        Ok(thread)
    }
}

async fn recover_interrupted_turns(store: &dyn StateStore) -> Result<()> {
    for thread in store.list_threads().await? {
        for turn in store.list_turns(thread.id).await? {
            let running = match turn.status {
                crate::domain::TurnStatus::Queued => Some(
                    store
                        .transition_turn_status(
                            turn.id,
                            crate::domain::TurnStatus::Queued,
                            crate::domain::TurnStatus::Running,
                        )
                        .await?,
                ),
                crate::domain::TurnStatus::Running => Some(turn),
                _ => None,
            };
            if let Some(running) = running {
                let mut failed = store
                    .transition_turn_status(
                        running.id,
                        crate::domain::TurnStatus::Running,
                        crate::domain::TurnStatus::Failed,
                    )
                    .await?;
                failed.error = Some("app server restarted before the turn completed".into());
                store.update_turn(failed).await?;
            }
        }
        let current = store.get_thread(thread.id).await?;
        if current.status == ThreadStatus::Running {
            store
                .transition_thread_status(thread.id, ThreadStatus::Running, ThreadStatus::Idle)
                .await?;
        }
    }
    Ok(())
}

pub(crate) async fn validate_reference(
    store: &dyn StateStore,
    current_thread: ThreadId,
    reference: &ContextReference,
) -> Result<()> {
    match reference {
        ContextReference::Thread { thread_id, .. } => {
            if *thread_id == current_thread {
                return Err(KodyError::InvalidInput(
                    "a thread cannot reference itself".into(),
                ));
            }
            store.get_thread(*thread_id).await?;
        }
        ContextReference::Project { project_id, .. } => {
            store.get_project(*project_id).await?;
        }
    }
    Ok(())
}

async fn read_git_metadata(root: &Path) -> GitMetadata {
    async fn git_value(root: &Path, args: &[&str]) -> Option<String> {
        let output = Command::new("git")
            .arg("-C")
            .arg(root)
            .args(args)
            .output()
            .await
            .ok()?;
        if !output.status.success() {
            return None;
        }
        let value = String::from_utf8_lossy(&output.stdout).trim().to_owned();
        (!value.is_empty()).then_some(value)
    }

    GitMetadata {
        remote: git_value(root, &["config", "--get", "remote.origin.url"]).await,
        branch: git_value(root, &["branch", "--show-current"]).await,
    }
}
