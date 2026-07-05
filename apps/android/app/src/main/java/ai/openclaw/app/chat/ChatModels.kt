package ai.openclaw.app.chat

/**
 * Chat transcript item as delivered by gateway chat history and live chat events.
 */
data class ChatMessage(
  val id: String,
  val role: String,
  val content: List<ChatMessageContent>,
  val timestampMs: Long?,
  val idempotencyKey: String? = null,
)

/**
 * One content part in a chat message; binary parts carry base64 plus their MIME metadata.
 */
data class ChatMessageContent(
  val type: String = "text",
  val text: String? = null,
  val mimeType: String? = null,
  val fileName: String? = null,
  val base64: String? = null,
)

/**
 * Tool call placeholder shown while a gateway run is still streaming.
 */
data class ChatPendingToolCall(
  val toolCallId: String,
  val name: String,
  val args: kotlinx.serialization.json.JsonObject? = null,
  val startedAtMs: Long,
  val isError: Boolean? = null,
)

/**
 * Stable session selector row; [key] is the gateway session key used in chat requests.
 */
data class ChatSessionEntry(
  val key: String,
  val updatedAtMs: Long?,
  val displayName: String? = null,
  val totalTokens: Long? = null,
  val totalTokensFresh: Boolean? = null,
  val contextTokens: Long? = null,
  val hasContextUsageMetadata: Boolean = totalTokens != null || totalTokensFresh != null || contextTokens != null,
)

/**
 * Slash command metadata exposed by the gateway for text-surface chat clients.
 */
data class ChatCommandEntry(
  val name: String,
  val description: String,
  val category: String? = null,
  val textAliases: List<String> = emptyList(),
  val acceptsArgs: Boolean = false,
)

/**
 * Snapshot of one chat session, including optional thinking level selected on the gateway.
 *
 * [maxTranscriptSeq] is the highest `__openclaw.seq` across returned rows; it seeds the
 * afterSeq reconnect cursor. [cursor] is non-null only when the gateway echoed `afterSeq`,
 * which is the version-skew discriminator between catch-up pages and legacy full pages.
 */
data class ChatHistory(
  val sessionKey: String,
  val sessionId: String?,
  val thinkingLevel: String?,
  val messages: List<ChatMessage>,
  val sessionInfo: ChatSessionEntry? = null,
  val maxTranscriptSeq: Long? = null,
  val cursor: ChatHistoryCursor? = null,
)

/**
 * afterSeq catch-up cursor echoed by gateways that honored the request param.
 */
data class ChatHistoryCursor(
  val afterSeq: Long,
  val nextAfterSeq: Long?,
  val hasMore: Boolean,
)

/**
 * User-selected attachment payload sent to the gateway as inline base64.
 */
data class OutgoingAttachment(
  val type: String,
  val mimeType: String,
  val fileName: String,
  val base64: String,
)
