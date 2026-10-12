package com.cloudgatherer.lecturn.symba

import android.os.Build
import android.os.Bundle
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.lifecycleScope
import com.clerk.api.Clerk
import com.clerk.api.ui.ClerkColors
import com.clerk.api.ui.ClerkTheme
import com.clerk.ui.auth.AuthView
import kotlinx.coroutines.launch

/** No WebView, JS interface, runtime control, or device-policy surface exists in this Activity. */
class ConnectAuthActivity : ComponentActivity() {
    private val connect get() = (application as HostApplication).connect

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        if (Build.VERSION.SDK_INT >= 31) window.setHideOverlayWindows(true)
        // Android may restore this Activity after process death. Reopen only the native flow;
        // authentication still comes from the SDK's restored and freshly verified session.
        if (!BuildConfig.CONNECT_CONFIGURED) { finish(); return }
        if (!connect.presented.value) connect.open()
        setContent {
            val state by connect.state.collectAsStateWithLifecycle()
            val presented by connect.presented.collectAsStateWithLifecycle()
            val ready by Clerk.isInitialized.collectAsStateWithLifecycle()
            val complete by Clerk.isAuthFlowCompleteFlow.collectAsStateWithLifecycle()
            var resetConfirmation by remember { mutableStateOf(false) }
            LaunchedEffect(presented) { if (!presented) finish() }
            LaunchedEffect(state.state, complete) {
                if (state.state == "signed-in" && complete) finish()
            }
            MaterialTheme(colorScheme = darkColorScheme(
                primary = Color(0xFFC5ABFF), onPrimary = Color(0xFF261147),
                background = Navy, surface = Navy, onBackground = Ink, onSurface = Ink,
                secondary = Gold,
            )) {
                Column(Modifier.fillMaxSize().background(Navy).safeDrawingPadding().imePadding()) {
                    Row(Modifier.fillMaxWidth().padding(start = 20.dp, end = 8.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.SpaceBetween) {
                        Text("Lecturn Connect", color = Gold, style = MaterialTheme.typography.titleLarge)
                        TextButton(onClick = { finish() }) { Text("Close") }
                    }
                    Text("Can’t find your verification email? Check spam or junk for an email from Lecturn.",
                        modifier = Modifier.padding(horizontal = 20.dp, vertical = 12.dp),
                        style = MaterialTheme.typography.bodyMedium)
                    Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.Center) {
                        when {
                            state.state == "error" -> Column(Modifier.padding(24.dp),
                                verticalArrangement = Arrangement.spacedBy(16.dp)) {
                                Text(state.error ?: "Sign-in is unavailable.")
                                Button(onClick = { retrySignIn() }) { Text("Retry") }
                            }
                            !ready -> Column(horizontalAlignment = Alignment.CenterHorizontally,
                                verticalArrangement = Arrangement.spacedBy(16.dp)) {
                                CircularProgressIndicator()
                                Text("Preparing secure sign-in…")
                                TextButton(onClick = { retrySignIn() }) { Text("Retry connection") }
                            }
                            else -> AuthView(
                                modifier = Modifier.fillMaxSize(),
                                clerkTheme = AuthTheme,
                                isDismissible = false,
                                persistIdentifiers = false,
                                onAuthComplete = { lifecycleScope.launch {
                                    if (connect.refresh().state == "signed-in") finish()
                                } },
                            )
                        }
                    }
                    TextButton(onClick = { resetConfirmation = true },
                        modifier = Modifier.align(Alignment.CenterHorizontally)) {
                        Text("Reset sign-in on this phone")
                    }
                    if (resetConfirmation) AlertDialog(
                        onDismissRequest = { resetConfirmation = false },
                        title = { Text("Reset saved sign-in?") },
                        text = { Text("Clear this phone’s saved Connect sign-in if it cannot be restored. You will need to sign in again. This does not revoke sessions on other devices.") },
                        confirmButton = { TextButton(onClick = {
                            resetConfirmation = false
                            connect.resetSignIn()
                            Clerk.attachActivity(this@ConnectAuthActivity)
                        }) { Text("Reset sign-in") } },
                        dismissButton = { TextButton(onClick = { resetConfirmation = false }) { Text("Cancel") } },
                    )
                }
            }
        }
    }

    override fun onResume() {
        super.onResume()
        retrySignIn()
    }
    private fun retrySignIn() {
        connect.retry()
        // Reset/retry can initialize Clerk with Application context after this Activity resumed.
        // Seed its credential Activity before AuthView can launch Google or passkey UI.
        Clerk.attachActivity(this)
    }
    override fun finish() {
        // onDestroy can run after the host's onResume/status read.
        connect.dismiss()
        super.finish()
    }
    override fun onDestroy() {
        if (isFinishing) connect.dismiss()
        super.onDestroy()
    }

    private companion object {
        val Navy = Color(0xFF142331)
        val Ink = Color(0xFFF6F0E6)
        val Gold = Color(0xFFF2C775)
        val AuthTheme = ClerkTheme(colors = ClerkColors(
            primary = Color(0xFFB798F1), primaryForeground = Color(0xFF211032),
            background = Navy, foreground = Ink, input = Color(0xFF223646), inputForeground = Ink,
            mutedForeground = Color(0xFFCBD1DD), muted = Color(0xFF223646),
            neutral = Color(0xFF8995A5), border = Color(0xFF718096), ring = Gold,
            secondaryButtonBackground = Color(0xFF293D50), secondaryButtonForeground = Ink,
            danger = Color(0xFFFFB4AB), success = Color(0xFF91D9B5), warning = Gold,
        ))
    }
}
