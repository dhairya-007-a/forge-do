# Ask Forge chat: persistence, memory, and attachments

Date: 2026-07-30
Status: Approved, pending implementation plan

## Problem

The "Ask Forge" chat (`index.html`, `#doubtchat` panel) is currently fully
stateless:

- Every question is a one-shot call to `netlify/functions/ask-doubt.js` with
  no prior context.
- Nothing is persisted — reloading the page always resets to the static
  welcome message. `forge-doubt-history` in localStorage only logs
  `{question, subject, date}` for activity stats, not the actual
  conversation.
- There is no way to attach a file to a question.

This spec covers making the chat feel like a real, continuous conversation:
it remembers what was said, it survives reloads, it shows when messages were
sent, and you can attach a file to a message.

## Scope decisions (from brainstorming)

These were explicitly decided with the user and are not open questions:

1. **Attachments are reference-only.** The AI does not read file contents.
   No PDF/DOCX parsing, no RAG. A file is just shown as a chip on the
   message. This can be upgraded later without a redesign.
2. **Attachment files are session-only.** Actual file bytes are never
   persisted (no IndexedDB). They live in memory for the current tab only.
3. **One continuous chat**, not multiple named sessions. Like today, but
   persisted.
4. **Real multi-turn memory**: follow-up questions get resolved using
   recent conversation history, not answered blind.
5. **History window: last 3 exchanges** (≤6 messages) sent to the model per
   question — bounded cost/latency regardless of how long the chat gets.
6. **Timestamps shown per message.**
7. **One file attachment per message** (no multi-file chip list).
8. **No cap on total persisted chat history** — matches existing unbounded
   patterns in this codebase (`forge-doubt-history`, `forge-saved-notes`).

## Data model

New localStorage key: `forge-chat-messages`

```js
[
  {
    id: "m_1721...",              // timestamp-based id, also used as Map key for attachment blobs
    role: "user" | "ai",
    text: "...",
    timestamp: "2026-07-30T14:32:00.000Z",   // ISO string
    attachment: { name, size, type } | null,  // metadata only — never file bytes
    aiData: { subject, explanation, keyConcept, example, tier, apiFailed } | null  // ai messages only
  },
  ...
]
```

- Written/read the same way as every other localStorage-backed feature in
  this file (`lsGet`/`lsSet` helpers, or direct `JSON.parse`/`stringify`
  matching the `forge-doubt-history` pattern already in place).
- On page load: if this array is non-empty, rebuild the chat window from it
  instead of rendering the static welcome message. Empty array (first-ever
  visit) still shows today's welcome message.
- Every `sendDoubt()` call appends the user message and the AI reply to this
  array and persists it — including failed/offline turns, so the
  conversation record stays honest.

**Attachment file bytes are never persisted.** They live only in an
in-memory `Map<messageId, File>` for the life of the browser tab. After a
reload, a message that had an attachment renders its chip as:

> 📎 filename.ext — no longer available

## UI changes (`index.html`, `#doubtchat` panel + `#chatInputRow`)

- New paperclip button next to the existing send button (`#chatSendBtn`),
  wired to a hidden `<input type="file">` (no `accept` restriction — any
  file type).
- Selecting a file shows a small pending-attachment chip above the textarea
  (filename + size + an ✕ to remove it). Nothing is sent yet at this point.
- Selecting a second file while one is pending **replaces** the pending one
  (single-file-per-message rule).
- Cancelling the file picker is a no-op — no chip appears.
- Hitting send (via button or Enter, matching existing `sendDoubt()` /
  keydown handler behavior):
  - Attaches the pending file's `{name, size, type}` to the new user message
    object and renders it as a chip on the user's bubble (📎 icon + filename
    + size).
  - Stores the actual `File` object in the in-memory Map keyed by that
    message's id.
  - Clears the pending-attachment chip.
- Every message bubble (user and AI) gets a small timestamp underneath:
  today's messages show a time (e.g. "2:34 PM"), older ones show a date
  (e.g. "Jul 28" via `toLocaleDateString('en-US', {month:'short', day:'numeric'})`,
  the same formatter already used for exam history dates at line ~3774).
  This specific today/older split is new to this feature, not reused from
  elsewhere.

## Backend memory (`netlify/functions/ask-doubt.js`)

- The frontend builds a `history` array from the last 3 exchanges (≤6
  messages) already in `forge-chat-messages` — text only, never attachment
  bytes, never the full `aiData` object (just enough to reconstruct
  `{role, content}` turns).
- If a historical message had an attachment, its text is annotated, e.g.:
  `"explain that diagram [attached: notes.pdf]"` — so the model knows an
  attachment existed even though it can't read it. This avoids confusing
  follow-ups like "what's in the file I sent."
- The frontend POSTs `{ question, tier, history }` to `/ask-doubt`.
- `ask-doubt.js`:
  - Accepts `history` (array of `{role: 'user'|'assistant', content}`),
    defaulting to `[]` if absent/malformed.
  - **Truncates `history` server-side to the last 6 entries** regardless of
    what the frontend sends — defensive cap so a manipulated payload can't
    inflate token cost.
  - Passes `history` entries as prior messages in the OpenRouter
    `messages` array, positioned after the system prompt and before the
    final user question.
  - Output contract is **unchanged**: still exactly
    `{subject, explanation, keyConcept, example}` per turn, even for
    follow-ups.
  - System prompt gets one added instruction: resolve pronouns/references
    against the conversation history when present (e.g. "that", "the one I
    just asked about").

## Error handling & edge cases

- First-ever visit (empty `forge-chat-messages`): shows today's static
  welcome message, same as now.
- API failure mid-conversation: existing fallback to `findAnswer()` / the
  local `QA_BANK` still applies per-message, independent of history. A
  failed turn is still persisted as a real exchange (with `apiFailed: true`
  in `aiData`), so the conversation record stays accurate.
- No cap on total persisted message count — consistent with existing
  unbounded localStorage patterns in this codebase.

## Testing plan

Manual verification against the local dev server (`netlify dev`,
`localhost:8888`):

1. Send a message, attach a file, confirm the chip renders correctly.
2. Reload the page — confirm the full conversation restores, and the
   attached file's chip now reads "no longer available."
3. Ask a question, then a follow-up that depends on it (e.g. "what is a
   stack" → "give me an example of that") — confirm the second answer
   correctly resolves "that" using conversation history.
4. Force an API failure (e.g. stop the dev server mid-chat) — confirm the
   fallback still renders and the failed turn still gets persisted.

## Out of scope (explicitly, per brainstorming)

- Reading/parsing attachment content (RAG) — reference-only for now.
- Persisting attachment file bytes across reloads (IndexedDB) — session-only
  for now.
- Multiple named/saved chat sessions — single continuous chat only.
- Multi-file attachments per message.
- Any cap/trimming policy on total chat history size.
