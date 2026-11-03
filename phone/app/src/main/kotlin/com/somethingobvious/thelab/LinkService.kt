package com.somethingobvious.thelab

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Person
import android.app.RemoteInput
import android.app.Service
import android.app.job.JobInfo
import android.app.job.JobParameters
import android.app.job.JobScheduler
import android.app.job.JobService
import android.content.ComponentName
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.content.pm.ShortcutInfo
import android.content.pm.ShortcutManager
import android.graphics.drawable.Icon
import android.os.Build
import android.os.Bundle
import android.os.IBinder
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant
import java.util.UUID

// Keeps the process, and so the stream from the computer, alive while the app is
// in the background. Its notification doubles as the live status line.
class LinkService : Service() {
    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        Hub.init(this)
        running = this
        startForeground(Notifier.STATUS_ID, Notifier.status(this), ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING)
        Hub.start()
        follow()
        return START_STICKY
    }

    override fun onDestroy() {
        running = null
        super.onDestroy()
    }

    companion object {
        private var running: LinkService? = null

        fun start(context: Context) {
            runCatching { context.startForegroundService(Intent(context, LinkService::class.java)) }
                .onFailure { Log.w("Lab", "service not started from here", it) }
        }

        private val main = android.os.Handler(android.os.Looper.getMainLooper())
        private val again = Runnable { refresh() }

        // A computer that's off or asleep isn't worth a notification that never
        // goes away, so after two minutes without it the service steps down.
        // A job checks back every 15 minutes, and once the link is back the
        // service and its line come back with it. The phone's battery
        // allowlist (setup adds it) lets that start happen from the background.
        private val stepDown = Runnable {
            running?.let { it.stopForeground(STOP_FOREGROUND_REMOVE); it.stopSelf() }
            if (Hub.paired) Retry.schedule(Hub.app)
        }

        private fun follow() {
            val state = Hub.link.optString("state")
            if (state == "online") {
                main.removeCallbacks(stepDown)
                Retry.cancel(Hub.app)
                if (running == null) start(Hub.app)
            } else if (running != null && !main.hasCallbacks(stepDown)) {
                main.postDelayed(stepDown, if (state == "unpaired") 0 else 2 * 60_000L)
            }
        }

        fun refresh() {
            Widget.update(Hub.app)
            follow()
            val s = running ?: return
            s.getSystemService(NotificationManager::class.java).notify(Notifier.STATUS_ID, Notifier.status(s))
            // Done shows for 10 minutes, then the line goes back to idle.
            main.removeCallbacks(again)
            Notifier.doneUntil()?.let { main.postDelayed(again, it - System.currentTimeMillis() + 500) }
        }
    }
}

// Tries the computer again while the service is stepped down.
class Retry : JobService() {
    override fun onStartJob(params: JobParameters): Boolean {
        Hub.init(this)
        if (!Hub.paired) return false
        Hub.start()
        Hub.reconnectNow()
        // Long enough for a relay dial and the first events.
        android.os.Handler(mainLooper).postDelayed({ jobFinished(params, false) }, 30_000)
        return true
    }

    override fun onStopJob(params: JobParameters) = false

    companion object {
        private const val ID = 7

        fun schedule(context: Context) {
            val js = context.getSystemService(JobScheduler::class.java)
            if (js.getPendingJob(ID) != null) return
            js.schedule(JobInfo.Builder(ID, ComponentName(context, Retry::class.java))
                .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
                .setPeriodic(15 * 60_000L)
                .setPersisted(true)
                .build())
        }

        fun cancel(context: Context) = context.getSystemService(JobScheduler::class.java).cancel(ID)
    }
}

object Notifier {
    const val STATUS_ID = 1
    private const val VIOLET = 0xFF5A2EE6.toInt()
    private const val REPLY_ID = 2
    private const val NOTICE_ID = 3
    private const val STOP_ID = 4
    // The last few messages each way, so a reply notification reads as a conversation.
    private val recent = ArrayDeque<Triple<CharSequence, Long, Boolean>>()

    fun channels(context: Context) {
        val nm = context.getSystemService(NotificationManager::class.java)
        nm.createNotificationChannels(listOf(
            NotificationChannel("status", "Connection", NotificationManager.IMPORTANCE_LOW).apply {
                description = "Shows whether the computer is reachable and what it's working on"
                setShowBadge(false)
            },
            NotificationChannel("replies", "Replies", NotificationManager.IMPORTANCE_HIGH).apply {
                description = "Replies and files from the computer"
            },
            NotificationChannel("asks", "Approvals", NotificationManager.IMPORTANCE_HIGH).apply {
                description = "When the agent needs your go-ahead"
            },
            NotificationChannel("notices", "Problems", NotificationManager.IMPORTANCE_DEFAULT).apply {
                description = "Restarts, sign-in and connection problems"
            },
        ))
    }

    private fun open(context: Context): PendingIntent = PendingIntent.getActivity(
        context, 0, Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )

    private fun action(context: Context, act: String, ref: String, code: Int): PendingIntent = PendingIntent.getBroadcast(
        context, code, Intent(context, AnswerReceiver::class.java).setAction(act).putExtra("ref", ref),
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )

    // When the Done line should go back to idle, or null when it already has.
    fun doneUntil(): Long? {
        val at = Hub.lastDone?.let { runCatching { Instant.parse(it.optString("at")).toEpochMilli() }.getOrNull() } ?: return null
        return (at + 10 * 60_000).takeIf { it > System.currentTimeMillis() && !Hub.status.optBoolean("working") }
    }

    // Four states: working, waiting for his OK, done (for 10 minutes) and idle.
    // Working and waiting are promoted, which Android 16 shows as a Live
    // Update chip in the status bar.
    fun status(context: Context): Notification {
        val link = Hub.link
        val online = link.optString("state") == "online"
        val working = online && Hub.status.optBoolean("working")
        val waiting = working && Hub.status.optString("label") == "Waiting for you"
        val b = Notification.Builder(context, "status")
            .setSmallIcon(R.drawable.ic_status).setColor(VIOLET)
            .setContentIntent(open(context))
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setCategory(Notification.CATEGORY_STATUS)
        val since = runCatching { Instant.parse(Hub.status.optString("since")).toEpochMilli() }.getOrDefault(System.currentTimeMillis())
        if (waiting) {
            // A promoted card always sits first and expanded, so it carries the
            // buttons rather than sending him down to the ask itself.
            val at = Hub.events.indexOfLast { it.optString("kind") == "ask" }
            val ask = Hub.events.getOrNull(at)
                ?.takeIf { a -> Hub.events.subList(at + 1, Hub.events.size).none { it.optString("kind") == "answered" && it.optString("ref") == a.optString("ref") } }
            b.setContentTitle("Needs your OK").setContentText(ask?.optString("plain")?.ifBlank { null } ?: "Open The Lab to allow or deny it.")
                .setWhen(since).setShowWhen(true).setUsesChronometer(true)
            if (ask != null) {
                val ref = ask.optString("ref")
                b.addAction(Notification.Action.Builder(null, "Deny", action(context, AnswerReceiver.DENY, ref, ref.hashCode() + 1)).setAuthenticationRequired(true).build())
                    .addAction(Notification.Action.Builder(null, "Allow", action(context, AnswerReceiver.ALLOW, ref, ref.hashCode())).setAuthenticationRequired(true).build())
            }
            if (Build.VERSION.SDK_INT >= 36) b.setShortCriticalText("Your OK")
            b.addExtras(Bundle().apply { putBoolean("android.requestPromotedOngoing", true) })
        } else if (working) {
            val label = Hub.status.optString("label").ifBlank { "Working" }
            b.setContentTitle("Working").setContentText(label)
                .setWhen(since).setShowWhen(true).setUsesChronometer(true)
                .addAction(Notification.Action.Builder(null, "Stop", action(context, AnswerReceiver.STOP, "", 10)).build())
            if (Build.VERSION.SDK_INT >= 36) {
                b.setShortCriticalText("Working")
                b.setStyle(Notification.ProgressStyle().setProgressIndeterminate(true))
            }
            b.addExtras(Bundle().apply { putBoolean("android.requestPromotedOngoing", true) })
        } else if (online && doneUntil() != null) {
            val d = Hub.lastDone!!
            val title = if (d.optBoolean("stopped")) "Stopped" else if (d.optBoolean("ok")) "Done" else "Didn't finish"
            b.setContentTitle(title).setContentText("Open The Lab to see what it did.")
                .setWhen(runCatching { Instant.parse(d.optString("at")).toEpochMilli() }.getOrDefault(0)).setShowWhen(true)
        } else {
            val title = when (link.optString("state")) {
                "online" -> "Connected to the computer"
                "connecting" -> "Reaching the computer"
                "unpaired" -> "Not paired"
                else -> "Can't reach the computer"
            }
            b.setContentTitle(title).setShowWhen(false)
            if (link.optString("state") != "online") b.setContentText(link.optString("detail"))
        }
        return b.build()
    }

    // Only events from the last couple of minutes notify, so a phone coming
    // back after a day offline doesn't replay a day of alerts.
    fun onEvent(e: JSONObject) {
        val context = Hub.app
        val nm = context.getSystemService(NotificationManager::class.java)
        val kind = e.optString("kind")
        if (kind == "answered") {
            return nm.cancel(e.optString("ref").hashCode())
        }
        if (kind == "done") {
            // Asked from the shade rather than kept in memory, so it still works after the process restarts.
            for (n in nm.activeNotifications) if (n.notification.channelId == "asks") nm.cancel(n.id)
        }
        val at = runCatching { Instant.parse(e.optString("at")).toEpochMilli() }.getOrDefault(0)
        if (System.currentTimeMillis() - at > 120_000) return
        // A scheduled run with nothing to say stays quiet.
        if (e.optBoolean("silent")) return
        if (kind == "you" || kind == "reply" || kind == "file") {
            val label = e.optString("scheduled")
            val text = if (kind == "file") "Sent you ${e.optString("name")}" else if (label.isNotEmpty()) "$label: ${plain(e.optString("text"))}" else plain(e.optString("text"))
            recent.addLast(Triple(text, at, kind == "you"))
            while (recent.size > 6) recent.removeFirst()
        }
        // Someone at the computer with The Lab in front already sees it there.
        if (Hub.foreground || e.optBoolean("onMac")) return
        val b = when (kind) {
            "reply", "file" -> {
                val mac = Person.Builder().setName(Hub.mac?.optString("name")?.ifBlank { null } ?: "Your computer").setKey("mac").build()
                val me = Person.Builder().setName("You").setKey("me").build()
                conversation(context, mac)
                val style = Notification.MessagingStyle(me)
                for ((text, time, mine) in recent) style.addMessage(text, time, if (mine) null else mac)
                val input = RemoteInput.Builder(AnswerReceiver.TEXT).setLabel("Message your computer").build()
                val reply = PendingIntent.getBroadcast(
                    context, 20, Intent(context, AnswerReceiver::class.java).setAction(AnswerReceiver.REPLY),
                    PendingIntent.FLAG_MUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
                )
                Notification.Builder(context, "replies")
                    .setStyle(style)
                    .setShortcutId("mac")
                    .setCategory(Notification.CATEGORY_MESSAGE)
                    .addAction(Notification.Action.Builder(null, "Reply", reply).addRemoteInput(input).setAllowGeneratedReplies(false).build())
            }
            "ask" -> {
                val ref = e.optString("ref")
                val code = ref.hashCode()
                // His words first, as on the card. The command stays in the app.
                val facts = e.optJSONArray("facts")?.let { a -> (0 until a.length()).map { a.optString(it) } }.orEmpty()
                val lines = listOfNotNull(e.optString("from").ifBlank { null }) + facts + listOfNotNull(e.optString("why").ifBlank { null }?.let { "The agent says: $it" })
                val text = lines.ifEmpty { listOf(e.optString("detail")) }.joinToString("\n")
                Notification.Builder(context, "asks")
                    .setContentTitle(e.optString("title"))
                    .setContentText(lines.firstOrNull() ?: e.optString("detail"))
                    .setStyle(Notification.BigTextStyle().bigText(text))
                    .setCategory(Notification.CATEGORY_REMINDER)
                    // Allowing runs something on his computer, so it shouldn't work from a locked phone.
                    .addAction(Notification.Action.Builder(null, "Deny", action(context, AnswerReceiver.DENY, ref, code + 1)).setAuthenticationRequired(true).build())
                    .addAction(Notification.Action.Builder(null, "Allow", action(context, AnswerReceiver.ALLOW, ref, code)).setAuthenticationRequired(true).build())
                    .also { nm.notify(code, it.setSmallIcon(R.drawable.ic_status).setColor(VIOLET).setContentIntent(open(context)).setAutoCancel(true).build()) }
                return
            }
            "notice" -> Notification.Builder(context, "notices")
                .setContentTitle("The Lab")
                .setContentText(e.optString("text"))
                .setStyle(Notification.BigTextStyle().bigText(e.optString("text")))
            else -> return
        }
        val id = if (kind == "notice") NOTICE_ID else REPLY_ID
        nm.notify(id, b.setSmallIcon(R.drawable.ic_status).setColor(VIOLET).setContentIntent(open(context)).setAutoCancel(true).build())
    }

    // Replies are Markdown, which a notification would show as asterisks.
    private fun plain(s: String) = s.replace(Regex("```[\\s\\S]*?```"), " ")
        .replace(Regex("\\[([^\\]]+)]\\([^)]*\\)"), "$1")
        .replace(Regex("[*`#>]"), "")
        .replace(Regex("[ \\t]+"), " ")
        .trim()

    // Android only files a notification under Conversations when it points at
    // a long-lived shortcut for the person it's from.
    private fun conversation(context: Context, mac: Person) {
        val open = Intent(context, MainActivity::class.java).setAction(Intent.ACTION_MAIN)
        val info = ShortcutInfo.Builder(context, "mac")
            .setShortLabel(mac.name ?: "Your computer")
            .setIcon(Icon.createWithResource(context, R.mipmap.ic_launcher))
            .setPerson(mac)
            .setLongLived(true)
            .setIntent(open)
            // Puts the computer in the share sheet's top row.
            .setCategories(setOf(SHARE_CATEGORY))
            .build()
        runCatching { context.getSystemService(ShortcutManager::class.java).pushDynamicShortcut(info) }
    }

    fun shareTarget(context: Context) = conversation(context, Person.Builder().setName(Hub.mac?.optString("name")?.ifBlank { null } ?: "Your computer").setKey("mac").build())
    const val SHARE_CATEGORY = "com.somethingobvious.thelab.category.SHARE"


    fun answerFailed(context: Context, ref: String) {
        val code = ref.hashCode()
        context.getSystemService(NotificationManager::class.java).notify(code, Notification.Builder(context, "asks")
            .setSmallIcon(R.drawable.ic_status).setColor(VIOLET)
            .setContentTitle("Your answer didn't go through")
            .setContentText("Couldn't reach the computer. Open The Lab to answer.")
            .setContentIntent(open(context)).setAutoCancel(true)
            .build())
    }

    fun stopFailed(context: Context) {
        context.getSystemService(NotificationManager::class.java).notify(STOP_ID, Notification.Builder(context, "notices")
            .setSmallIcon(R.drawable.ic_status).setColor(VIOLET)
            .setContentTitle("Couldn't reach the computer to stop it")
            .setContentText("It's probably still working. Open The Lab to try again.")
            .setContentIntent(open(context)).setAutoCancel(true)
            .build())
    }

    fun clearReplies(context: Context) {
        recent.clear()
        val nm = context.getSystemService(NotificationManager::class.java)
        nm.cancel(REPLY_ID)
        nm.cancel(NOTICE_ID)
        nm.cancel(STOP_ID)
    }
}

class AnswerReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        Hub.init(context)
        val ref = intent.getStringExtra("ref").orEmpty()
        when (intent.action) {
            ALLOW, DENY -> {
                val pending = goAsync()
                Hub.answer(ref, intent.action == ALLOW) { ok ->
                    if (ok) context.getSystemService(NotificationManager::class.java).cancel(ref.hashCode())
                    else Notifier.answerFailed(context, ref)
                    pending.finish()
                }
                return
            }
            STOP -> {
                val pending = goAsync()
                Hub.stop { ok ->
                    if (!ok) Notifier.stopFailed(context)
                    pending.finish()
                }
                return
            }
            REPLY -> {
                val text = RemoteInput.getResultsFromIntent(intent)?.getCharSequence(TEXT)?.toString()?.trim().orEmpty()
                if (text.isNotEmpty()) {
                    Hub.send(text, UUID.randomUUID().toString(), null)
                    if (Hub.paired) LinkService.start(context)
                }
                Notifier.clearReplies(context)
            }
        }
        if (ref.isNotEmpty()) context.getSystemService(NotificationManager::class.java).cancel(ref.hashCode())
    }

    companion object {
        const val ALLOW = "com.somethingobvious.thelab.ALLOW"
        const val DENY = "com.somethingobvious.thelab.DENY"
        const val STOP = "com.somethingobvious.thelab.STOP"
        const val REPLY = "com.somethingobvious.thelab.REPLY"
        const val TEXT = "text"
    }
}

class PairReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        Hub.init(context)
        val url = intent.getStringExtra("url")?.takeIf { it.startsWith("http") }
        val tunnel = intent.getStringExtra("room")?.let { room ->
            Tunnel.Spec.parse(JSONObject().put("relay", intent.getStringExtra("relay") ?: "").put("room", room)
                .put("key", intent.getStringExtra("key") ?: "").put("pass", intent.getStringExtra("pass") ?: "")
                .put("lan", JSONArray((intent.getStringExtra("lan") ?: "").split(',').filter { it.isNotBlank() })))
        }
        val token = intent.getStringExtra("token")
        if ((url == null && tunnel == null) || token.isNullOrBlank()) {
            Log.e("Lab", "pair: needs --es token ... and --es room/key/pass, or --es url https://...")
            resultCode = 1
            return
        }
        Hub.pair(url, tunnel, token)
        resultCode = 0
        resultData = "paired"
    }
}

class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        Hub.init(context)
        if (Hub.paired) LinkService.start(context)
    }
}

class App : android.app.Application() {
    override fun onCreate() {
        super.onCreate()
        Hub.init(this)
        Notifier.channels(this)
        Notifier.shareTarget(this)
    }
}
