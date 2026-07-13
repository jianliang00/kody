import { MessageCircle } from 'lucide-react'

export function DraftConversation() {
  return (
    <section className="draft-conversation" aria-labelledby="draft-conversation-title">
      <span className="thread-welcome__mark" aria-hidden="true">
        <MessageCircle size={21} />
      </span>
      <p className="eyebrow">New conversation</p>
      <h2 id="draft-conversation-title">What should Cody work on?</h2>
      <p>
        Write the first message below. Cody will create the Thread, prepare its Workspace, and name it from the conversation.
      </p>
    </section>
  )
}
