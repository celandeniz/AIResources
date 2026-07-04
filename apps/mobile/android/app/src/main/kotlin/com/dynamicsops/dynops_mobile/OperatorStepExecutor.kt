package com.dynamicsops.dynops_mobile

class OperatorStepExecutor(private val service: OperatorAccessibilityService) {
    data class StepResult(
        val index: Int,
        val op: String,
        val ok: Boolean,
        val detail: String? = null,
        val durationMs: Long,
    )

    private class StepFailure(message: String) : Exception(message)

    fun run(steps: List<Map<String, Any?>>): List<StepResult> {
        val results = mutableListOf<StepResult>()
        for ((index, step) in steps.withIndex()) {
            val started = System.currentTimeMillis()
            val op = step["op"] as? String ?: "unknown"
            try {
                val ok = execute(op, step)
                results.add(StepResult(index, op, ok, if (ok) null else "operation returned false", elapsed(started)))
                if (!ok) return results
            } catch (failure: StepFailure) {
                results.add(StepResult(index, op, false, failure.message, elapsed(started)))
                return results
            } catch (e: Exception) {
                results.add(StepResult(index, op, false, e.message, elapsed(started)))
                return results
            }
        }
        return results
    }

    private fun execute(op: String, step: Map<String, Any?>): Boolean =
        when (op) {
            "open_app" -> service.openApp(requiredString(step, "package_name"))
            "tap" -> service.tapNode(findRequiredNode(step))
            "type" -> service.typeIntoNode(findRequiredNode(step), requiredString(step, "value"))
            "wait" -> {
                Thread.sleep(number(step["ms"], 0).coerceAtLeast(0))
                true
            }
            "assert" -> {
                val found = findNodeWithTimeout(selector(step), timeoutMs(step)) != null
                val expect = (step["expect"] as? String) ?: "present"
                if (expect == "absent") !found else found
            }
            else -> false
        }

    private fun findRequiredNode(step: Map<String, Any?>) =
        findNodeWithTimeout(selector(step), timeoutMs(step)) ?: throw StepFailure("node not found")

    private fun findNodeWithTimeout(selector: Map<String, String?>, timeoutMs: Long): android.view.accessibility.AccessibilityNodeInfo? {
        val deadline = System.currentTimeMillis() + timeoutMs
        do {
            service.findNode(selector)?.let { return it }
            Thread.sleep(120)
        } while (System.currentTimeMillis() < deadline)
        return null
    }

    private fun selector(step: Map<String, Any?>): Map<String, String?> {
        val raw = step["selector"] as? Map<*, *> ?: emptyMap<Any, Any?>()
        return mapOf(
            "text" to raw["text"]?.toString(),
            "content_desc" to raw["content_desc"]?.toString(),
            "resource_id" to raw["resource_id"]?.toString(),
        )
    }

    private fun timeoutMs(step: Map<String, Any?>) = number(step["timeout_ms"], 3_000L).coerceAtLeast(0)

    private fun requiredString(step: Map<String, Any?>, key: String) =
        step[key]?.toString()?.takeIf { it.isNotBlank() } ?: throw StepFailure("$key required")

    private fun number(value: Any?, fallback: Long) =
        when (value) {
            is Number -> value.toLong()
            is String -> value.toLongOrNull() ?: fallback
            else -> fallback
        }

    private fun elapsed(started: Long) = System.currentTimeMillis() - started
}
