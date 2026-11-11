package com.somethingobvious.thelab

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInfo
import android.content.pm.PackageInstaller
import android.content.pm.PackageManager
import android.os.SystemClock
import android.util.Log
import android.widget.Toast
import androidx.core.content.edit
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.security.MessageDigest
import java.util.concurrent.FutureTask
import kotlin.concurrent.thread

// A computer that set this phone up builds the app again after it updates
// itself and offers it here. Android only installs a copy signed with the same
// key over this one, so these checks mostly keep a copy that can't install
// from getting that far. Once he has let The Lab install apps, Android skips
// its own prompt for an app updating itself.
object AppUpdate {
    internal const val TAG = "Lab"
    // Long enough that a quick look at another app isn't taken as him leaving.
    private const val AWAY_FOR = 2 * 60_000L
    private const val RETRY_AFTER = 5 * 60_000L
    private const val LATER_FOR = 24 * 60 * 60_000L
    private const val CAME_BACK = "He came back, so it waits."

    private val ownCert by lazy {
        certOf(Hub.app.packageManager.getPackageInfo(Hub.app.packageName, PackageManager.GET_SIGNING_CERTIFICATES))
    }
    private val prefs get() = Hub.app.getSharedPreferences("lab", Context.MODE_PRIVATE)
    private var busy = false
    private var lastAuto = -RETRY_AFTER
    private val again = Runnable { maybeAuto() }
    // He turned an update down, or Android wanted his OK for one, so only the
    // prompt in the app offers it until the app starts again.
    var needsTap = false
    // A picker or the speech screen The Lab opened is on top, and an install would lose what he's doing there.
    var held = false
    // Android's prompt for an install he left the app during, shown when he comes back.
    var confirm: Intent? = null
    // When he last left the app, or when this process started, which is often
    // just before he opens it, so an update never closes it under him.
    private var leftAt = SystemClock.elapsedRealtime()

    // A computer whose key didn't sign this copy offers nothing, since its build couldn't install.
    fun offer(c: Computer): JSONObject? {
        val a = c.live["app"] ?: return null
        if (!newerVersion(a.optString("version"), BuildConfig.VERSION_NAME)) return null
        return a.takeIf { ownCert != null && it.optString("cert").equals(ownCert, ignoreCase = true) }
    }

    fun best(): Pair<Computer, JSONObject>? =
        Hub.pairedComputers.firstNotNullOfOrNull { c -> offer(c)?.let { c to it } }

    fun later(version: String) =
        prefs.edit { putString("updateLater", version).putLong("updateLaterAt", System.currentTimeMillis()) }

    fun putOff(version: String) =
        prefs.getString("updateLater", null) == version && System.currentTimeMillis() - prefs.getLong("updateLaterAt", 0) < LATER_FOR

    fun left() {
        leftAt = SystemClock.elapsedRealtime()
        maybeAuto()
    }

    // Installs by itself only while he's away from the app, nothing is running
    // on a computer, and that computer still updates itself (Settings, Updates).
    // A task ending calls this again through Hub.changed.
    fun maybeAuto() {
        if (busy || needsTap || held || Hub.foreground) return
        val (c, a) = best() ?: return
        val v = a.optString("version")
        if (putOff(v) || c.live["settings"]?.optJSONObject("values")?.optBoolean("autoUpdate", true) == false) return
        if (Hub.pairedComputers.any { it.working } || !Hub.app.packageManager.canRequestPackageInstalls()) return
        val wait = maxOf(leftAt + AWAY_FOR, lastAuto + RETRY_AFTER) - SystemClock.elapsedRealtime()
        if (wait > 0) {
            Hub.offMain(again)
            Hub.onMain(wait + 1_000, again)
            return
        }
        lastAuto = SystemClock.elapsedRealtime()
        if (Log.isLoggable(TAG, Log.INFO)) Log.i(TAG, "update: installing $v from ${c.name} by itself")
        install(c, a, auto = true) { err ->
            if (err == null) return@install
            Log.w(TAG, "update: $err")
            // Only a real failure waits for the retry, and his coming back doesn't count as one.
            if (err == CAME_BACK) lastAuto = -RETRY_AFTER
        }
    }

    // Calls done with what went wrong, or null once Android has the install.
    fun install(c: Computer, a: JSONObject, auto: Boolean = false, done: (String?) -> Unit) {
        if (busy) return
        busy = true
        thread(name = "update") {
            val f = File(Hub.app.cacheDir, "update.apk")
            val err = try {
                when {
                    !c.download("/phone/app.apk", f) -> "Couldn't get the update from ${c.name}. Try again once it's connected."
                    !hashOf(f).equals(a.optString("sha256"), ignoreCase = true) -> "The update didn't arrive whole. Try again."
                    !fits(f, a.optString("version")) -> "That update isn't The Lab signed the way this copy is, so it wasn't installed."
                    // Again on the main thread, since the download took a while and an install closes the app.
                    auto && !stillAway() -> CAME_BACK
                    else -> { commit(f); null }
                }
            } catch (e: IOException) {
                "Couldn't install the update: ${e.message}"
            } catch (e: SecurityException) {
                "Android didn't let The Lab install the update: ${e.message}"
            } finally {
                f.delete()
            }
            Hub.onMain { busy = false; done(err) }
        }
    }

    // ponytail: his return or a new task in the moment between this check and Android's install still gets closed, since a commit can't be taken back.
    private fun stillAway(): Boolean {
        val check = FutureTask { !Hub.foreground && !held && Hub.pairedComputers.none { it.working } }
        Hub.onMain(r = check)
        return check.get()
    }

    private fun fits(f: File, version: String): Boolean {
        val info = Hub.app.packageManager.getPackageArchiveInfo(f.path, PackageManager.GET_SIGNING_CERTIFICATES) ?: return false
        return info.packageName == Hub.app.packageName && info.versionName == version && certOf(info) == ownCert
    }

    // Only ever this app, whatever the file says it is.
    private fun commit(f: File) {
        val installer = Hub.app.packageManager.packageInstaller
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply {
            setAppPackageName(Hub.app.packageName)
            setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED)
        }
        val id = installer.createSession(params)
        try {
            installer.openSession(id).use { s ->
                s.openWrite("app.apk", 0, f.length()).use { out ->
                    f.inputStream().use { it.copyTo(out) }
                    s.fsync(out)
                }
                // Mutable so the installer can add the result. The intent names its receiver, so nothing else gets it.
                val result = PendingIntent.getBroadcast(Hub.app, id, Intent(Hub.app, UpdateReceiver::class.java), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE)
                s.commit(result.intentSender)
            }
        } catch (e: Exception) {
            // Otherwise the staged copy stays on the phone until Android clears old sessions out.
            runCatching { installer.abandonSession(id) }
            throw e
        }
    }

    private fun certOf(info: PackageInfo?): String? =
        info?.signingInfo?.apkContentsSigners?.singleOrNull()?.toByteArray()?.let { hex(MessageDigest.getInstance("SHA-256").digest(it)) }

    private fun hashOf(f: File): String {
        val d = MessageDigest.getInstance("SHA-256")
        f.inputStream().use { input ->
            val buf = ByteArray(1 shl 16)
            while (true) {
                val n = input.read(buf)
                if (n < 0) break
                d.update(buf, 0, n)
            }
        }
        return hex(d.digest())
    }

    private fun hex(b: ByteArray) = b.joinToString("") { "%02x".format(it) }
}

// Not exported, so only the installer's answer to our own session lands here.
class UpdateReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        Hub.init(context)
        when (intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)) {
            PackageInstaller.STATUS_PENDING_USER_ACTION -> {
                val ask = intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent::class.java) ?: return
                AppUpdate.needsTap = true
                // Never a prompt over whatever he's doing in another app, so it waits for him to come back.
                if (Hub.foreground) context.startActivity(ask.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                else AppUpdate.confirm = ask
            }
            PackageInstaller.STATUS_SUCCESS -> Unit
            // His Cancel on Android's prompt, which the automatic install respects too.
            PackageInstaller.STATUS_FAILURE_ABORTED -> AppUpdate.needsTap = true
            else -> {
                val why = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE) ?: "Android didn't say why"
                Log.w(AppUpdate.TAG, "update: didn't install: $why")
                if (Hub.foreground) Toast.makeText(context, "The update didn't install: $why", Toast.LENGTH_LONG).show()
            }
        }
    }
}

// Whether version a comes after b, as in 1.10.0 after 1.9.2.
internal fun newerVersion(a: String, b: String): Boolean {
    val x = a.split('.').map { it.toIntOrNull() ?: 0 }
    val y = b.split('.').map { it.toIntOrNull() ?: 0 }
    for (k in 0 until maxOf(x.size, y.size)) {
        val d = x.getOrElse(k) { 0 } - y.getOrElse(k) { 0 }
        if (d != 0) return d > 0
    }
    return false
}
