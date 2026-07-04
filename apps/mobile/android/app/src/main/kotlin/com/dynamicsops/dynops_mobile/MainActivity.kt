package com.dynamicsops.dynops_mobile

import android.content.Intent
import android.provider.Settings
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel
import kotlin.concurrent.thread

class MainActivity : FlutterActivity() {
    private val channelName = "com.dynamicsops.dynops_mobile/operator"

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, channelName).setMethodCallHandler { call, result ->
            when (call.method) {
                "isAccessibilityServiceEnabled" -> {
                    result.success(OperatorAccessibilityService.instance != null)
                }
                "openAccessibilitySettings" -> {
                    startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
                    result.success(null)
                }
                "executeSteps" -> {
                    val steps = (call.arguments as? List<*>)
                        ?.mapNotNull { it as? Map<*, *> }
                        ?.map { entry -> entry.entries.associate { it.key.toString() to it.value } }
                        ?: emptyList()
                    val service = OperatorAccessibilityService.instance
                    if (service == null) {
                        result.error("NO_SERVICE", "Accessibility service not enabled", null)
                        return@setMethodCallHandler
                    }
                    thread {
                        val results = OperatorStepExecutor(service).run(steps)
                        runOnUiThread {
                            result.success(results.map {
                                mapOf(
                                    "index" to it.index,
                                    "op" to it.op,
                                    "ok" to it.ok,
                                    "detail" to it.detail,
                                    "duration_ms" to it.durationMs,
                                )
                            })
                        }
                    }
                }
                else -> result.notImplemented()
            }
        }
    }
}
