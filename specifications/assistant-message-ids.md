+++
status = "draft"
created = 2026-10-16
last_update = 2026-10-16
+++

# Assistant message IDs

## Purpose

Give ACP clients stable identities for streamed assistant messages, including extension-initiated output without an active prompt. This supplies the adapter prerequisite for [matrix-acp-bridge PR #27](https://github.com/chadvoegele/matrix-acp-bridge/pull/27), allowing the bridge to group text by `(sessionId, messageId)` rather than prompt lifetime.

## Context

The installed `@agentclientprotocol/sdk` supports the optional `ContentChunk.messageId` field. `PiAcpSession.handlePiEvent()` currently forwards text and thinking deltas without it and ignores Pi's `message_start` and `message_end` boundaries. Its event subscription already exists independently of `pendingTurn`; IDs must preserve that behavior.

One Pi assistant response can include thinking, text, and streamed tool-call arguments. pi-acp may announce a tool before that assistant response ends. A prompt can produce multiple assistant responses through tool execution, retries, or queued continuations. Neither a tool announcement nor a prompt identifies an assistant message.

## Goals

- Identify every live Pi assistant text chunk, prompted or unsolicited.
- Preserve Pi assistant-message boundaries and ordered text-delta semantics.
- Keep identities distinct across sessions, subprocess replacement, and restoration.
- Preserve existing ACP payloads, scheduling, and prompt-completion behavior.

## Non-goals

- Implement Matrix rendering, buffering, routing, or replay suppression.
- Add message-end, turn-lifecycle, or request-correlation protocol extensions.
- Change prompt queues, steering, cancellation, or overlapping-prompt behavior.
- Provide durable message identity for history, resumable delivery, or chunk deduplication.
- Assign identities to user messages, tool calls, or adapter-generated notices in this change.

## Specification

### Wire contract

Every live `agent_message_chunk` translated from a Pi assistant text delta must contain a nonempty string `messageId` at the update's top level, alongside `sessionUpdate` and `content`. It must not be placed inside `content`, `_meta`, or the JSON-RPC envelope.

```json
{
  "sessionId": "session-1",
  "update": {
    "sessionUpdate": "agent_message_chunk",
    "messageId": "opaque-assistant-id",
    "content": { "type": "text", "text": "Hello" }
  }
}
```

All text chunks from one Pi assistant message must share an ID. A different Pi assistant message must receive a different ID, even within the same prompt or when its text is identical. Multiple text content blocks within one response must not create separate IDs.

`agent_thought_chunk` deltas from that same Pi assistant message must carry the same ID. Thought chunks remain separate from public text; clients must not concatenate reasoning into the answer merely because the ID matches. Tool updates keep their existing `toolCallId` and are not assigned an assistant `messageId`.

Text remains ordered, append-only deltas, not accumulated snapshots. Repeated IDs do not imply duplicate chunks. Do not emit empty text chunks solely to announce a start or end, or resend final accumulated text on `message_end`.

### Identity lifecycle

Track the active Pi assistant-message identity within the session's event translator, not within `PendingTurn`:

1. An assistant `message_start` opens a new identity. User and tool-result starts do not allocate or change it.
2. Assistant text and thinking deltas use that identity. If the first assistant delta arrives without a preceding start, lazily allocate an identity so legacy or minimal event producers still emit identified chunks. Subsequent deltas reuse it until a real message boundary.
3. An assistant `message_end` closes the identity after processing preceding deltas. User and tool-result ends do not close it.
4. The next assistant message receives a fresh identity, including after an aborted or failed response. An assistant start received while an identity remains active replaces that stale identity; it must never reuse it.

IDs must be opaque, generated independently of message content, timestamps, prompt IDs, and tool IDs. Random UUIDs are suitable. A session-local counter alone is insufficient: restoring the same ACP session or replacing its subprocess must not collide with identities already emitted for it. This requirement does not require persisting an identity map or reproducing IDs from an earlier process.

Thinking, text-content indexes, streamed tool arguments, tool announcements, tool execution, quiet periods, and ACP prompt responses must not themselves allocate, rotate, or close an assistant identity. Cancellation requests must not rotate an identity before any final deltas from the cancelled message arrive. Event boundaries or process/session teardown perform cleanup.

The translator must capture the ID when queuing each notification. A later message start must not change the ID on an earlier queued chunk. Retain only the current identity, not message text or a historical identity index.

### Unsolicited output and ordering

Identity allocation and forwarding must not require `pendingTurn`, an outstanding `session/prompt`, or a recent prompt response. Extension-triggered assistant messages after prompt completion must follow exactly the same translation path as prompted messages.

Keep existing per-session notification ordering and prompt-response flushing. This feature must not delay publication until message end, create synthetic prompt requests, or alter when `agent_settled` resolves a prompt.

For valid Pi streams, identified assistant messages must be sequential and non-interleaved: once text for a new assistant ID is emitted, no later text may use the preceding assistant ID. This is an adapter/Pi contract, not a guarantee supplied by ACP itself. Verify it against the supported Pi runtime, including tool cycles, retry, steering, and extension-triggered continuations. Do not infer message completion from tool activity to satisfy it.

If a runtime exposes interleaved assistant responses, that runtime is outside this specification's supported contract; supporting it requires a separate design rather than silently merging messages. Existing transport-error behavior remains unchanged; IDs do not imply successful delivery or replay guarantees.

### Notices and history

Adapter-generated text is not a Pi assistant response. Startup information, queue notices, retry/compaction status, extension notifications, unsupported-UI messages, process-error notices, and built-in command replies must remain outside the active assistant identity. They retain their existing payloads and metadata without `messageId` in this change. Inserting such a notice must not rotate the active identity or cause later model text to be grouped with the notice.

History emitted by `session/load` remains on the existing replay path without IDs. It must not allocate or mutate the live assistant identity. Restored sessions allocate fresh IDs for subsequent live assistant messages; stable historical IDs and reconstructing a pre-restart message prefix are not promised.

The bridge must continue distinguishing loading-history updates from live output. A message ID is not a replay marker, authorization token, conversation route, or evidence of an active prompt.

### Failure and cleanup

Close identity state on session disposal, deletion, or Pi subprocess exit. Obsolete subprocess events must not affect a replacement session. Keep identities independent between simultaneous sessions, including when notifications are queued concurrently.

Missing starts are handled by lazy allocation; missing ends are recovered by the next assistant start or teardown. Do not guess additional boundaries from silence or prompt completion. A stream with neither starts nor ends cannot provide reliable multi-message separation and is outside the supported boundary contract.

Do not log assistant text or reasoning to diagnose identity problems. IDs must not encode private text, paths, or credentials.

## Compatibility and migration

This is an additive use of an existing optional SDK field; it requires no ACP protocol-version change, capability negotiation, configuration, Pi modification, or stored-session schema migration. Clients ignoring IDs must receive the same content, metadata, ordering, and stop reasons as before.

Existing tests that compare complete chunk objects must account for the new field. Test behavior and identity relationships rather than fixed UUID values.

The guarantee required by bridge PR #27 covers **live Pi-generated assistant text**, not every update named `agent_message_chunk`. ID-less notices remain subject to the bridge's existing compatibility and notification-filtering behavior; unsolicited notices are not made reliably renderable by this change.

## Verification

- Multiple text deltas and text-content blocks in one assistant start/end pair share one nonempty ID and concatenate to exactly the original text.
- Thinking and text in one response share an ID while remaining distinct update kinds. Thought-only and tool-only responses do not emit empty public-text placeholders.
- Two assistant responses within one prompt, and responses across separate prompts, have distinct IDs. Identical response text does not cause ID reuse.
- Text before and after an early tool-call announcement keeps the same ID; the next actual assistant response receives a new one. User/tool-result boundaries do not affect assistant identity.
- After a prompted turn settles, an extension-triggered assistant start/delta/end sequence publishes identified text without another ACP prompt. Repeat with no prompt ever submitted.
- Slow notification delivery preserves event order and the ID captured for each queued chunk, even when the next response has already started.
- Prompt responses retain existing settling/flushing semantics. No final-text duplicate or artificial message-end chunk is emitted.
- Cancellation, partial failures, missing end events, and subprocess replacement cannot leak an old identity into a new response. A delta without a start receives a stable lazy identity.
- Simultaneous sessions remain isolated. Restoring the same session produces new live IDs without persisting identity state or changing replay payloads.
- Adapter notices interleaved between model deltas remain ID-less, preserve metadata and ordering, and do not change the surrounding model identity. Built-in replies and history replay remain unchanged.
- Component tests exercise the translator with fake Pi events; a runtime integration test verifies actual Pi assistant boundaries and sequential IDs across tool execution, retry, steering/follow-up, and an unsolicited extension continuation. Fakes alone do not establish the non-interleaving prerequisite.
- Run formatting, type checking, lint, and the existing test suite when implementing. No runtime implementation is included in this proposal.

## References

- [Bridge unified message rendering proposal](https://github.com/chadvoegele/matrix-acp-bridge/pull/27)
- [ACP prompt turns](https://agentclientprotocol.com/protocol/prompt-turn)
- [ACP schema: ContentChunk and MessageId](https://github.com/agentclientprotocol/agent-client-protocol/blob/main/schema/schema.json)
- Adapter translation: `src/acp/session.ts`; history and built-in replies: `src/acp/agent.ts`.
- Existing event translation tests: `test/component/session-events.test.ts`.
