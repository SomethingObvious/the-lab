package com.somethingobvious.thelab

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.app.PendingIntent
import android.content.pm.PackageInfo
import android.content.pm.PackageInstaller
import android.content.pm.PackageManager
import android.widget.Toast
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.security.MessageDigest
import kotlin.concurrent.thread

// A computer that set this phone up builds the app again after it updates
// itself and offers it here. Android only installs a copy signed with the same
// key over this one, and he confirms every install, so these checks mostly
// keep a copy that can't install from getting as far as asking him.
object AppUpdate {
    private val ownCert by lazy {
        certOf(Hub.app.packageManager.getPackageInfo(Hub.app.packageName, PackageManager.GET_SIGNING_CERTIFICATES))
    }
    private var busy = false

    // A computer whose key didn't sign this copy offers nothing, since its build couldn't install.
    fun offer(c: Computer): JSONObject? {
        val a = c.live["app"] ?: return null
        if (!newerVersion(a.optString("version"), BuildConfig.VERSION_NAME)) return null
        return a.takeIf { ownCert != null && it.optString("cert").equals(ownCert, ignoreCase = true) }
    }

    fun best(): Pair<Computer, JSONObject>? =
        Hub.pairedComputers.firstNotNullOfOrNull { c -> offer(c)?.let { c to it } }

    // Calls done with what went wrong, or null once Android has the install and asks him.
    fun install(c: Computer, a: JSONObject, done: (String?) -> Unit) {
        if (busy) return
        busy = true
        thread(name = "update") {
            val f = File(Hub.app.cacheDir, "update.apk")
            val err = try {
                when {
                    !c.download("/phone/app.apk", f) -> "Couldn't get the update from ${c.name}. Try again once it's connected."
                    !hashOf(f).equals(a.optString("sha256"), ignoreCase = true) -> "The update didn't arrive whole. Try again."
                    !fits(f, a.optString("version")) -> "That update isn't The Lab signed the way this copy is, so it wasn't installed."
                    else -> { commit(f); null }
                }
            } catch (e: IOException) {
                "Couldn't install the update: ${e.message}"
            } catch (e: SecurityException) {
                "Android didn't let The Lab install the update: ${e.message}"
            }
            f.delete()
            Hub.onMain { busy = false; done(err) }
        }
    }

    private fun fits(f: File, version: String): Boolean {
        val info = Hub.app.packageManager.getPackageArchiveInfo(f.path, PackageManager.GET_SIGNING_CERTIFICATES) ?: return false
        return info.packageName == Hub.app.packageName && info.versionName == version && certOf(info) == ownCert
    }

    // Only ever this app, whatever the file says it is.
    private fun commit(f: File) {
        val installer = Hub.app.packageManager.packageInstaller
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL)
            .apply { setAppPackageName(Hub.app.packageName) }
        val id = installer.createSession(params)
        installer.openSession(id).use { s ->
            s.openWrite("app.apk", 0, f.length()).use { out ->
                f.inputStream().use { it.copyTo(out) }
                s.fsync(out)
            }
            // Mutable so the installer can add the result. The intent names its receiver, so nothing else gets it.
            val result = PendingIntent.getBroadcast(Hub.app, id, Intent(Hub.app, UpdateReceiver::class.java), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE)
            s.commit(result.intentSender)
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
        when (intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)) {
            PackageInstaller.STATUS_PENDING_USER_ACTION ->
                intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent::class.java)?.let {
                    context.startActivity(it.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                }
            // Done, and the new copy starts the link again from MY_PACKAGE_REPLACED. Aborted is his Cancel.
            PackageInstaller.STATUS_SUCCESS, PackageInstaller.STATUS_FAILURE_ABORTED -> Unit
            else -> Toast.makeText(
                context,
                "The update didn't install: ${intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE) ?: "Android didn't say why"}",
                Toast.LENGTH_LONG,
            ).show()
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
