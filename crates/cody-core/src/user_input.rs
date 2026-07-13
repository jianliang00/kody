use std::{
    collections::{hash_map::Entry, BTreeMap, HashMap, HashSet},
    fmt,
    sync::Arc,
};

use serde::{Deserialize, Serialize};
use tokio::sync::{oneshot, Mutex};

use crate::{
    domain::{InteractionId, ThreadId, TurnId},
    error::{CodyError, Result},
};

/// One labelled choice offered by an external agent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UserInputOption {
    pub label: String,
    pub description: String,
}

/// A single question in an external agent's structured input request.
///
/// `is_other` allows a free-form answer in addition to `options`. Secret
/// questions are deliberately only metadata here; their answers are never
/// retained in the broker's reconnectable public snapshot.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UserInputQuestion {
    pub id: String,
    pub header: String,
    pub question: String,
    #[serde(default)]
    pub is_other: bool,
    #[serde(default)]
    pub is_secret: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub options: Option<Vec<UserInputOption>>,
}

/// Public, reconnectable metadata for an interaction that is waiting on the
/// user. Answers intentionally do not appear in this structure.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PendingUserInput {
    pub interaction_id: InteractionId,
    pub thread_id: ThreadId,
    pub turn_id: TurnId,
    pub item_id: String,
    pub questions: Vec<UserInputQuestion>,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UserInputAnswer {
    pub answers: Vec<String>,
}

impl fmt::Debug for UserInputAnswer {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("UserInputAnswer")
            .field("answer_count", &self.answers.len())
            .finish()
    }
}

/// Maps the stable question ID supplied by the agent to one or more answers.
/// This shape intentionally matches Codex App Server's response schema while
/// remaining provider-neutral.
pub type UserInputAnswers = BTreeMap<String, UserInputAnswer>;

/// Private one-shot result delivered to the backend that owns the interaction.
/// It is not serializable and its debug representation never includes answer
/// contents, which prevents secret input from leaking through routine logs.
#[derive(Clone, PartialEq, Eq)]
pub struct UserInputResolution {
    pub answers: UserInputAnswers,
    pub cancelled: bool,
}

impl fmt::Debug for UserInputResolution {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("UserInputResolution")
            .field(
                "answer_question_ids",
                &self.answers.keys().collect::<Vec<_>>(),
            )
            .field("cancelled", &self.cancelled)
            .finish()
    }
}

struct PendingUserInputEntry {
    request: PendingUserInput,
    response: oneshot::Sender<UserInputResolution>,
}

/// In-memory rendezvous between an external agent backend and reconnectable UI.
///
/// Only pending question metadata is stored. Submitted answers move directly
/// through a one-shot channel and are removed from broker state before the
/// waiting backend receives them.
#[derive(Clone, Default)]
pub struct UserInputBroker {
    pending: Arc<Mutex<HashMap<InteractionId, PendingUserInputEntry>>>,
}

impl UserInputBroker {
    pub async fn register(
        &self,
        request: PendingUserInput,
    ) -> Result<oneshot::Receiver<UserInputResolution>> {
        validate_request(&request)?;
        let interaction_id = request.interaction_id;
        let (sender, receiver) = oneshot::channel();
        let mut pending = self.pending.lock().await;
        match pending.entry(interaction_id) {
            Entry::Occupied(_) => {
                return Err(CodyError::Conflict(format!(
                    "user-input interaction {interaction_id} is already pending"
                )));
            }
            Entry::Vacant(entry) => {
                entry.insert(PendingUserInputEntry {
                    request,
                    response: sender,
                });
            }
        }
        Ok(receiver)
    }

    /// Returns public question metadata so a reconnecting client can recover a
    /// missed live event. No submitted answer is ever retained here.
    pub async fn list(&self, thread_id: Option<ThreadId>) -> Vec<PendingUserInput> {
        let mut requests = self
            .pending
            .lock()
            .await
            .values()
            .filter(|entry| thread_id.is_none_or(|id| entry.request.thread_id == id))
            .map(|entry| entry.request.clone())
            .collect::<Vec<_>>();
        requests.sort_by_key(|request| request.interaction_id);
        requests
    }

    /// Resolves a pending interaction. Answer values are validated without
    /// echoing them in errors and are sent only to the waiting backend.
    pub async fn respond(
        &self,
        interaction_id: InteractionId,
        answers: UserInputAnswers,
        cancelled: bool,
    ) -> Result<()> {
        let mut pending = self.pending.lock().await;
        let entry = pending.get(&interaction_id).ok_or_else(|| {
            CodyError::InvalidInput(format!(
                "user-input interaction {interaction_id} does not exist or was already resolved"
            ))
        })?;
        validate_answers(&entry.request.questions, &answers, cancelled)?;
        let entry = pending
            .remove(&interaction_id)
            .expect("entry was checked above");
        drop(pending);

        entry
            .response
            .send(UserInputResolution { answers, cancelled })
            .map_err(|_| {
                CodyError::Conflict(format!(
                    "user-input interaction {interaction_id} is no longer waiting"
                ))
            })
    }

    /// Removes an interaction when its owning backend exits or its Turn is
    /// cancelled. Dropping the sender wakes the receiver with a closed-channel
    /// result and does not synthesize an answer.
    pub async fn remove(&self, interaction_id: InteractionId) {
        self.pending.lock().await.remove(&interaction_id);
    }

    /// Removes every pending interaction owned by a terminal Turn. This is a
    /// runtime safety net for backend errors and panics after registration.
    pub async fn remove_for_turn(&self, turn_id: TurnId) {
        self.pending
            .lock()
            .await
            .retain(|_, entry| entry.request.turn_id != turn_id);
    }
}

fn validate_request(request: &PendingUserInput) -> Result<()> {
    if request.item_id.trim().is_empty() || request.item_id.len() > 512 {
        return Err(CodyError::InvalidInput(
            "user-input item_id must be between 1 and 512 bytes".into(),
        ));
    }
    if request.questions.is_empty() || request.questions.len() > 16 {
        return Err(CodyError::InvalidInput(
            "user-input request must contain between 1 and 16 questions".into(),
        ));
    }

    let mut question_ids = HashSet::new();
    for question in &request.questions {
        if question.id.trim().is_empty() || question.id.len() > 128 {
            return Err(CodyError::InvalidInput(
                "user-input question id must be between 1 and 128 bytes".into(),
            ));
        }
        if !question_ids.insert(question.id.as_str()) {
            return Err(CodyError::InvalidInput(
                "user-input question ids must be unique".into(),
            ));
        }
        if question.header.trim().is_empty() || question.header.len() > 256 {
            return Err(CodyError::InvalidInput(
                "user-input question header must be between 1 and 256 bytes".into(),
            ));
        }
        if question.question.trim().is_empty() || question.question.len() > 8_192 {
            return Err(CodyError::InvalidInput(
                "user-input question must be between 1 and 8,192 bytes".into(),
            ));
        }
        if let Some(options) = &question.options {
            if options.is_empty() || options.len() > 32 {
                return Err(CodyError::InvalidInput(
                    "user-input options must contain between 1 and 32 choices".into(),
                ));
            }
            let mut labels = HashSet::new();
            for option in options {
                if option.label.trim().is_empty() || option.label.len() > 512 {
                    return Err(CodyError::InvalidInput(
                        "user-input option label must be between 1 and 512 bytes".into(),
                    ));
                }
                if option.description.len() > 2_048 {
                    return Err(CodyError::InvalidInput(
                        "user-input option description exceeds 2,048 bytes".into(),
                    ));
                }
                if !labels.insert(option.label.as_str()) {
                    return Err(CodyError::InvalidInput(
                        "user-input option labels must be unique within a question".into(),
                    ));
                }
            }
        }
    }
    Ok(())
}

fn validate_answers(
    questions: &[UserInputQuestion],
    answers: &UserInputAnswers,
    cancelled: bool,
) -> Result<()> {
    if cancelled {
        if answers.is_empty() {
            return Ok(());
        }
        return Err(CodyError::InvalidInput(
            "cancelled user-input interactions cannot include answers".into(),
        ));
    }
    if answers.len() != questions.len()
        || questions
            .iter()
            .any(|question| !answers.contains_key(&question.id))
    {
        return Err(CodyError::InvalidInput(
            "user-input response must answer every requested question exactly once".into(),
        ));
    }

    let mut total_bytes = 0_usize;
    for question in questions {
        let answer = &answers[&question.id];
        if answer.answers.is_empty() || answer.answers.len() > 32 {
            return Err(CodyError::InvalidInput(
                "each user-input question must have between 1 and 32 answers".into(),
            ));
        }
        if answer
            .answers
            .iter()
            .any(|value| value.trim().is_empty() || value.len() > 32_768)
        {
            return Err(CodyError::InvalidInput(
                "user-input answer values must be between 1 and 32,768 bytes".into(),
            ));
        }
        total_bytes = answer
            .answers
            .iter()
            .try_fold(total_bytes, |total, value| total.checked_add(value.len()))
            .ok_or_else(|| CodyError::InvalidInput("user-input answers are too large".into()))?;
        if total_bytes > 512 * 1_024 {
            return Err(CodyError::InvalidInput(
                "user-input answers exceed the 512 KiB total limit".into(),
            ));
        }
        if let Some(options) = &question.options {
            let option_labels = options
                .iter()
                .map(|option| option.label.as_str())
                .collect::<HashSet<_>>();
            if !question.is_secret
                && !question.is_other
                && answer
                    .answers
                    .iter()
                    .any(|value| !option_labels.contains(value.as_str()))
            {
                return Err(CodyError::InvalidInput(
                    "user-input response contains a value outside the offered options".into(),
                ));
            }
        }
    }
    Ok(())
}
