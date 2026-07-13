use std::collections::BTreeMap;

use kody_core::{
    AgentEvent, InteractionId, PendingUserInput, ThreadId, TurnId, UserInputAnswer,
    UserInputBroker, UserInputOption, UserInputQuestion,
};

fn request(secret: bool) -> PendingUserInput {
    PendingUserInput {
        interaction_id: InteractionId::new(),
        thread_id: ThreadId::new(),
        turn_id: TurnId::new(),
        item_id: "request-user-input-1".into(),
        questions: vec![UserInputQuestion {
            id: "choice".into(),
            header: "Approach".into(),
            question: "Which approach should I use?".into(),
            is_other: true,
            is_secret: secret,
            options: Some(vec![UserInputOption {
                label: "Recommended".into(),
                description: "Use the safe default.".into(),
            }]),
        }],
    }
}

#[tokio::test]
async fn broker_exposes_pending_metadata_and_delivers_answers_once() {
    let broker = UserInputBroker::default();
    let pending = request(false);
    let receiver = broker.register(pending.clone()).await.unwrap();

    assert_eq!(
        broker.list(Some(pending.thread_id)).await,
        vec![pending.clone()]
    );
    assert!(broker.list(Some(ThreadId::new())).await.is_empty());

    let answers = BTreeMap::from([(
        "choice".into(),
        UserInputAnswer {
            answers: vec!["A custom answer".into()],
        },
    )]);
    broker
        .respond(pending.interaction_id, answers.clone(), false)
        .await
        .unwrap();

    let resolution = receiver.await.unwrap();
    assert_eq!(resolution.answers, answers);
    assert!(!resolution.cancelled);
    assert!(broker.list(Some(pending.thread_id)).await.is_empty());
    assert!(broker
        .respond(pending.interaction_id, BTreeMap::new(), true)
        .await
        .is_err());
}

#[tokio::test]
async fn invalid_response_keeps_interaction_actionable_and_cancel_wakes_backend() {
    let broker = UserInputBroker::default();
    let pending = request(false);
    let receiver = broker.register(pending.clone()).await.unwrap();

    assert!(broker
        .respond(pending.interaction_id, BTreeMap::new(), false)
        .await
        .is_err());
    assert_eq!(broker.list(None).await, vec![pending.clone()]);

    broker
        .respond(pending.interaction_id, BTreeMap::new(), true)
        .await
        .unwrap();
    let resolution = receiver.await.unwrap();
    assert!(resolution.cancelled);
    assert!(resolution.answers.is_empty());
}

#[tokio::test]
async fn duplicate_registration_does_not_replace_the_original_waiter() {
    let broker = UserInputBroker::default();
    let pending = request(false);
    let receiver = broker.register(pending.clone()).await.unwrap();
    assert!(broker.register(pending.clone()).await.is_err());

    let answers = BTreeMap::from([(
        "choice".into(),
        UserInputAnswer {
            answers: vec!["Recommended".into()],
        },
    )]);
    broker
        .respond(pending.interaction_id, answers.clone(), false)
        .await
        .unwrap();
    assert_eq!(receiver.await.unwrap().answers, answers);
}

#[tokio::test]
async fn removing_interaction_closes_receiver_without_fabricating_an_answer() {
    let broker = UserInputBroker::default();
    let pending = request(false);
    let receiver = broker.register(pending.clone()).await.unwrap();
    broker.remove(pending.interaction_id).await;
    assert!(receiver.await.is_err());
}

#[tokio::test]
async fn terminal_turn_cleanup_only_removes_its_own_interactions() {
    let broker = UserInputBroker::default();
    let first = request(false);
    let mut second = request(false);
    second.thread_id = first.thread_id;
    let first_receiver = broker.register(first.clone()).await.unwrap();
    let _second_receiver = broker.register(second.clone()).await.unwrap();

    broker.remove_for_turn(first.turn_id).await;
    assert!(first_receiver.await.is_err());
    assert_eq!(broker.list(Some(first.thread_id)).await, vec![second]);
}

#[test]
fn secret_answer_contents_cannot_enter_public_events_or_debug_output() {
    let pending = request(true);
    let secret = "do-not-print-this";
    let resolution = kody_core::UserInputResolution {
        answers: BTreeMap::from([(
            "choice".into(),
            UserInputAnswer {
                answers: vec![secret.into()],
            },
        )]),
        cancelled: false,
    };
    assert!(!format!("{resolution:?}").contains(secret));

    let requested = AgentEvent::UserInputRequested {
        interaction_id: pending.interaction_id,
        item_id: pending.item_id,
        questions: pending.questions,
    };
    let resolved = AgentEvent::UserInputResolved {
        interaction_id: pending.interaction_id,
        cancelled: false,
    };
    assert!(!serde_json::to_string(&requested).unwrap().contains(secret));
    assert!(!serde_json::to_string(&resolved).unwrap().contains(secret));
}
