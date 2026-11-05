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
import java.util.UUID

// Keeps the process, and so the stream from the computer, alive while the app is
// in the background. Its notification doubles as the live status line.
class LinkService : Service() {
    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        Hub.init(this)
        // Every later start finds it in the foreground already, and posting the
        // card again would bring back one he swiped away.
        if (running !== this) {
            running = this
            // Android 13 takes the type from the manifest, which is the same one.
            if (Build.VERSION.SDK_INT >= 34) startForeground(Notifier.STATUS_ID, Notifier.status(this), ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING)
            else startForeground(Notifier.STATUS_ID, Notifier.status(this))
        }
        Hub.start()
        Retry.cancel(this)
        follow()
        return START_STICKY
    }

    override fun onDestroy() {
        running = null
        super.onDestroy()
    }

    companion object {
        private var running: LinkService? = null

        fun start(context: Context): Boolean =
            runCatching { context.startForegroundService(Intent(context, LinkService::class.java)) }
                .onFailure { Log.w("Lab", "service not started from here: ${it.message}") }
                .isSuccess

        private val main = android.os.Handler(android.os.Looper.getMainLooper())
        private val again = Runnable { refresh() }

        // The service stays up while the phone is paired, even with the
        // computer away, since it's what hears the network or the relay say the
        // computer is back. Its card is a quiet one. If Android won't start it
        // from the background, a job checks back every 15 minutes, and the
        // battery allowlist (setup adds it) lets that job start it.
        private fun follow() {
            if (Hub.computers.values.all { it.link.optString("state") == "unpaired" }) {
                running?.let { it.stopForeground(STOP_FOREGROUND_REMOVE); it.stopSelf() }
            } else if (running == null && Hub.paired && !start(Hub.app)) {
                Retry.schedule(Hub.app)
            }
        }

        fun refresh() {
            Widget.update(Hub.app)
            follow()
            val s = running ?: return
            if (Notifier.showAgain(s)) s.getSystemService(NotificationManager::class.java).notify(Notifier.STATUS_ID, Notifier.status(s))
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
        // The sessions from before the freeze have had no traffic, so they may be long dead.
        Hub.redial()
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
    private const val QUEUED_ID = 5
    private const val UNSENT_ID = 6
    private const val PAIR_ID = 8
    // The computer's own limit on how long a question waits.
    private const val ASK_MS = 5 * 60_000L

    // Each computer has its own run of ids, and the first keeps the plain ones.
    private fun nid(c: Computer, base: Int) = base + c.slot * 100
    private fun code(c: Computer, ref: String) = ref.hashCode() xor c.slot
    private fun whose(c: Computer) = Bundle().apply { putString("computer", c.id) }
    private fun isFrom(n: android.service.notification.StatusBarNotification, c: Computer) = (n.notification.extras.getString("computer") ?: "main") == c.id
    // With one computer there's nothing to tell apart.
    private fun named(c: Computer, text: String) = if (Hub.pairedComputers.size > 1) "${c.name}: $text" else text
    fun card(c: Computer, ref: String) = code(c, ref)
    fun shortcutId(c: Computer) = if (c.slot == 0) "mac" else "mac-${c.id}"

    fun channels(context: Context) {
        val nm = context.getSystemService(NotificationManager::class.java)
        nm.createNotificationChannels(listOf(
            NotificationChannel("status", "Connection", NotificationManager.IMPORTANCE_LOW).apply {
                description = "Shows whether the computer is reachable and what it's working on"
                setShowBadge(false)
            },
            // Minimum importance keeps the always-on card out of the status bar
            // and folded at the bottom of the shade.
            NotificationChannel("idle", "Standing by", NotificationManager.IMPORTANCE_MIN).apply {
                description = "The quiet card that keeps the link to the computer open"
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

    private fun open(context: Context, c: Computer): PendingIntent = PendingIntent.getActivity(
        context, c.slot, Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP).putExtra("computer", c.id),
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )

    private fun action(context: Context, c: Computer, act: String, ref: String, code: Int): PendingIntent = PendingIntent.getBroadcast(
        context, code, Intent(context, AnswerReceiver::class.java).setAction(act).putExtra("ref", ref).putExtra("computer", c.id),
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )

    // What the card showed when he swiped it away, or null while it's up.
    // Android 14 and later let him swipe it, and reposting it on every change
    // would bring it straight back.
    private var swiped: String? = null

    // Each task he starts has its own key, so Each Task can tell a new one.
    private fun about(): String {
        val c = Hub.focus()
        return if (c.status.optBoolean("working")) "${c.id} task " + (c.events.lastOrNull { it.optString("kind") == "you" }?.optLong("id") ?: 0) else "idle"
    }

    fun swipedAway() { swiped = about() }

    // Whether the card goes back up after a swipe, by the Status Card setting:
    // always, for each new task (the default), or never.
    fun showAgain(context: Context): Boolean {
        val gone = swiped ?: return true
        // A card that's up after all has to stay current, or it keeps old Allow and Deny buttons.
        if (context.getSystemService(NotificationManager::class.java).activeNotifications.any { it.id == STATUS_ID }) {
            swiped = null
            return true
        }
        val mode = context.getSharedPreferences("lab", Context.MODE_PRIVATE).getString("statusCard", "tasks")
        val back = mode == "always" || (mode == "tasks" && about() != "idle" && about() != gone)
        if (back) swiped = null
        return back
    }

    // When the Done line should go back to idle, or null when it already has.
    fun doneUntil(): Long? {
        val c = Hub.focus()
        val at = c.lastDone?.let { c.phoneTime(it.optString("at")) } ?: return null
        return (at + 10 * 60_000).takeIf { it > System.currentTimeMillis() && !c.status.optBoolean("working") }
    }

    // Four states: working, waiting for his OK, done (for 10 minutes) and idle.
    // Working and waiting are promoted, which Android 16 shows as a Live
    // Update chip in the status bar.
    fun status(context: Context): Notification {
        val c = Hub.focus()
        val link = c.link
        val online = link.optString("state") == "online"
        val working = c.working
        val waiting = c.waiting
        val b = Notification.Builder(context, if (working) "status" else "idle")
            .setSmallIcon(R.drawable.ic_status).setColor(VIOLET)
            .setContentIntent(open(context, c))
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setCategory(Notification.CATEGORY_STATUS)
            .setDeleteIntent(action(context, c, AnswerReceiver.SWIPED, "", 11))
        val since = c.phoneTime(c.status.optString("since")) ?: System.currentTimeMillis()
        if (waiting) {
            // A promoted card always sits first and expanded, so it carries the
            // buttons rather than sending him down to the ask itself.
            val ask = openAsk(c)
            b.setContentTitle(named(c, "Needs your OK")).setContentText(ask?.optString("plain")?.ifBlank { null } ?: "Open The Lab to allow or deny it.")
                .setWhen(since).setShowWhen(true).setUsesChronometer(true)
            if (ask != null) {
                val ref = ask.optString("ref")
                b.addAction(Notification.Action.Builder(null, "Deny", action(context, c, AnswerReceiver.DENY, ref, code(c, ref) + 1)).setAuthenticationRequired(true).build())
                    .addAction(Notification.Action.Builder(null, "Allow", action(context, c, AnswerReceiver.ALLOW, ref, code(c, ref))).setAuthenticationRequired(true).build())
            }
            if (Build.VERSION.SDK_INT >= 36) b.setShortCriticalText("Your OK")
            b.addExtras(Bundle().apply { putBoolean("android.requestPromotedOngoing", true) })
        } else if (working) {
            val label = c.status.optString("label").ifBlank { "Working" }
            b.setContentTitle(named(c, task(c) ?: "Working")).setContentText(label)
                .setWhen(since).setShowWhen(true).setUsesChronometer(true)
                .addAction(Notification.Action.Builder(null, "Stop", action(context, c, AnswerReceiver.STOP, "", 10 + c.slot * 100)).build())
            if (Build.VERSION.SDK_INT >= 36) {
                b.setShortCriticalText("Working")
                b.setStyle(Notification.ProgressStyle().setProgressIndeterminate(true))
            }
            b.addExtras(Bundle().apply { putBoolean("android.requestPromotedOngoing", true) })
        } else if (online && doneUntil() != null) {
            val d = c.lastDone!!
            val title = if (d.optBoolean("stopped")) "Stopped" else if (d.optBoolean("ok")) "Done" else "Didn't finish"
            b.setContentTitle(named(c, task(c) ?: title)).setContentText(if (task(c) == null) "Open The Lab to see what it did." else title)
                .setWhen(c.phoneTime(d.optString("at")) ?: 0).setShowWhen(true)
        } else if (Hub.pairedComputers.size > 1) {
            val up = Hub.pairedComputers
            b.setContentTitle("${up.size} computers").setShowWhen(false)
                .setContentText(up.joinToString(", ") { "${it.name} ${if (it.link.optString("state") == "online") "ready" else "away"}" })
        } else {
            val name = c.name
            val (title, text) = when (link.optString("state")) {
                "online" -> name to "Ready"
                "connecting" -> name to "Connecting"
                "unpaired" -> "Not paired yet" to "Open The Lab to pair it with your computer."
                else -> name to link.optString("detail").ifBlank { "Can't reach it right now" }
            }
            b.setContentTitle(title).setContentText(text).setShowWhen(false)
        }
        return b.build()
    }

    // What he asked for, so the card names the task rather than the step.
    private fun task(c: Computer): String? {
        val e = c.events.lastOrNull { it.optString("kind") == "you" } ?: return null
        val t = e.optString("scheduled").ifBlank { null } ?: plain(e.optString("text")).lineSequence().firstOrNull { it.isNotBlank() } ?: return null
        return if (t.length > 60) t.take(59).trimEnd() + "…" else t
    }

    // The newest question with no answer after it.
    private fun openAsk(c: Computer): JSONObject? {
        val at = c.events.indexOfLast { it.optString("kind") == "ask" }
        return c.events.getOrNull(at)
            ?.takeIf { a -> c.events.subList(at + 1, c.events.size).none { it.optString("kind") == "answered" && it.optString("ref") == a.optString("ref") } }
    }

    // After the replay. A question asked while the phone was away is too old
    // for onEvent to sound, but it can still be answered until it expires.
    fun onLoaded(c: Computer) {
        if (Hub.foreground && Hub.on === c) return
        val e = openAsk(c)?.takeIf { !it.optBoolean("onMac") } ?: return
        val nm = Hub.app.getSystemService(NotificationManager::class.java)
        if (nm.activeNotifications.none { it.id == code(c, e.optString("ref")) }) ask(Hub.app, c, e)
    }

    // Only events from the last couple of minutes notify, so a phone coming
    // back after a day offline doesn't replay a day of alerts.
    fun onEvent(c: Computer, e: JSONObject) {
        val context = Hub.app
        val nm = context.getSystemService(NotificationManager::class.java)
        val kind = e.optString("kind")
        if (kind == "answered") {
            return nm.cancel(code(c, e.optString("ref")))
        }
        if (kind == "done") {
            // Asked from the shade rather than kept in memory, so it still works after the process restarts.
            for (n in nm.activeNotifications) if (n.notification.channelId == "asks" && isFrom(n, c)) nm.cancel(n.id)
        }
        val at = c.phoneTime(e.optString("at")) ?: 0
        if (System.currentTimeMillis() - at > 120_000) return
        // A scheduled run with nothing to say stays quiet.
        if (e.optBoolean("silent")) return
        if (kind == "you" || kind == "reply" || kind == "file") {
            val label = e.optString("scheduled")
            val text = if (kind == "file") "Sent you ${e.optString("name")}" else if (label.isNotEmpty()) "$label: ${plain(e.optString("text"))}" else plain(e.optString("text"))
            // A turn the server started itself, like Self-Repair, wasn't his.
            c.recent.addLast(Triple(text, at, if (kind != "you") "mac" else if (e.optBoolean("auto")) "lab" else "me"))
            while (c.recent.size > 6) c.recent.removeFirst()
        }
        // Someone at the computer with The Lab in front already sees it there.
        if ((Hub.foreground && Hub.on === c) || e.optBoolean("onMac")) return
        val b = when (kind) {
            "reply", "file" -> {
                val mac = Person.Builder().setName(c.name).setKey("mac").build()
                val me = Person.Builder().setName("You").setKey("me").build()
                val lab = Person.Builder().setName("The Lab").setKey("lab").build()
                conversation(context, c, mac)
                val style = Notification.MessagingStyle(me)
                for ((text, time, who) in c.recent) style.addMessage(text, time, when (who) { "me" -> null; "lab" -> lab; else -> mac })
                val input = RemoteInput.Builder(AnswerReceiver.TEXT).setLabel("Message your computer").build()
                val reply = PendingIntent.getBroadcast(
                    context, 20 + c.slot * 100, Intent(context, AnswerReceiver::class.java).setAction(AnswerReceiver.REPLY).putExtra("computer", c.id),
                    PendingIntent.FLAG_MUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
                )
                Notification.Builder(context, "replies")
                    .setStyle(style)
                    .setShortcutId(shortcutId(c))
                    .setCategory(Notification.CATEGORY_MESSAGE)
                    .addAction(Notification.Action.Builder(null, "Reply", reply).addRemoteInput(input).setAllowGeneratedReplies(false).build())
            }
            "ask" -> return ask(context, c, e)
            "notice" -> Notification.Builder(context, "notices")
                .setContentTitle(named(c, "The Lab"))
                .setContentText(e.optString("text"))
                .setStyle(Notification.BigTextStyle().bigText(e.optString("text")))
            else -> return
        }
        val id = nid(c, if (kind == "notice") NOTICE_ID else REPLY_ID)
        nm.notify(id, b.setSmallIcon(R.drawable.ic_status).setColor(VIOLET).setContentIntent(open(context, c)).setAutoCancel(true).addExtras(whose(c)).build())
    }

    private fun ask(context: Context, c: Computer, e: JSONObject) {
        val ref = e.optString("ref")
        val code = code(c, ref)
        val at = c.phoneTime(e.optString("at")) ?: System.currentTimeMillis()
        // The computer gives up on a question after five minutes, and the card goes with it.
        val left = at + ASK_MS - System.currentTimeMillis()
        if (left <= 0) return
        // His words first, as on the card. The command stays in the app.
        val facts = e.optJSONArray("facts")?.let { a -> (0 until a.length()).map { a.optString(it) } }.orEmpty()
        val lines = listOfNotNull(e.optString("from").ifBlank { null }) + facts + listOfNotNull(e.optString("why").ifBlank { null }?.let { "The agent says: $it" })
        val text = lines.ifEmpty { listOf(e.optString("detail")) }.joinToString("\n")
        context.getSystemService(NotificationManager::class.java).notify(code, Notification.Builder(context, "asks")
            .setSmallIcon(R.drawable.ic_status).setColor(VIOLET)
            .setContentTitle(named(c, e.optString("title")))
            .setContentText(lines.firstOrNull() ?: e.optString("detail"))
            .setStyle(Notification.BigTextStyle().bigText(text))
            .setCategory(Notification.CATEGORY_REMINDER)
            .setTimeoutAfter(left)
            // Allowing runs something on his computer, so it shouldn't work from a locked phone.
            .addAction(Notification.Action.Builder(null, "Deny", action(context, c, AnswerReceiver.DENY, ref, code + 1)).setAuthenticationRequired(true).build())
            .addAction(Notification.Action.Builder(null, "Allow", action(context, c, AnswerReceiver.ALLOW, ref, code)).setAuthenticationRequired(true).build())
            .setContentIntent(open(context, c)).setAutoCancel(true).addExtras(whose(c))
            .build())
    }

    // Replies are Markdown, which a notification would show as asterisks.
    private fun plain(s: String) = s.replace(Regex("```[\\s\\S]*?```"), " ")
        .replace(Regex("\\[([^\\]]+)]\\([^)]*\\)"), "$1")
        .replace(Regex("[*`#>]"), "")
        .replace(Regex("[ \\t]+"), " ")
        .trim()

    // Android only files a notification under Conversations when it points at
    // a long-lived shortcut for the person it's from.
    private fun conversation(context: Context, c: Computer, mac: Person) {
        val open = Intent(context, MainActivity::class.java).setAction(Intent.ACTION_MAIN).putExtra("computer", c.id)
        val info = ShortcutInfo.Builder(context, shortcutId(c))
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

    fun shareTarget(context: Context, c: Computer) = conversation(context, c, Person.Builder().setName(c.name).setKey("mac").build())
    const val SHARE_CATEGORY = "com.somethingobvious.thelab.category.SHARE"


    fun answerFailed(context: Context, c: Computer, ref: String) {
        val code = code(c, ref)
        context.getSystemService(NotificationManager::class.java).notify(code, Notification.Builder(context, "asks")
            .setSmallIcon(R.drawable.ic_status).setColor(VIOLET)
            .setContentTitle("Your answer didn't go through")
            .setContentText("Couldn't reach the computer. Open The Lab to answer.")
            .setContentIntent(open(context, c)).setAutoCancel(true)
            .build())
    }

    // Replaces the question's own card, so it doesn't sound again.
    fun answerExpired(context: Context, c: Computer, ref: String) {
        context.getSystemService(NotificationManager::class.java).notify(code(c, ref), Notification.Builder(context, "asks")
            .setSmallIcon(R.drawable.ic_status).setColor(VIOLET)
            .setContentTitle("That question had already closed")
            .setContentText("It was answered already, or the agent stopped waiting and carried on without it.")
            .setOnlyAlertOnce(true)
            .setTimeoutAfter(10 * 60_000L)
            .setContentIntent(open(context, c)).setAutoCancel(true)
            .build())
    }

    fun queued(context: Context, c: Computer) {
        // On the quiet connection channel, since it's news about the link rather than something to act on.
        context.getSystemService(NotificationManager::class.java).notify(nid(c, QUEUED_ID), Notification.Builder(context, "status")
            .setSmallIcon(R.drawable.ic_status).setColor(VIOLET)
            .setContentTitle("Your message is saved")
            .setContentText("It'll go to the computer as soon as it's back.")
            .setContentIntent(open(context, c)).setAutoCancel(true)
            .build())
    }

    fun sent(context: Context, c: Computer) = context.getSystemService(NotificationManager::class.java).cancel(nid(c, QUEUED_ID))

    fun unsent(c: Computer, text: String) {
        val context = Hub.app
        context.getSystemService(NotificationManager::class.java).notify(nid(c, UNSENT_ID), Notification.Builder(context, "notices")
            .setSmallIcon(R.drawable.ic_status).setColor(VIOLET)
            .setContentTitle("A message didn't go through")
            .setContentText(text)
            .setStyle(Notification.BigTextStyle().bigText("The computer couldn't take this message, so it wasn't sent:\n\n$text"))
            .setContentIntent(open(context, c)).setAutoCancel(true)
            .build())
    }

    fun confirmPair(context: Context) {
        context.getSystemService(NotificationManager::class.java).notify(PAIR_ID, Notification.Builder(context, "notices")
            .setSmallIcon(R.drawable.ic_status).setColor(VIOLET)
            .setContentTitle("Add another computer?")
            .setContentText("Tap to say yes or no. Nothing changes until you do.")
            .setContentIntent(open(context, Hub.on)).setAutoCancel(true)
            .build())
    }

    fun pairAnswered(context: Context) = context.getSystemService(NotificationManager::class.java).cancel(PAIR_ID)

    fun stopFailed(context: Context, c: Computer) {
        context.getSystemService(NotificationManager::class.java).notify(nid(c, STOP_ID), Notification.Builder(context, "notices")
            .setSmallIcon(R.drawable.ic_status).setColor(VIOLET)
            .setContentTitle("Couldn't reach the computer to stop it")
            .setContentText("It's probably still working. Open The Lab to try again.")
            .setContentIntent(open(context, c)).setAutoCancel(true)
            .build())
    }

    fun clearReplies(context: Context, c: Computer) {
        c.recent.clear()
        val nm = context.getSystemService(NotificationManager::class.java)
        for (id in listOf(REPLY_ID, NOTICE_ID, STOP_ID, QUEUED_ID)) nm.cancel(nid(c, id))
    }

    // Its Allow cards go too, as there's nothing left to answer them with.
    fun clearAll(context: Context, c: Computer) {
        clearReplies(context, c)
        val nm = context.getSystemService(NotificationManager::class.java)
        nm.cancel(nid(c, UNSENT_ID))
        for (n in nm.activeNotifications) if (n.notification.channelId == "asks" && isFrom(n, c)) nm.cancel(n.id)
        runCatching { context.getSystemService(ShortcutManager::class.java).removeLongLivedShortcuts(listOf(shortcutId(c))) }
    }
}

class AnswerReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        Hub.init(context)
        val ref = intent.getStringExtra("ref").orEmpty()
        val c = Hub.computer(intent.getStringExtra("computer"))
        val card = Notifier.card(c, ref)
        when (intent.action) {
            ALLOW, DENY -> {
                val pending = goAsync()
                c.answer(ref, intent.action == ALLOW) { code ->
                    when (code) {
                        in 200..299 -> context.getSystemService(NotificationManager::class.java).cancel(card)
                        404 -> Notifier.answerExpired(context, c, ref)
                        else -> Notifier.answerFailed(context, c, ref)
                    }
                    pending.finish()
                }
                return
            }
            SWIPED -> Notifier.swipedAway()
            STOP -> {
                val pending = goAsync()
                var finished = false
                val finish = { if (!finished) { finished = true; pending.finish() } }
                // A stop can outlast the 10 s a receiver gets, and the link
                // service keeps the process alive for the answer.
                Hub.onMain(9_000) { finish() }
                c.stop { ok ->
                    if (!ok) Notifier.stopFailed(context, c)
                    finish()
                }
                return
            }
            REPLY -> {
                val text = RemoteInput.getResultsFromIntent(intent)?.getCharSequence(TEXT)?.toString()?.trim().orEmpty()
                Notifier.clearReplies(context, c)
                if (text.isNotEmpty()) {
                    val cid = UUID.randomUUID().toString()
                    c.send(text, cid, null)
                    if (Hub.paired) LinkService.start(context)
                    // Long enough for a cold start to reach the computer, so the line only shows when it can't.
                    Hub.onMain(15_000) { if (c.queued(cid)) Notifier.queued(Hub.app, c) }
                }
            }
        }
        if (ref.isNotEmpty()) context.getSystemService(NotificationManager::class.java).cancel(card)
    }

    companion object {
        const val ALLOW = "com.somethingobvious.thelab.ALLOW"
        const val DENY = "com.somethingobvious.thelab.DENY"
        const val STOP = "com.somethingobvious.thelab.STOP"
        const val SWIPED = "com.somethingobvious.thelab.SWIPED"
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
        resultCode = 0
        // Anything holding WRITE_SECURE_SETTINGS can send this, so adding a
        // computer it doesn't know waits for his yes on the phone.
        if (!Hub.paired || Hub.known(url, tunnel) != null) {
            Hub.pair(url, tunnel, token)
            resultData = "paired"
        } else {
            Hub.pendingPair = Hub.Pairing(url, tunnel, token)
            Notifier.confirmPair(context)
            resultData = "confirm on the phone"
        }
    }
}

class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        // It's exported, so any app could send it an intent of its own.
        if (intent.action != Intent.ACTION_BOOT_COMPLETED && intent.action != Intent.ACTION_MY_PACKAGE_REPLACED) return
        Hub.init(context)
        if (Hub.paired) LinkService.start(context)
    }
}

class App : android.app.Application() {
    override fun onCreate() {
        super.onCreate()
        Hub.init(this)
        Notifier.channels(this)
        for (c in Hub.pairedComputers) Notifier.shareTarget(this, c)
    }
}
