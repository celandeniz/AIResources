package com.dynamicsops.dynops_mobile

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.content.Intent
import android.graphics.Path
import android.graphics.Rect
import android.os.Bundle
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

// Server-driven, approval-gated executor. This service never decides what to do:
// it only runs the step array handed to it by Flutter after server approval.
class OperatorAccessibilityService : AccessibilityService() {
    companion object {
        var instance: OperatorAccessibilityService? = null
            private set
    }

    override fun onServiceConnected() {
        super.onServiceConnected()
        instance = this
    }

    override fun onDestroy() {
        instance = null
        super.onDestroy()
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        // Intentionally empty. The service reads window content on demand while
        // executing an approved script; it does not react autonomously to events.
    }

    override fun onInterrupt() = Unit

    fun findNode(selector: Map<String, String?>): AccessibilityNodeInfo? {
        val root = rootInActiveWindow ?: return null
        selector["resource_id"]?.takeIf { it.isNotBlank() }?.let { id ->
            root.findAccessibilityNodeInfosByViewId(id).firstOrNull()?.let { return it }
        }
        selector["text"]?.takeIf { it.isNotBlank() }?.let { text ->
            root.findAccessibilityNodeInfosByText(text).firstOrNull()?.let { return it }
        }
        selector["content_desc"]?.takeIf { it.isNotBlank() }?.let { desc ->
            return findByContentDescription(root, desc)
        }
        return null
    }

    private fun findByContentDescription(node: AccessibilityNodeInfo, desc: String): AccessibilityNodeInfo? {
        if (node.contentDescription?.toString() == desc) return node
        for (i in 0 until node.childCount) {
            val child = node.getChild(i) ?: continue
            findByContentDescription(child, desc)?.let { return it }
        }
        return null
    }

    fun tapNode(node: AccessibilityNodeInfo): Boolean {
        val bounds = Rect()
        node.getBoundsInScreen(bounds)
        if (bounds.isEmpty) return false
        val path = Path().apply { moveTo(bounds.centerX().toFloat(), bounds.centerY().toFloat()) }
        val gesture = GestureDescription.Builder()
            .addStroke(GestureDescription.StrokeDescription(path, 0, 50))
            .build()
        val latch = CountDownLatch(1)
        var ok = false
        dispatchGesture(gesture, object : GestureResultCallback() {
            override fun onCompleted(gestureDescription: GestureDescription?) {
                ok = true
                latch.countDown()
            }

            override fun onCancelled(gestureDescription: GestureDescription?) {
                ok = false
                latch.countDown()
            }
        }, null)
        latch.await(3, TimeUnit.SECONDS)
        return ok
    }

    fun typeIntoNode(node: AccessibilityNodeInfo, value: String): Boolean {
        val args = Bundle().apply {
            putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, value)
        }
        return node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)
    }

    fun openApp(packageName: String): Boolean {
        val intent = packageManager.getLaunchIntentForPackage(packageName) ?: return false
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        startActivity(intent)
        return true
    }
}
