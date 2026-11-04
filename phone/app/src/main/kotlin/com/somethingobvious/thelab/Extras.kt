package com.somethingobvious.thelab

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.service.quicksettings.TileService
import android.widget.RemoteViews
import androidx.core.service.quicksettings.PendingIntentActivityWrapper
import androidx.core.service.quicksettings.TileServiceCompat

// Opens The Lab with the cursor in the message box.
fun composeIntent(context: Context): PendingIntent = PendingIntent.getActivity(
    context, 30, composeActivity(context), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
)

private fun composeActivity(context: Context) = Intent(context, MainActivity::class.java)
    .setAction(MainActivity.COMPOSE).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)

class ComposeTile : TileService() {
    override fun onClick() {
        super.onClick()
        // Android 13 only takes an Intent here, and 14 and up only a PendingIntent.
        TileServiceCompat.startActivityAndCollapse(this, PendingIntentActivityWrapper(this, 30, composeActivity(this), PendingIntent.FLAG_UPDATE_CURRENT, false))
    }
}

// A home screen bar that opens straight into typing and shows what the computer
// is up to underneath.
class Widget : AppWidgetProvider() {
    override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) {
        Hub.init(context)
        update(context)
    }

    companion object {
        fun update(context: Context) {
            val manager = AppWidgetManager.getInstance(context)
            val ids = manager.getAppWidgetIds(ComponentName(context, Widget::class.java))
            if (ids.isEmpty()) return
            val working = Hub.link.optString("state") == "online" && Hub.status.optBoolean("working")
            val line = when {
                !Hub.paired -> "Not paired yet"
                Hub.link.optString("state") != "online" -> "Can't reach the computer right now"
                working && Hub.status.optString("label") == "Waiting for you" -> "Needs your OK"
                working -> Hub.status.optString("label").ifBlank { "Working" }
                else -> "Ready"
            }
            val views = RemoteViews(context.packageName, R.layout.widget).apply {
                setTextViewText(R.id.widget_status, line)
                setOnClickPendingIntent(R.id.widget, composeIntent(context))
            }
            manager.updateAppWidget(ids, views)
        }
    }
}
