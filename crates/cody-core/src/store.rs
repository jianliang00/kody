use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::Arc,
};

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use tokio::{
    io::AsyncWriteExt,
    sync::{Mutex, RwLock},
};

use crate::{
    domain::{
        ContextReference, Message, MessageId, Project, ProjectId, Thread, ThreadId, ThreadStatus,
        Turn, TurnId, TurnStatus, Workspace, WorkspaceId,
    },
    error::{CodyError, Result},
};

/// Durable state used by the agent runtime.
///
/// Implementations must return snapshots owned by the caller. In particular,
/// callers are expected to fetch an entity, mutate the snapshot, and pass it
/// back to the corresponding `update_*` method.
#[async_trait]
pub trait StateStore: Send + Sync {
    async fn insert_project(&self, project: Project) -> Result<Project>;
    async fn get_project(&self, id: ProjectId) -> Result<Project>;
    async fn list_projects(&self) -> Result<Vec<Project>>;
    async fn update_project(&self, project: Project) -> Result<Project>;
    async fn delete_project(&self, id: ProjectId) -> Result<()>;

    async fn insert_thread(&self, thread: Thread) -> Result<Thread>;
    async fn insert_thread_with_workspace(
        &self,
        thread: Thread,
        workspace: Workspace,
    ) -> Result<(Thread, Workspace)>;
    async fn get_thread(&self, id: ThreadId) -> Result<Thread>;
    async fn list_threads(&self) -> Result<Vec<Thread>>;
    async fn update_thread(&self, thread: Thread) -> Result<Thread>;
    async fn transition_thread_status(
        &self,
        id: ThreadId,
        expected: ThreadStatus,
        next: ThreadStatus,
    ) -> Result<Thread>;
    async fn delete_thread(&self, id: ThreadId) -> Result<()>;

    async fn insert_workspace(&self, workspace: Workspace) -> Result<Workspace>;
    async fn get_workspace(&self, id: WorkspaceId) -> Result<Workspace>;
    async fn get_workspace_for_thread(&self, thread_id: ThreadId) -> Result<Workspace>;
    async fn list_workspaces(&self) -> Result<Vec<Workspace>>;
    async fn update_workspace(&self, workspace: Workspace) -> Result<Workspace>;
    async fn delete_workspace(&self, id: WorkspaceId) -> Result<()>;

    async fn append_message(&self, message: Message) -> Result<Message>;
    async fn get_message(&self, id: MessageId) -> Result<Message>;
    async fn list_messages(&self, thread_id: ThreadId) -> Result<Vec<Message>>;
    async fn update_message(&self, message: Message) -> Result<Message>;
    async fn delete_message(&self, id: MessageId) -> Result<()>;

    async fn insert_turn(&self, turn: Turn) -> Result<Turn>;
    async fn get_turn(&self, id: TurnId) -> Result<Turn>;
    async fn list_turns(&self, thread_id: ThreadId) -> Result<Vec<Turn>>;
    async fn update_turn(&self, turn: Turn) -> Result<Turn>;
    async fn transition_turn_status(
        &self,
        id: TurnId,
        expected: TurnStatus,
        next: TurnStatus,
    ) -> Result<Turn>;
    async fn delete_turn(&self, id: TurnId) -> Result<()>;
}

/// A process-local state store suitable for embedding, tests, and a
/// single-process app server. Clones share the same state.
#[derive(Debug, Clone, Default)]
pub struct InMemoryStore {
    inner: Arc<RwLock<StoreState>>,
}

/// A versioned JSON state store with atomic file replacement.
///
/// Mutations are applied to an isolated in-memory candidate, persisted, and
/// only then published to readers. Clones share both state and the persistence
/// lock.
#[derive(Debug, Clone)]
pub struct JsonFileStore {
    memory: InMemoryStore,
    path: Arc<PathBuf>,
    persistence: Arc<Mutex<()>>,
}

const JSON_SNAPSHOT_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize)]
struct JsonSnapshot {
    version: u32,
    projects: Vec<Project>,
    threads: Vec<Thread>,
    workspaces: Vec<Workspace>,
    messages: Vec<Message>,
    turns: Vec<Turn>,
}

#[derive(Debug, Clone, Default)]
struct StoreState {
    projects: HashMap<ProjectId, Project>,
    threads: HashMap<ThreadId, Thread>,
    workspaces: HashMap<WorkspaceId, Workspace>,
    workspace_by_thread: HashMap<ThreadId, WorkspaceId>,
    messages: HashMap<MessageId, Message>,
    message_order_by_thread: HashMap<ThreadId, Vec<MessageId>>,
    turns: HashMap<TurnId, Turn>,
    turn_order_by_thread: HashMap<ThreadId, Vec<TurnId>>,
}

impl InMemoryStore {
    pub fn new() -> Self {
        Self::default()
    }

    async fn fork(&self) -> Self {
        let state = self.inner.read().await.clone();
        Self {
            inner: Arc::new(RwLock::new(state)),
        }
    }

    async fn snapshot(&self) -> Result<JsonSnapshot> {
        let state = self.inner.read().await;
        JsonSnapshot::from_state(&state)
    }

    async fn replace_with(&self, candidate: &Self) {
        let next = candidate.inner.read().await.clone();
        *self.inner.write().await = next;
    }
}

impl JsonFileStore {
    pub async fn open(path: impl AsRef<Path>) -> Result<Self> {
        let path = path.as_ref().to_path_buf();
        if let Some(parent) = non_empty_parent(&path) {
            tokio::fs::create_dir_all(parent).await?;
        }

        let (memory, needs_initial_snapshot) = match tokio::fs::read(&path).await {
            Ok(bytes) => {
                let snapshot: JsonSnapshot = serde_json::from_slice(&bytes).map_err(|error| {
                    CodyError::Store(format!(
                        "failed to parse state snapshot '{}': {error}",
                        path.display()
                    ))
                })?;
                (InMemoryStore::from_snapshot(snapshot)?, false)
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                (InMemoryStore::new(), true)
            }
            Err(error) => return Err(error.into()),
        };

        let store = Self {
            memory,
            path: Arc::new(path),
            persistence: Arc::new(Mutex::new(())),
        };
        if needs_initial_snapshot {
            let snapshot = store.memory.snapshot().await?;
            write_snapshot_atomic(store.path.as_ref(), &snapshot).await?;
        }
        Ok(store)
    }

    pub fn path(&self) -> &Path {
        self.path.as_path()
    }

    async fn commit_candidate(&self, candidate: &InMemoryStore) -> Result<()> {
        let snapshot = candidate.snapshot().await?;
        write_snapshot_atomic(self.path.as_ref(), &snapshot).await?;
        self.memory.replace_with(candidate).await;
        Ok(())
    }
}

macro_rules! persistent_mutation {
    ($store:expr, $candidate:ident, $operation:expr) => {{
        let _persistence_guard = $store.persistence.lock().await;
        let $candidate = $store.memory.fork().await;
        let output = $operation?;
        $store.commit_candidate(&$candidate).await?;
        Ok(output)
    }};
}

impl JsonSnapshot {
    fn from_state(state: &StoreState) -> Result<Self> {
        validate_store_state(state)?;

        let mut projects: Vec<_> = state.projects.values().cloned().collect();
        projects.sort_by(|left, right| {
            left.created_at
                .cmp(&right.created_at)
                .then_with(|| left.id.cmp(&right.id))
        });

        let mut threads: Vec<_> = state.threads.values().cloned().collect();
        threads.sort_by(|left, right| {
            left.created_at
                .cmp(&right.created_at)
                .then_with(|| left.id.cmp(&right.id))
        });

        let mut workspaces: Vec<_> = state.workspaces.values().cloned().collect();
        workspaces.sort_by(|left, right| {
            left.created_at
                .cmp(&right.created_at)
                .then_with(|| left.id.cmp(&right.id))
        });

        let mut ordered_thread_ids: Vec<_> = state.threads.keys().copied().collect();
        ordered_thread_ids.sort();
        let messages = ordered_thread_ids
            .iter()
            .flat_map(|thread_id| {
                state
                    .message_order_by_thread
                    .get(thread_id)
                    .into_iter()
                    .flatten()
                    .map(|id| {
                        state
                            .messages
                            .get(id)
                            .expect("validated message order")
                            .clone()
                    })
            })
            .collect();
        let turns = ordered_thread_ids
            .iter()
            .flat_map(|thread_id| {
                state
                    .turn_order_by_thread
                    .get(thread_id)
                    .into_iter()
                    .flatten()
                    .map(|id| state.turns.get(id).expect("validated turn order").clone())
            })
            .collect();

        Ok(Self {
            version: JSON_SNAPSHOT_VERSION,
            projects,
            threads,
            workspaces,
            messages,
            turns,
        })
    }
}

impl InMemoryStore {
    fn from_snapshot(snapshot: JsonSnapshot) -> Result<Self> {
        if snapshot.version != JSON_SNAPSHOT_VERSION {
            return Err(invalid_snapshot(format!(
                "unsupported version {}; expected {}",
                snapshot.version, JSON_SNAPSHOT_VERSION
            )));
        }

        let mut state = StoreState::default();
        for project in snapshot.projects {
            if state.projects.insert(project.id, project.clone()).is_some() {
                return Err(invalid_snapshot(format!(
                    "duplicate project id {}",
                    project.id
                )));
            }
        }
        for thread in snapshot.threads {
            if state.threads.insert(thread.id, thread.clone()).is_some() {
                return Err(invalid_snapshot(format!(
                    "duplicate thread id {}",
                    thread.id
                )));
            }
        }
        for workspace in snapshot.workspaces {
            if state
                .workspaces
                .insert(workspace.id, workspace.clone())
                .is_some()
            {
                return Err(invalid_snapshot(format!(
                    "duplicate workspace id {}",
                    workspace.id
                )));
            }
            if let Some(existing) = state
                .workspace_by_thread
                .insert(workspace.thread_id, workspace.id)
            {
                return Err(invalid_snapshot(format!(
                    "thread {} has both workspace {} and {}",
                    workspace.thread_id, existing, workspace.id
                )));
            }
        }
        for message in snapshot.messages {
            if state.messages.insert(message.id, message.clone()).is_some() {
                return Err(invalid_snapshot(format!(
                    "duplicate message id {}",
                    message.id
                )));
            }
            state
                .message_order_by_thread
                .entry(message.thread_id)
                .or_default()
                .push(message.id);
        }
        for turn in snapshot.turns {
            if state.turns.insert(turn.id, turn.clone()).is_some() {
                return Err(invalid_snapshot(format!("duplicate turn id {}", turn.id)));
            }
            state
                .turn_order_by_thread
                .entry(turn.thread_id)
                .or_default()
                .push(turn.id);
        }

        validate_store_state(&state)?;
        Ok(Self {
            inner: Arc::new(RwLock::new(state)),
        })
    }
}

fn validate_store_state(state: &StoreState) -> Result<()> {
    let mut project_roots = HashSet::with_capacity(state.projects.len());
    for project in state.projects.values() {
        if !project_roots.insert(project.root.clone()) {
            return Err(invalid_snapshot(format!(
                "project root '{}' is imported more than once",
                project.root.display()
            )));
        }
    }
    if state.workspace_by_thread.len() != state.workspaces.len() {
        return Err(invalid_snapshot(
            "workspace ownership index does not cover every workspace",
        ));
    }
    for workspace in state.workspaces.values() {
        if state.workspace_by_thread.get(&workspace.thread_id) != Some(&workspace.id) {
            return Err(invalid_snapshot(format!(
                "workspace {} has an inconsistent thread ownership index",
                workspace.id
            )));
        }
        let thread = state.threads.get(&workspace.thread_id).ok_or_else(|| {
            invalid_snapshot(format!(
                "workspace {} references missing thread {}",
                workspace.id, workspace.thread_id
            ))
        })?;
        if thread.workspace_id != workspace.id {
            return Err(invalid_snapshot(format!(
                "thread {} expects workspace {}, not {}",
                thread.id, thread.workspace_id, workspace.id
            )));
        }
    }
    for thread in state.threads.values() {
        if !state.workspaces.contains_key(&thread.workspace_id) {
            return Err(invalid_snapshot(format!(
                "thread {} references missing workspace {}",
                thread.id, thread.workspace_id
            )));
        }
        validate_thread_workspace(state, thread).map_err(snapshot_invariant)?;
        validate_references(state, thread.id, &thread.default_references)
            .map_err(snapshot_invariant)?;
    }

    let mut seen_messages = HashSet::with_capacity(state.messages.len());
    for (thread_id, order) in &state.message_order_by_thread {
        if !state.threads.contains_key(thread_id) {
            return Err(invalid_snapshot(format!(
                "message order references missing thread {thread_id}"
            )));
        }
        for message_id in order {
            if !seen_messages.insert(*message_id) {
                return Err(invalid_snapshot(format!(
                    "message {message_id} occurs more than once in message order"
                )));
            }
            let message = state.messages.get(message_id).ok_or_else(|| {
                invalid_snapshot(format!(
                    "message order contains missing message {message_id}"
                ))
            })?;
            if message.thread_id != *thread_id {
                return Err(invalid_snapshot(format!(
                    "message {message_id} is ordered under the wrong thread"
                )));
            }
        }
    }
    if seen_messages.len() != state.messages.len() {
        return Err(invalid_snapshot(
            "one or more messages are absent from message order",
        ));
    }
    for message in state.messages.values() {
        validate_message(state, message).map_err(snapshot_invariant)?;
    }

    let mut seen_turns = HashSet::with_capacity(state.turns.len());
    for (thread_id, order) in &state.turn_order_by_thread {
        if !state.threads.contains_key(thread_id) {
            return Err(invalid_snapshot(format!(
                "turn order references missing thread {thread_id}"
            )));
        }
        for turn_id in order {
            if !seen_turns.insert(*turn_id) {
                return Err(invalid_snapshot(format!(
                    "turn {turn_id} occurs more than once in turn order"
                )));
            }
            let turn = state.turns.get(turn_id).ok_or_else(|| {
                invalid_snapshot(format!("turn order contains missing turn {turn_id}"))
            })?;
            if turn.thread_id != *thread_id {
                return Err(invalid_snapshot(format!(
                    "turn {turn_id} is ordered under the wrong thread"
                )));
            }
        }
    }
    if seen_turns.len() != state.turns.len() {
        return Err(invalid_snapshot(
            "one or more turns are absent from turn order",
        ));
    }
    for turn in state.turns.values() {
        validate_turn(state, turn).map_err(snapshot_invariant)?;
    }

    Ok(())
}

fn invalid_snapshot(message: impl Into<String>) -> CodyError {
    CodyError::Store(format!("invalid state snapshot: {}", message.into()))
}

fn snapshot_invariant(error: CodyError) -> CodyError {
    invalid_snapshot(error.to_string())
}

fn non_empty_parent(path: &Path) -> Option<&Path> {
    path.parent()
        .filter(|parent| !parent.as_os_str().is_empty())
}

async fn write_snapshot_atomic(path: &Path, snapshot: &JsonSnapshot) -> Result<()> {
    let bytes = serde_json::to_vec_pretty(snapshot)?;
    let parent = non_empty_parent(path).unwrap_or_else(|| Path::new("."));
    tokio::fs::create_dir_all(parent).await?;

    let file_name = path
        .file_name()
        .ok_or_else(|| CodyError::Store(format!("invalid state path '{}'", path.display())))?
        .to_string_lossy();
    let temporary = parent.join(format!(".{file_name}.{}.tmp", uuid::Uuid::now_v7()));

    let result: Result<()> = async {
        let mut options = tokio::fs::OpenOptions::new();
        options.create_new(true).write(true);
        #[cfg(unix)]
        options.mode(0o600);
        let mut file = options.open(&temporary).await?;
        file.write_all(&bytes).await?;
        file.flush().await?;
        file.sync_all().await?;
        drop(file);
        tokio::fs::rename(&temporary, path).await?;
        sync_parent_directory(parent).await?;
        Ok(())
    }
    .await;

    if result.is_err() {
        let _ = tokio::fs::remove_file(&temporary).await;
    }
    result
}

#[cfg(unix)]
async fn sync_parent_directory(parent: &Path) -> Result<()> {
    let parent = parent.to_path_buf();
    tokio::task::spawn_blocking(move || std::fs::File::open(parent)?.sync_all())
        .await
        .map_err(|error| CodyError::Store(format!("directory sync task failed: {error}")))??;
    Ok(())
}

#[cfg(not(unix))]
async fn sync_parent_directory(_parent: &Path) -> Result<()> {
    Ok(())
}

#[async_trait]
impl StateStore for InMemoryStore {
    async fn insert_project(&self, project: Project) -> Result<Project> {
        let mut state = self.inner.write().await;
        if state.projects.contains_key(&project.id) {
            return Err(conflict(format!("project {} already exists", project.id)));
        }
        if state
            .projects
            .values()
            .any(|existing| existing.root == project.root)
        {
            return Err(conflict(format!(
                "project root '{}' is already imported",
                project.root.display()
            )));
        }

        state.projects.insert(project.id, project.clone());
        Ok(project)
    }

    async fn get_project(&self, id: ProjectId) -> Result<Project> {
        let state = self.inner.read().await;
        state
            .projects
            .get(&id)
            .cloned()
            .ok_or(CodyError::ProjectNotFound(id))
    }

    async fn list_projects(&self) -> Result<Vec<Project>> {
        let state = self.inner.read().await;
        let mut projects: Vec<_> = state.projects.values().cloned().collect();
        projects.sort_by(|left, right| {
            left.created_at
                .cmp(&right.created_at)
                .then_with(|| left.id.cmp(&right.id))
        });
        Ok(projects)
    }

    async fn update_project(&self, project: Project) -> Result<Project> {
        let mut state = self.inner.write().await;
        let current = state
            .projects
            .get(&project.id)
            .ok_or(CodyError::ProjectNotFound(project.id))?;
        if current.root != project.root {
            return Err(CodyError::InvalidInput(format!(
                "project root for {} is immutable",
                project.id
            )));
        }

        state.projects.insert(project.id, project.clone());
        Ok(project)
    }

    async fn delete_project(&self, id: ProjectId) -> Result<()> {
        let mut state = self.inner.write().await;
        if !state.projects.contains_key(&id) {
            return Err(CodyError::ProjectNotFound(id));
        }

        let is_referenced = state
            .threads
            .values()
            .any(|thread| references_project(&thread.default_references, id))
            || state
                .messages
                .values()
                .any(|message| references_project(&message.references, id));
        if is_referenced {
            return Err(conflict(format!(
                "project {id} is still referenced by a thread"
            )));
        }

        state.projects.remove(&id);
        Ok(())
    }

    async fn insert_thread(&self, thread: Thread) -> Result<Thread> {
        let mut state = self.inner.write().await;
        if state.threads.contains_key(&thread.id) {
            return Err(conflict(format!("thread {} already exists", thread.id)));
        }

        validate_references(&state, thread.id, &thread.default_references)?;
        validate_thread_workspace(&state, &thread)?;

        state.threads.insert(thread.id, thread.clone());
        Ok(thread)
    }

    async fn insert_thread_with_workspace(
        &self,
        thread: Thread,
        workspace: Workspace,
    ) -> Result<(Thread, Workspace)> {
        let mut state = self.inner.write().await;
        if thread.workspace_id != workspace.id || workspace.thread_id != thread.id {
            return Err(CodyError::InvalidInput(
                "thread and workspace must reference each other".into(),
            ));
        }
        if state.threads.contains_key(&thread.id) {
            return Err(conflict(format!("thread {} already exists", thread.id)));
        }
        if state.workspaces.contains_key(&workspace.id) {
            return Err(conflict(format!(
                "workspace {} already exists",
                workspace.id
            )));
        }
        if state.workspace_by_thread.contains_key(&thread.id) {
            return Err(conflict(format!(
                "thread {} already owns a workspace",
                thread.id
            )));
        }
        validate_references(&state, thread.id, &thread.default_references)?;
        state
            .workspace_by_thread
            .insert(workspace.thread_id, workspace.id);
        state.workspaces.insert(workspace.id, workspace.clone());
        state.threads.insert(thread.id, thread.clone());
        Ok((thread, workspace))
    }

    async fn get_thread(&self, id: ThreadId) -> Result<Thread> {
        let state = self.inner.read().await;
        state
            .threads
            .get(&id)
            .cloned()
            .ok_or(CodyError::ThreadNotFound(id))
    }

    async fn list_threads(&self) -> Result<Vec<Thread>> {
        let state = self.inner.read().await;
        let mut threads: Vec<_> = state.threads.values().cloned().collect();
        threads.sort_by(|left, right| {
            left.created_at
                .cmp(&right.created_at)
                .then_with(|| left.id.cmp(&right.id))
        });
        Ok(threads)
    }

    async fn update_thread(&self, thread: Thread) -> Result<Thread> {
        let mut state = self.inner.write().await;
        let current = state
            .threads
            .get(&thread.id)
            .ok_or(CodyError::ThreadNotFound(thread.id))?;
        if current.workspace_id != thread.workspace_id {
            return Err(conflict(format!(
                "workspace association for thread {} is immutable",
                thread.id
            )));
        }
        if current.status != thread.status {
            return Err(CodyError::InvalidInput(format!(
                "thread status changes must use transition_thread_status (current={:?}, requested={:?})",
                current.status, thread.status
            )));
        }

        validate_references(&state, thread.id, &thread.default_references)?;
        validate_thread_workspace(&state, &thread)?;
        state.threads.insert(thread.id, thread.clone());
        Ok(thread)
    }

    async fn transition_thread_status(
        &self,
        id: ThreadId,
        expected: ThreadStatus,
        next: ThreadStatus,
    ) -> Result<Thread> {
        let mut state = self.inner.write().await;
        let thread = state
            .threads
            .get_mut(&id)
            .ok_or(CodyError::ThreadNotFound(id))?;
        if thread.status != expected {
            return Err(stale_status("thread", id, expected, thread.status));
        }
        if !legal_thread_transition(expected, next) {
            return Err(CodyError::InvalidInput(format!(
                "illegal thread status transition: {expected:?} -> {next:?}"
            )));
        }

        thread.status = next;
        thread.updated_at = chrono::Utc::now();
        Ok(thread.clone())
    }

    async fn delete_thread(&self, id: ThreadId) -> Result<()> {
        let mut state = self.inner.write().await;
        let thread = state
            .threads
            .get(&id)
            .cloned()
            .ok_or(CodyError::ThreadNotFound(id))?;

        let is_referenced = state.threads.values().any(|candidate| {
            candidate.id != id && references_thread(&candidate.default_references, id)
        }) || state
            .messages
            .values()
            .any(|message| message.thread_id != id && references_thread(&message.references, id));
        if is_referenced {
            return Err(conflict(format!(
                "thread {id} is still referenced by another thread"
            )));
        }

        state.threads.remove(&id);
        state.workspaces.remove(&thread.workspace_id);
        state.workspace_by_thread.remove(&id);

        if let Some(message_ids) = state.message_order_by_thread.remove(&id) {
            for message_id in message_ids {
                state.messages.remove(&message_id);
            }
        }
        if let Some(turn_ids) = state.turn_order_by_thread.remove(&id) {
            for turn_id in turn_ids {
                state.turns.remove(&turn_id);
            }
        }
        Ok(())
    }

    async fn insert_workspace(&self, workspace: Workspace) -> Result<Workspace> {
        let mut state = self.inner.write().await;
        if state.workspaces.contains_key(&workspace.id) {
            return Err(conflict(format!(
                "workspace {} already exists",
                workspace.id
            )));
        }
        if let Some(existing_id) = state.workspace_by_thread.get(&workspace.thread_id) {
            return Err(conflict(format!(
                "thread {} already owns workspace {}",
                workspace.thread_id, existing_id
            )));
        }
        if let Some(thread) = state.threads.get(&workspace.thread_id) {
            if thread.workspace_id != workspace.id {
                return Err(conflict(format!(
                    "thread {} expects workspace {}, not {}",
                    thread.id, thread.workspace_id, workspace.id
                )));
            }
        }

        state
            .workspace_by_thread
            .insert(workspace.thread_id, workspace.id);
        state.workspaces.insert(workspace.id, workspace.clone());
        Ok(workspace)
    }

    async fn get_workspace(&self, id: WorkspaceId) -> Result<Workspace> {
        let state = self.inner.read().await;
        state
            .workspaces
            .get(&id)
            .cloned()
            .ok_or(CodyError::WorkspaceNotFound(id))
    }

    async fn get_workspace_for_thread(&self, thread_id: ThreadId) -> Result<Workspace> {
        let state = self.inner.read().await;
        let thread = state
            .threads
            .get(&thread_id)
            .ok_or(CodyError::ThreadNotFound(thread_id))?;
        state
            .workspaces
            .get(&thread.workspace_id)
            .cloned()
            .ok_or(CodyError::WorkspaceNotFound(thread.workspace_id))
    }

    async fn list_workspaces(&self) -> Result<Vec<Workspace>> {
        let state = self.inner.read().await;
        let mut workspaces: Vec<_> = state.workspaces.values().cloned().collect();
        workspaces.sort_by(|left, right| {
            left.created_at
                .cmp(&right.created_at)
                .then_with(|| left.id.cmp(&right.id))
        });
        Ok(workspaces)
    }

    async fn update_workspace(&self, workspace: Workspace) -> Result<Workspace> {
        let mut state = self.inner.write().await;
        let current = state
            .workspaces
            .get(&workspace.id)
            .ok_or(CodyError::WorkspaceNotFound(workspace.id))?;
        if current.thread_id != workspace.thread_id {
            return Err(conflict(format!(
                "thread association for workspace {} is immutable",
                workspace.id
            )));
        }
        if let Some(thread) = state.threads.get(&workspace.thread_id) {
            if thread.workspace_id != workspace.id {
                return Err(conflict(format!(
                    "thread {} expects workspace {}, not {}",
                    thread.id, thread.workspace_id, workspace.id
                )));
            }
        }

        state.workspaces.insert(workspace.id, workspace.clone());
        Ok(workspace)
    }

    async fn delete_workspace(&self, id: WorkspaceId) -> Result<()> {
        let mut state = self.inner.write().await;
        let workspace = state
            .workspaces
            .get(&id)
            .cloned()
            .ok_or(CodyError::WorkspaceNotFound(id))?;
        if state.threads.contains_key(&workspace.thread_id) {
            return Err(conflict(format!(
                "workspace {id} is owned by thread {}; delete the thread instead",
                workspace.thread_id
            )));
        }

        state.workspaces.remove(&id);
        state.workspace_by_thread.remove(&workspace.thread_id);
        Ok(())
    }

    async fn append_message(&self, message: Message) -> Result<Message> {
        let mut state = self.inner.write().await;
        if state.messages.contains_key(&message.id) {
            return Err(conflict(format!("message {} already exists", message.id)));
        }
        validate_message(&state, &message)?;

        state
            .message_order_by_thread
            .entry(message.thread_id)
            .or_default()
            .push(message.id);
        state.messages.insert(message.id, message.clone());
        Ok(message)
    }

    async fn get_message(&self, id: MessageId) -> Result<Message> {
        let state = self.inner.read().await;
        state
            .messages
            .get(&id)
            .cloned()
            .ok_or(CodyError::MessageNotFound(id))
    }

    async fn list_messages(&self, thread_id: ThreadId) -> Result<Vec<Message>> {
        let state = self.inner.read().await;
        if !state.threads.contains_key(&thread_id) {
            return Err(CodyError::ThreadNotFound(thread_id));
        }

        Ok(state
            .message_order_by_thread
            .get(&thread_id)
            .into_iter()
            .flatten()
            .filter_map(|id| state.messages.get(id).cloned())
            .collect())
    }

    async fn update_message(&self, message: Message) -> Result<Message> {
        let mut state = self.inner.write().await;
        let current = state
            .messages
            .get(&message.id)
            .ok_or(CodyError::MessageNotFound(message.id))?;
        if current.thread_id != message.thread_id {
            return Err(conflict(format!(
                "thread association for message {} is immutable",
                message.id
            )));
        }

        validate_message(&state, &message)?;
        state.messages.insert(message.id, message.clone());
        Ok(message)
    }

    async fn delete_message(&self, id: MessageId) -> Result<()> {
        let mut state = self.inner.write().await;
        let message = state
            .messages
            .get(&id)
            .cloned()
            .ok_or(CodyError::MessageNotFound(id))?;

        if state.turns.values().any(|turn| turn.input_message_id == id) {
            return Err(conflict(format!(
                "message {id} is the input of an existing turn"
            )));
        }
        if state
            .threads
            .values()
            .any(|thread| references_message(&thread.default_references, id))
            || state
                .messages
                .values()
                .any(|candidate| references_message(&candidate.references, id))
        {
            return Err(conflict(format!(
                "message {id} is selected by a thread reference"
            )));
        }

        state.messages.remove(&id);
        if let Some(order) = state.message_order_by_thread.get_mut(&message.thread_id) {
            order.retain(|candidate| *candidate != id);
        }
        Ok(())
    }

    async fn insert_turn(&self, turn: Turn) -> Result<Turn> {
        let mut state = self.inner.write().await;
        if state.turns.contains_key(&turn.id) {
            return Err(conflict(format!("turn {} already exists", turn.id)));
        }
        validate_turn(&state, &turn)?;

        state
            .turn_order_by_thread
            .entry(turn.thread_id)
            .or_default()
            .push(turn.id);
        state.turns.insert(turn.id, turn.clone());
        Ok(turn)
    }

    async fn get_turn(&self, id: TurnId) -> Result<Turn> {
        let state = self.inner.read().await;
        state
            .turns
            .get(&id)
            .cloned()
            .ok_or(CodyError::TurnNotFound(id))
    }

    async fn list_turns(&self, thread_id: ThreadId) -> Result<Vec<Turn>> {
        let state = self.inner.read().await;
        if !state.threads.contains_key(&thread_id) {
            return Err(CodyError::ThreadNotFound(thread_id));
        }

        Ok(state
            .turn_order_by_thread
            .get(&thread_id)
            .into_iter()
            .flatten()
            .filter_map(|id| state.turns.get(id).cloned())
            .collect())
    }

    async fn update_turn(&self, turn: Turn) -> Result<Turn> {
        let mut state = self.inner.write().await;
        let current = state
            .turns
            .get(&turn.id)
            .ok_or(CodyError::TurnNotFound(turn.id))?;
        if current.thread_id != turn.thread_id || current.input_message_id != turn.input_message_id
        {
            return Err(conflict(format!(
                "thread and input message associations for turn {} are immutable",
                turn.id
            )));
        }
        if current.status != turn.status {
            return Err(CodyError::InvalidInput(format!(
                "turn status changes must use transition_turn_status (current={:?}, requested={:?})",
                current.status, turn.status
            )));
        }

        validate_turn(&state, &turn)?;
        state.turns.insert(turn.id, turn.clone());
        Ok(turn)
    }

    async fn transition_turn_status(
        &self,
        id: TurnId,
        expected: TurnStatus,
        next: TurnStatus,
    ) -> Result<Turn> {
        let mut state = self.inner.write().await;
        let turn = state
            .turns
            .get_mut(&id)
            .ok_or(CodyError::TurnNotFound(id))?;
        if turn.status != expected {
            return Err(stale_status("turn", id, expected, turn.status));
        }
        if !legal_turn_transition(expected, next) {
            return Err(CodyError::InvalidInput(format!(
                "illegal turn status transition: {expected:?} -> {next:?}"
            )));
        }

        let now = chrono::Utc::now();
        turn.status = next;
        match next {
            TurnStatus::Running => turn.started_at = Some(now),
            TurnStatus::Completed | TurnStatus::Failed | TurnStatus::Cancelled => {
                turn.completed_at = Some(now);
            }
            TurnStatus::Queued => {}
        }
        Ok(turn.clone())
    }

    async fn delete_turn(&self, id: TurnId) -> Result<()> {
        let mut state = self.inner.write().await;
        let turn = state
            .turns
            .get(&id)
            .cloned()
            .ok_or(CodyError::TurnNotFound(id))?;
        if state
            .messages
            .values()
            .any(|message| message.turn_id == Some(id))
        {
            return Err(conflict(format!("turn {id} still has associated messages")));
        }

        state.turns.remove(&id);
        if let Some(order) = state.turn_order_by_thread.get_mut(&turn.thread_id) {
            order.retain(|candidate| *candidate != id);
        }
        Ok(())
    }
}

#[async_trait]
impl StateStore for JsonFileStore {
    async fn insert_project(&self, project: Project) -> Result<Project> {
        persistent_mutation!(self, candidate, candidate.insert_project(project).await)
    }

    async fn get_project(&self, id: ProjectId) -> Result<Project> {
        self.memory.get_project(id).await
    }

    async fn list_projects(&self) -> Result<Vec<Project>> {
        self.memory.list_projects().await
    }

    async fn update_project(&self, project: Project) -> Result<Project> {
        persistent_mutation!(self, candidate, candidate.update_project(project).await)
    }

    async fn delete_project(&self, id: ProjectId) -> Result<()> {
        persistent_mutation!(self, candidate, candidate.delete_project(id).await)
    }

    async fn insert_thread(&self, thread: Thread) -> Result<Thread> {
        persistent_mutation!(self, candidate, candidate.insert_thread(thread).await)
    }

    async fn insert_thread_with_workspace(
        &self,
        thread: Thread,
        workspace: Workspace,
    ) -> Result<(Thread, Workspace)> {
        persistent_mutation!(
            self,
            candidate,
            candidate
                .insert_thread_with_workspace(thread, workspace)
                .await
        )
    }

    async fn get_thread(&self, id: ThreadId) -> Result<Thread> {
        self.memory.get_thread(id).await
    }

    async fn list_threads(&self) -> Result<Vec<Thread>> {
        self.memory.list_threads().await
    }

    async fn update_thread(&self, thread: Thread) -> Result<Thread> {
        persistent_mutation!(self, candidate, candidate.update_thread(thread).await)
    }

    async fn transition_thread_status(
        &self,
        id: ThreadId,
        expected: ThreadStatus,
        next: ThreadStatus,
    ) -> Result<Thread> {
        persistent_mutation!(
            self,
            candidate,
            candidate.transition_thread_status(id, expected, next).await
        )
    }

    async fn delete_thread(&self, id: ThreadId) -> Result<()> {
        persistent_mutation!(self, candidate, candidate.delete_thread(id).await)
    }

    async fn insert_workspace(&self, workspace: Workspace) -> Result<Workspace> {
        persistent_mutation!(self, candidate, candidate.insert_workspace(workspace).await)
    }

    async fn get_workspace(&self, id: WorkspaceId) -> Result<Workspace> {
        self.memory.get_workspace(id).await
    }

    async fn get_workspace_for_thread(&self, thread_id: ThreadId) -> Result<Workspace> {
        self.memory.get_workspace_for_thread(thread_id).await
    }

    async fn list_workspaces(&self) -> Result<Vec<Workspace>> {
        self.memory.list_workspaces().await
    }

    async fn update_workspace(&self, workspace: Workspace) -> Result<Workspace> {
        persistent_mutation!(self, candidate, candidate.update_workspace(workspace).await)
    }

    async fn delete_workspace(&self, id: WorkspaceId) -> Result<()> {
        persistent_mutation!(self, candidate, candidate.delete_workspace(id).await)
    }

    async fn append_message(&self, message: Message) -> Result<Message> {
        persistent_mutation!(self, candidate, candidate.append_message(message).await)
    }

    async fn get_message(&self, id: MessageId) -> Result<Message> {
        self.memory.get_message(id).await
    }

    async fn list_messages(&self, thread_id: ThreadId) -> Result<Vec<Message>> {
        self.memory.list_messages(thread_id).await
    }

    async fn update_message(&self, message: Message) -> Result<Message> {
        persistent_mutation!(self, candidate, candidate.update_message(message).await)
    }

    async fn delete_message(&self, id: MessageId) -> Result<()> {
        persistent_mutation!(self, candidate, candidate.delete_message(id).await)
    }

    async fn insert_turn(&self, turn: Turn) -> Result<Turn> {
        persistent_mutation!(self, candidate, candidate.insert_turn(turn).await)
    }

    async fn get_turn(&self, id: TurnId) -> Result<Turn> {
        self.memory.get_turn(id).await
    }

    async fn list_turns(&self, thread_id: ThreadId) -> Result<Vec<Turn>> {
        self.memory.list_turns(thread_id).await
    }

    async fn update_turn(&self, turn: Turn) -> Result<Turn> {
        persistent_mutation!(self, candidate, candidate.update_turn(turn).await)
    }

    async fn transition_turn_status(
        &self,
        id: TurnId,
        expected: TurnStatus,
        next: TurnStatus,
    ) -> Result<Turn> {
        persistent_mutation!(
            self,
            candidate,
            candidate.transition_turn_status(id, expected, next).await
        )
    }

    async fn delete_turn(&self, id: TurnId) -> Result<()> {
        persistent_mutation!(self, candidate, candidate.delete_turn(id).await)
    }
}

fn conflict(message: impl Into<String>) -> CodyError {
    CodyError::Conflict(message.into())
}

fn stale_status(
    entity: &str,
    id: impl std::fmt::Display,
    expected: impl std::fmt::Debug,
    actual: impl std::fmt::Debug,
) -> CodyError {
    conflict(format!(
        "stale {entity} {id} status: expected {expected:?}, found {actual:?}"
    ))
}

fn legal_thread_transition(expected: ThreadStatus, next: ThreadStatus) -> bool {
    matches!(
        (expected, next),
        (ThreadStatus::Idle, ThreadStatus::Running)
            | (ThreadStatus::Running, ThreadStatus::Idle)
            | (ThreadStatus::Idle, ThreadStatus::Archived)
    )
}

fn legal_turn_transition(expected: TurnStatus, next: TurnStatus) -> bool {
    matches!(
        (expected, next),
        (TurnStatus::Queued, TurnStatus::Running)
            | (
                TurnStatus::Running,
                TurnStatus::Completed | TurnStatus::Failed | TurnStatus::Cancelled
            )
    )
}

fn validate_thread_workspace(state: &StoreState, thread: &Thread) -> Result<()> {
    if let Some(workspace) = state.workspaces.get(&thread.workspace_id) {
        if workspace.thread_id != thread.id {
            return Err(conflict(format!(
                "workspace {} belongs to thread {}, not {}",
                workspace.id, workspace.thread_id, thread.id
            )));
        }
    }
    if let Some(workspace_id) = state.workspace_by_thread.get(&thread.id) {
        if *workspace_id != thread.workspace_id {
            return Err(conflict(format!(
                "thread {} already owns workspace {}",
                thread.id, workspace_id
            )));
        }
    }
    Ok(())
}

fn validate_message(state: &StoreState, message: &Message) -> Result<()> {
    if !state.threads.contains_key(&message.thread_id) {
        return Err(CodyError::ThreadNotFound(message.thread_id));
    }
    if let Some(turn_id) = message.turn_id {
        let turn = state
            .turns
            .get(&turn_id)
            .ok_or(CodyError::TurnNotFound(turn_id))?;
        if turn.thread_id != message.thread_id {
            return Err(conflict(format!(
                "turn {turn_id} belongs to a different thread than message {}",
                message.id
            )));
        }
    }
    validate_references(state, message.thread_id, &message.references)
}

fn validate_turn(state: &StoreState, turn: &Turn) -> Result<()> {
    if !state.threads.contains_key(&turn.thread_id) {
        return Err(CodyError::ThreadNotFound(turn.thread_id));
    }
    let input = state
        .messages
        .get(&turn.input_message_id)
        .ok_or(CodyError::MessageNotFound(turn.input_message_id))?;
    if input.thread_id != turn.thread_id {
        return Err(conflict(format!(
            "input message {} belongs to a different thread than turn {}",
            input.id, turn.id
        )));
    }
    if let Some(message_turn_id) = input.turn_id {
        if message_turn_id != turn.id {
            return Err(conflict(format!(
                "input message {} is associated with turn {}",
                input.id, message_turn_id
            )));
        }
    }
    Ok(())
}

fn validate_references(
    state: &StoreState,
    owner_thread_id: ThreadId,
    references: &[ContextReference],
) -> Result<()> {
    for reference in references {
        match reference {
            ContextReference::Project { project_id, .. } => {
                if !state.projects.contains_key(project_id) {
                    return Err(CodyError::ProjectNotFound(*project_id));
                }
            }
            ContextReference::Thread {
                thread_id,
                mode,
                message_ids,
            } => {
                if *thread_id == owner_thread_id {
                    return Err(conflict(format!(
                        "thread {owner_thread_id} cannot reference itself"
                    )));
                }
                if !state.threads.contains_key(thread_id) {
                    return Err(CodyError::ThreadNotFound(*thread_id));
                }
                if *mode == crate::domain::ThreadReferenceMode::Messages {
                    if message_ids.is_empty() {
                        return Err(CodyError::InvalidInput(
                            "thread reference mode 'messages' requires message_ids".into(),
                        ));
                    }
                    for message_id in message_ids {
                        let message = state
                            .messages
                            .get(message_id)
                            .ok_or(CodyError::MessageNotFound(*message_id))?;
                        if message.thread_id != *thread_id {
                            return Err(conflict(format!(
                                "message {message_id} does not belong to referenced thread {thread_id}"
                            )));
                        }
                    }
                } else if !message_ids.is_empty() {
                    return Err(CodyError::InvalidInput(
                        "message_ids is only valid for thread reference mode 'messages'".into(),
                    ));
                }
            }
        }
    }
    Ok(())
}

fn references_project(references: &[ContextReference], id: ProjectId) -> bool {
    references.iter().any(|reference| {
        matches!(
            reference,
            ContextReference::Project { project_id, .. } if *project_id == id
        )
    })
}

fn references_thread(references: &[ContextReference], id: ThreadId) -> bool {
    references.iter().any(|reference| {
        matches!(
            reference,
            ContextReference::Thread { thread_id, .. } if *thread_id == id
        )
    })
}

fn references_message(references: &[ContextReference], id: MessageId) -> bool {
    references.iter().any(|reference| match reference {
        ContextReference::Thread {
            mode: crate::domain::ThreadReferenceMode::Messages,
            message_ids,
            ..
        } => message_ids.contains(&id),
        _ => false,
    })
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use chrono::{TimeZone, Utc};
    use uuid::Uuid;

    use super::*;
    use crate::domain::{
        MessagePart, MessageRole, ProjectAccess, ProjectKind, ThreadReferenceMode,
    };

    fn timestamp(second: i64) -> chrono::DateTime<Utc> {
        Utc.timestamp_opt(second, 0).single().unwrap()
    }

    fn project(id: u128, created_at: i64) -> Project {
        Project {
            id: ProjectId(Uuid::from_u128(id)),
            name: format!("project-{id}"),
            root: PathBuf::from(format!("/project/{id}")),
            kind: ProjectKind::Directory,
            git: None,
            created_at: timestamp(created_at),
        }
    }

    fn thread_and_workspace(
        thread_id: u128,
        workspace_id: u128,
        created_at: i64,
    ) -> (Thread, Workspace) {
        let thread_id = ThreadId(Uuid::from_u128(thread_id));
        let workspace_id = WorkspaceId(Uuid::from_u128(workspace_id));
        (
            Thread {
                id: thread_id,
                title: format!("thread-{thread_id}"),
                workspace_id,
                status: ThreadStatus::Idle,
                default_references: Vec::new(),
                summary: None,
                created_at: timestamp(created_at),
                updated_at: timestamp(created_at),
            },
            Workspace {
                id: workspace_id,
                thread_id,
                root: PathBuf::from(format!("/workspace/{workspace_id}")),
                created_at: timestamp(created_at),
            },
        )
    }

    fn message(id: u128, thread_id: ThreadId, created_at: i64) -> Message {
        Message {
            id: MessageId(Uuid::from_u128(id)),
            thread_id,
            turn_id: None,
            role: MessageRole::User,
            parts: vec![MessagePart::Text {
                text: format!("message-{id}"),
            }],
            references: Vec::new(),
            created_at: timestamp(created_at),
        }
    }

    async fn seed_thread(
        store: &dyn StateStore,
        thread_id: u128,
        workspace_id: u128,
        created_at: i64,
    ) -> (Thread, Workspace) {
        let (thread, workspace) = thread_and_workspace(thread_id, workspace_id, created_at);
        store
            .insert_thread_with_workspace(thread.clone(), workspace.clone())
            .await
            .unwrap();
        (thread, workspace)
    }

    #[tokio::test]
    async fn clone_shares_state_and_lists_are_deterministic() {
        let store = InMemoryStore::new();
        let clone = store.clone();

        store.insert_project(project(2, 20)).await.unwrap();
        store.insert_project(project(3, 10)).await.unwrap();
        store.insert_project(project(1, 10)).await.unwrap();

        let ids: Vec<_> = clone
            .list_projects()
            .await
            .unwrap()
            .into_iter()
            .map(|project| project.id)
            .collect();
        assert_eq!(
            ids,
            vec![
                ProjectId(Uuid::from_u128(1)),
                ProjectId(Uuid::from_u128(3)),
                ProjectId(Uuid::from_u128(2)),
            ]
        );
    }

    #[tokio::test]
    async fn message_history_uses_append_order_not_timestamps() {
        let store: Arc<dyn StateStore> = Arc::new(InMemoryStore::new());
        let (thread, _) = seed_thread(store.as_ref(), 1, 2, 1).await;
        let first = message(10, thread.id, 20);
        let second = message(11, thread.id, 10);

        store.append_message(first.clone()).await.unwrap();
        store.append_message(second.clone()).await.unwrap();

        assert_eq!(
            store.list_messages(thread.id).await.unwrap(),
            vec![first, second]
        );
    }

    #[tokio::test]
    async fn rejects_duplicate_ids_and_a_second_workspace() {
        let store = InMemoryStore::new();
        let (thread, _) = seed_thread(&store, 1, 2, 1).await;

        let duplicate = store.insert_thread(thread.clone()).await.unwrap_err();
        assert!(matches!(duplicate, CodyError::Conflict(_)));

        let second_workspace = Workspace {
            id: WorkspaceId(Uuid::from_u128(3)),
            thread_id: thread.id,
            root: PathBuf::from("/workspace/second"),
            created_at: timestamp(2),
        };
        let error = store.insert_workspace(second_workspace).await.unwrap_err();
        assert!(matches!(error, CodyError::Conflict(_)));
    }

    #[tokio::test]
    async fn validates_references_and_turn_ownership() {
        let store = InMemoryStore::new();
        let (source, _) = seed_thread(&store, 1, 2, 1).await;
        let (current, _) = seed_thread(&store, 3, 4, 2).await;
        let source_message = message(10, source.id, 3);
        store.append_message(source_message.clone()).await.unwrap();

        let project = project(20, 4);
        store.insert_project(project.clone()).await.unwrap();

        let mut referenced = message(11, current.id, 5);
        referenced.references = vec![
            ContextReference::Thread {
                thread_id: source.id,
                mode: ThreadReferenceMode::Messages,
                message_ids: vec![source_message.id],
            },
            ContextReference::Project {
                project_id: project.id,
                access: ProjectAccess::ReadWrite,
            },
        ];
        store.append_message(referenced.clone()).await.unwrap();

        let turn = Turn {
            id: TurnId(Uuid::from_u128(30)),
            thread_id: current.id,
            input_message_id: referenced.id,
            provider: "test".into(),
            model: "test-model".into(),
            temperature: None,
            max_output_tokens: None,
            status: TurnStatus::Queued,
            created_at: timestamp(6),
            started_at: None,
            completed_at: None,
            error: None,
        };
        store.insert_turn(turn.clone()).await.unwrap();

        store
            .transition_turn_status(turn.id, TurnStatus::Queued, TurnStatus::Running)
            .await
            .unwrap();
        let updated = store
            .transition_turn_status(turn.id, TurnStatus::Running, TurnStatus::Completed)
            .await
            .unwrap();
        assert_eq!(store.get_turn(turn.id).await.unwrap(), updated);

        let mut wrong_thread = turn;
        wrong_thread.id = TurnId(Uuid::from_u128(31));
        wrong_thread.thread_id = source.id;
        let error = store.insert_turn(wrong_thread).await.unwrap_err();
        assert!(matches!(error, CodyError::Conflict(_)));
    }

    #[tokio::test]
    async fn referenced_thread_cannot_be_deleted() {
        let store = InMemoryStore::new();
        let (source, _) = seed_thread(&store, 1, 2, 1).await;
        let (current, _) = seed_thread(&store, 3, 4, 2).await;
        let mut referencing_message = message(10, current.id, 3);
        referencing_message.references = vec![ContextReference::Thread {
            thread_id: source.id,
            mode: ThreadReferenceMode::Summary,
            message_ids: Vec::new(),
        }];
        store
            .append_message(referencing_message.clone())
            .await
            .unwrap();

        assert!(matches!(
            store.delete_thread(source.id).await.unwrap_err(),
            CodyError::Conflict(_)
        ));

        store.delete_message(referencing_message.id).await.unwrap();
        store.delete_thread(source.id).await.unwrap();
        assert!(matches!(
            store.get_thread(source.id).await.unwrap_err(),
            CodyError::ThreadNotFound(id) if id == source.id
        ));
    }

    #[tokio::test]
    async fn thread_status_transition_rejects_stale_and_illegal_updates() {
        let store = InMemoryStore::new();
        let (thread, _) = seed_thread(&store, 1, 2, 1).await;

        let running = store
            .transition_thread_status(thread.id, ThreadStatus::Idle, ThreadStatus::Running)
            .await
            .unwrap();
        assert_eq!(running.status, ThreadStatus::Running);

        assert!(matches!(
            store
                .transition_thread_status(thread.id, ThreadStatus::Idle, ThreadStatus::Running,)
                .await
                .unwrap_err(),
            CodyError::Conflict(_)
        ));
        assert!(matches!(
            store
                .transition_thread_status(thread.id, ThreadStatus::Running, ThreadStatus::Archived,)
                .await
                .unwrap_err(),
            CodyError::InvalidInput(_)
        ));

        store
            .transition_thread_status(thread.id, ThreadStatus::Running, ThreadStatus::Idle)
            .await
            .unwrap();
        let archived = store
            .transition_thread_status(thread.id, ThreadStatus::Idle, ThreadStatus::Archived)
            .await
            .unwrap();
        assert_eq!(archived.status, ThreadStatus::Archived);
    }

    #[tokio::test]
    async fn only_one_concurrent_turn_claim_succeeds() {
        let store = InMemoryStore::new();
        let (thread, _) = seed_thread(&store, 1, 2, 1).await;
        let input = message(10, thread.id, 2);
        store.append_message(input.clone()).await.unwrap();
        let turn = Turn {
            id: TurnId(Uuid::from_u128(20)),
            thread_id: thread.id,
            input_message_id: input.id,
            provider: "test".into(),
            model: "test-model".into(),
            temperature: None,
            max_output_tokens: None,
            status: TurnStatus::Queued,
            created_at: timestamp(3),
            started_at: None,
            completed_at: None,
            error: None,
        };
        store.insert_turn(turn.clone()).await.unwrap();

        let first_store = store.clone();
        let second_store = store.clone();
        let (first, second) = tokio::join!(
            first_store.transition_turn_status(turn.id, TurnStatus::Queued, TurnStatus::Running,),
            second_store.transition_turn_status(turn.id, TurnStatus::Queued, TurnStatus::Running,),
        );

        let results = [first, second];
        assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
        assert_eq!(
            results
                .iter()
                .filter(|result| matches!(result, Err(CodyError::Conflict(_))))
                .count(),
            1
        );
        assert!(store.get_turn(turn.id).await.unwrap().started_at.is_some());

        let completed = store
            .transition_turn_status(turn.id, TurnStatus::Running, TurnStatus::Completed)
            .await
            .unwrap();
        assert_eq!(completed.status, TurnStatus::Completed);
        assert!(completed.completed_at.is_some());
        assert!(matches!(
            store
                .transition_turn_status(turn.id, TurnStatus::Running, TurnStatus::Failed)
                .await
                .unwrap_err(),
            CodyError::Conflict(_)
        ));
    }

    #[tokio::test]
    async fn json_store_survives_restart_with_order_and_statuses() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("state.json");
        let store = JsonFileStore::open(&path).await.unwrap();

        let project = project(100, 1);
        store.insert_project(project.clone()).await.unwrap();

        let (mut thread, workspace) = thread_and_workspace(1, 2, 2);
        thread.default_references = vec![ContextReference::Project {
            project_id: project.id,
            access: ProjectAccess::ReadWrite,
        }];
        store
            .insert_thread_with_workspace(thread.clone(), workspace.clone())
            .await
            .unwrap();

        let input = message(10, thread.id, 20);
        store.append_message(input.clone()).await.unwrap();
        let turn = Turn {
            id: TurnId(Uuid::from_u128(20)),
            thread_id: thread.id,
            input_message_id: input.id,
            provider: "test".into(),
            model: "test-model".into(),
            temperature: Some(0.25),
            max_output_tokens: Some(512),
            status: TurnStatus::Queued,
            created_at: timestamp(4),
            started_at: None,
            completed_at: None,
            error: None,
        };
        store.insert_turn(turn.clone()).await.unwrap();

        let mut assistant = message(11, thread.id, 10);
        assistant.role = MessageRole::Assistant;
        assistant.turn_id = Some(turn.id);
        store.append_message(assistant.clone()).await.unwrap();

        store
            .transition_thread_status(thread.id, ThreadStatus::Idle, ThreadStatus::Running)
            .await
            .unwrap();
        store
            .transition_thread_status(thread.id, ThreadStatus::Running, ThreadStatus::Idle)
            .await
            .unwrap();
        let archived = store
            .transition_thread_status(thread.id, ThreadStatus::Idle, ThreadStatus::Archived)
            .await
            .unwrap();
        let running = store
            .transition_turn_status(turn.id, TurnStatus::Queued, TurnStatus::Running)
            .await
            .unwrap();
        let completed = store
            .transition_turn_status(turn.id, TurnStatus::Running, TurnStatus::Completed)
            .await
            .unwrap();

        drop(store);
        let reopened = JsonFileStore::open(&path).await.unwrap();
        assert_eq!(reopened.get_project(project.id).await.unwrap(), project);
        assert_eq!(
            reopened.get_workspace(workspace.id).await.unwrap(),
            workspace
        );
        assert_eq!(reopened.get_thread(thread.id).await.unwrap(), archived);
        assert_eq!(
            reopened.list_messages(thread.id).await.unwrap(),
            vec![input, assistant]
        );
        assert_eq!(reopened.get_turn(turn.id).await.unwrap(), completed);
        assert_eq!(completed.started_at, running.started_at);

        let raw: serde_json::Value =
            serde_json::from_slice(&tokio::fs::read(path).await.unwrap()).unwrap();
        assert_eq!(raw["version"], JSON_SNAPSHOT_VERSION);
    }

    #[tokio::test]
    async fn json_store_rejects_malformed_snapshot() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("state.json");
        tokio::fs::write(&path, b"{ definitely not json")
            .await
            .unwrap();

        let error = JsonFileStore::open(path).await.unwrap_err();
        assert!(matches!(error, CodyError::Store(message) if message.contains("failed to parse")));
    }

    #[tokio::test]
    async fn json_store_rejects_broken_relationships_on_open() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("state.json");
        let store = JsonFileStore::open(&path).await.unwrap();
        let (thread, workspace) = thread_and_workspace(1, 2, 1);
        store
            .insert_thread_with_workspace(thread.clone(), workspace)
            .await
            .unwrap();
        store
            .append_message(message(10, thread.id, 2))
            .await
            .unwrap();
        drop(store);

        let mut snapshot: serde_json::Value =
            serde_json::from_slice(&tokio::fs::read(&path).await.unwrap()).unwrap();
        snapshot["messages"][0]["thread_id"] =
            serde_json::to_value(ThreadId(Uuid::from_u128(999))).unwrap();
        tokio::fs::write(&path, serde_json::to_vec_pretty(&snapshot).unwrap())
            .await
            .unwrap();

        let error = JsonFileStore::open(path).await.unwrap_err();
        assert!(matches!(error, CodyError::Store(message) if message.contains("missing thread")));
    }
}
