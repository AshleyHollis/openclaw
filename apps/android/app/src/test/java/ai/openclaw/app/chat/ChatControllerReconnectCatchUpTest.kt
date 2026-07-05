package ai.openclaw.app.chat

import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class ChatControllerReconnectCatchUpTest {
  private val json = Json { ignoreUnknownKeys = true }

  private class RecordedCall(
    val method: String,
    val params: String?,
  )

  private fun historyRow(
    role: String,
    text: String,
    timestamp: Long,
    seq: Long? = null,
  ): String {
    val meta = if (seq != null) ""","__openclaw":{"seq":$seq}""" else ""
    return """{"role":"$role","content":[{"type":"text","text":"$text"}],"timestamp":$timestamp$meta}"""
  }

  private fun fullHistory(
    vararg rows: String,
    sessionId: String = "sess-1",
  ): String = """{"sessionId":"$sessionId","messages":[${rows.joinToString(",")}]}"""

  private fun cursorPage(
    afterSeq: Long,
    nextAfterSeq: Long,
    hasMore: Boolean,
    vararg rows: String,
    sessionId: String = "sess-1",
  ): String =
    """
    {"sessionId":"$sessionId","afterSeq":$afterSeq,"nextAfterSeq":$nextAfterSeq,"hasMore":$hasMore,
     "totalMessages":$nextAfterSeq,"messages":[${rows.joinToString(",")}]}
    """.trimIndent()

  private fun List<RecordedCall>.historyParams(): List<String> =
    filter { it.method == "chat.history" }
      .map { it.params.orEmpty() }

  private fun ChatController.visibleTexts(): List<String> =
    messages.value.map { message ->
      message.content
        .firstOrNull()
        ?.text
        .orEmpty()
    }

  @Test
  fun reconnectFetchesDeltaWithAfterSeqAndSkipsDuplicates() =
    runTest {
      val calls = mutableListOf<RecordedCall>()
      val controller =
        ChatController(
          scope = this,
          json = json,
          requestGateway = { method, params ->
            calls += RecordedCall(method, params)
            when {
              method != "chat.history" -> "{}"
              params.orEmpty().contains("afterSeq") ->
                cursorPage(
                  afterSeq = 2,
                  nextAfterSeq = 4,
                  hasMore = false,
                  // Duplicate copy of the already-shown "world" row plus one missed row.
                  historyRow("assistant", "world", 2000, seq = 3),
                  historyRow("user", "next", 3000, seq = 4),
                )
              else ->
                fullHistory(
                  historyRow("user", "hello", 1000, seq = 1),
                  historyRow("assistant", "world", 2000, seq = 2),
                )
            }
          },
        )

      controller.load("main")
      advanceUntilIdle()
      assertEquals(listOf("hello", "world"), controller.visibleTexts())

      controller.onDisconnected("gateway closed")
      controller.handleGatewayEvent("health", null)
      advanceUntilIdle()

      val deltaParams = calls.historyParams().last()
      assertTrue(deltaParams, deltaParams.contains(""""afterSeq":2"""))
      assertTrue(calls.historyParams().first().contains(""""offset":0"""))
      assertEquals(listOf("hello", "world", "next"), controller.visibleTexts())
    }

  @Test
  fun reconnectCatchUpLoopsUntilHasMoreIsFalse() =
    runTest {
      val calls = mutableListOf<RecordedCall>()
      val controller =
        ChatController(
          scope = this,
          json = json,
          requestGateway = { method, params ->
            calls += RecordedCall(method, params)
            when {
              method != "chat.history" -> "{}"
              params.orEmpty().contains(""""afterSeq":2""") ->
                cursorPage(2, nextAfterSeq = 3, hasMore = true, historyRow("assistant", "third", 3000, seq = 3))
              params.orEmpty().contains(""""afterSeq":3""") ->
                cursorPage(3, nextAfterSeq = 4, hasMore = false, historyRow("user", "fourth", 4000, seq = 4))
              else ->
                fullHistory(
                  historyRow("user", "hello", 1000, seq = 1),
                  historyRow("assistant", "world", 2000, seq = 2),
                )
            }
          },
        )

      controller.load("main")
      advanceUntilIdle()

      controller.onDisconnected("gateway closed")
      controller.handleGatewayEvent("health", null)
      advanceUntilIdle()

      val cursorParams = calls.historyParams().filter { it.contains("afterSeq") }
      assertEquals(2, cursorParams.size)
      assertTrue(cursorParams[0], cursorParams[0].contains(""""afterSeq":2"""))
      assertTrue(cursorParams[1], cursorParams[1].contains(""""afterSeq":3"""))
      assertEquals(listOf("hello", "world", "third", "fourth"), controller.visibleTexts())
    }

  @Test
  fun legacyResponseWithoutCursorEchoAppliesWholesaleReplaceAndDisablesCatchUp() =
    runTest {
      val calls = mutableListOf<RecordedCall>()
      val controller =
        ChatController(
          scope = this,
          json = json,
          requestGateway = { method, params ->
            calls += RecordedCall(method, params)
            when {
              method != "chat.history" -> "{}"
              // Gateway ignored afterSeq: legacy full page without cursor echo and without seq metadata.
              params.orEmpty().contains("afterSeq") ->
                fullHistory(
                  historyRow("user", "hello", 1000),
                  historyRow("assistant", "world", 2000),
                  historyRow("assistant", "third", 3000),
                )
              else ->
                fullHistory(
                  historyRow("user", "hello", 1000, seq = 1),
                  historyRow("assistant", "world", 2000, seq = 2),
                )
            }
          },
        )

      controller.load("main")
      advanceUntilIdle()

      controller.onDisconnected("gateway closed")
      controller.handleGatewayEvent("health", null)
      advanceUntilIdle()
      assertEquals(listOf("hello", "world", "third"), controller.visibleTexts())

      // The legacy page carried no seq baseline, so the next reconnect must not send a cursor.
      val historyCallsBefore = calls.historyParams().size
      controller.onDisconnected("gateway closed again")
      controller.handleGatewayEvent("health", null)
      advanceUntilIdle()
      assertEquals(historyCallsBefore, calls.historyParams().size)
    }

  @Test
  fun legacyGatewayRejectingAfterSeqFallsBackToFullFetch() =
    runTest {
      val calls = mutableListOf<RecordedCall>()
      val controller =
        ChatController(
          scope = this,
          json = json,
          requestGateway = { method, params ->
            calls += RecordedCall(method, params)
            when {
              method != "chat.history" -> "{}"
              params.orEmpty().contains("afterSeq") -> throw IllegalStateException("invalid chat.history params")
              else ->
                fullHistory(
                  historyRow("user", "hello", 1000, seq = 1),
                  historyRow("assistant", "world", 2000, seq = 2),
                )
            }
          },
        )

      controller.load("main")
      advanceUntilIdle()

      controller.onDisconnected("gateway closed")
      controller.handleGatewayEvent("health", null)
      advanceUntilIdle()

      val historyParams = calls.historyParams()
      // load full fetch, rejected cursor fetch, then fallback full fetch.
      assertEquals(3, historyParams.size)
      assertTrue(historyParams[1].contains("afterSeq"))
      assertTrue(!historyParams[2].contains("afterSeq"))
      assertTrue(historyParams[2].contains(""""offset":0"""))
      assertEquals(listOf("hello", "world"), controller.visibleTexts())
    }

  @Test
  fun changedSessionIdRebasesFromFullHistory() =
    runTest {
      val calls = mutableListOf<RecordedCall>()
      var fullFetches = 0
      val controller =
        ChatController(
          scope = this,
          json = json,
          requestGateway = { method, params ->
            calls += RecordedCall(method, params)
            when {
              method != "chat.history" -> "{}"
              params.orEmpty().contains("afterSeq") ->
                cursorPage(
                  afterSeq = 2,
                  nextAfterSeq = 3,
                  hasMore = false,
                  historyRow("assistant", "stale", 3000, seq = 3),
                  sessionId = "sess-replaced",
                )
              fullFetches++ == 0 ->
                fullHistory(
                  historyRow("user", "old question", 1000, seq = 1),
                  historyRow("assistant", "old answer", 2000, seq = 2),
                )
              else ->
                fullHistory(
                  historyRow("assistant", "replacement", 4000, seq = 1),
                  sessionId = "sess-replaced",
                )
            }
          },
        )

      controller.load("main")
      advanceUntilIdle()
      controller.onDisconnected("gateway closed")
      controller.handleGatewayEvent("health", null)
      advanceUntilIdle()

      assertEquals(listOf("replacement"), controller.visibleTexts())
      assertEquals(3, calls.historyParams().size)
    }

  @Test
  fun backwardCursorRebasesFromFullHistory() =
    runTest {
      var fullFetches = 0
      val controller =
        ChatController(
          scope = this,
          json = json,
          requestGateway = { method, params ->
            when {
              method != "chat.history" -> "{}"
              params.orEmpty().contains("afterSeq") ->
                cursorPage(
                  afterSeq = 2,
                  nextAfterSeq = 1,
                  hasMore = false,
                  historyRow("assistant", "stale", 3000, seq = 1),
                )
              fullFetches++ == 0 ->
                fullHistory(
                  historyRow("user", "old question", 1000, seq = 1),
                  historyRow("assistant", "old answer", 2000, seq = 2),
                )
              else -> fullHistory(historyRow("assistant", "replacement", 4000, seq = 3))
            }
          },
        )

      controller.load("main")
      advanceUntilIdle()
      controller.onDisconnected("gateway closed")
      controller.handleGatewayEvent("health", null)
      advanceUntilIdle()

      assertEquals(listOf("replacement"), controller.visibleTexts())
    }

  @Test
  fun sessionSwitchResetsSeqBaselineToNewSession() =
    runTest {
      val calls = mutableListOf<RecordedCall>()
      val controller =
        ChatController(
          scope = this,
          json = json,
          requestGateway = { method, params ->
            calls += RecordedCall(method, params)
            when {
              method != "chat.history" -> "{}"
              params.orEmpty().contains("agent:other:main") ->
                if (params.orEmpty().contains("afterSeq")) {
                  cursorPage(2, nextAfterSeq = 3, hasMore = false, historyRow("assistant", "other-new", 3000, seq = 3))
                } else {
                  fullHistory(
                    historyRow("user", "other-question", 1000, seq = 1),
                    historyRow("assistant", "other-answer", 2000, seq = 2),
                  )
                }
              else ->
                fullHistory(
                  historyRow("user", "main-1", 1000, seq = 4),
                  historyRow("assistant", "main-2", 2000, seq = 5),
                )
            }
          },
        )

      controller.load("main")
      advanceUntilIdle()

      controller.switchSession("agent:other:main")
      advanceUntilIdle()
      assertEquals(listOf("other-question", "other-answer"), controller.visibleTexts())

      controller.onDisconnected("gateway closed")
      controller.handleGatewayEvent("health", null)
      advanceUntilIdle()

      val deltaParams = calls.historyParams().last()
      // Cursor derives from the switched session's rows (2), not the previous session's (5).
      assertTrue(deltaParams, deltaParams.contains(""""afterSeq":2"""))
      assertTrue(deltaParams, deltaParams.contains("agent:other:main"))
      assertEquals(listOf("other-question", "other-answer", "other-new"), controller.visibleTexts())
    }

  @Test
  fun freshSessionReconnectKeepsPlainFullFetch() =
    runTest {
      val calls = mutableListOf<RecordedCall>()
      val controller =
        ChatController(
          scope = this,
          json = json,
          requestGateway = { method, params ->
            calls += RecordedCall(method, params)
            if (method == "chat.history") {
              fullHistory(historyRow("user", "hello", 1000))
            } else {
              "{}"
            }
          },
        )

      // Never loaded history: reconnect must not issue any catch-up fetch.
      controller.onDisconnected("gateway closed")
      controller.handleGatewayEvent("health", null)
      advanceUntilIdle()
      assertEquals(0, calls.historyParams().size)

      // A regular refresh stays a plain full fetch without a cursor.
      controller.refresh()
      advanceUntilIdle()
      val historyParams = calls.historyParams()
      assertEquals(1, historyParams.size)
      assertTrue(!historyParams[0].contains("afterSeq"))
      assertEquals(listOf("hello"), controller.visibleTexts())
    }
}
