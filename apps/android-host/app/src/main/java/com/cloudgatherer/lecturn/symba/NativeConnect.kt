package com.cloudgatherer.lecturn.symba

import android.app.Application
import com.clerk.api.Clerk
import com.clerk.api.ClerkConfigurationOptions
import com.clerk.api.network.serialization.ClerkResult
import com.clerk.api.session.GetTokenOptions
import com.clerk.api.session.Session
import com.clerk.api.user.User
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import org.json.JSONObject
import java.util.function.Consumer

internal data class ConnectSession(val id: String, val accountId: String, val email: String?)
internal data class ConnectSdkState(val ready: Boolean, val failed: Boolean, val session: ConnectSession?)
internal interface ConnectSdk {
    val changes: Flow<ConnectSdkState>
    fun snapshot(): ConnectSdkState
    fun initialize()
    fun retry()
    fun reset()
    suspend fun token(): String?
    suspend fun signOut(): Boolean
}

internal fun activeConnectSession(session: Session?, user: User?, now: Long): ConnectSession? =
    session?.takeIf {
        it.status == Session.SessionStatus.ACTIVE && it.currentTask == null && it.tasks.isEmpty()
            && it.expireAt > now && user != null && it.user?.id == user.id
    }?.let { ConnectSession(it.id, user!!.id, user.primaryEmailAddress?.emailAddress) }

/** Only this adapter touches Clerk. No credentials are copied into host preferences or runtime files. */
internal class ClerkConnectSdk(private val app: Application) : ConnectSdk {
    private val configurationFailed = MutableStateFlow(false)
    override val changes = combine(
        Clerk.isInitialized, Clerk.initializationError, Clerk.sessionFlow, Clerk.userFlow, configurationFailed,
    ) { _, _, _, _, _ -> snapshot() }.distinctUntilChanged()

    override fun snapshot(): ConnectSdkState {
        return ConnectSdkState(
            Clerk.isInitialized.value,
            configurationFailed.value || Clerk.initializationError.value != null,
            activeConnectSession(Clerk.session, Clerk.user, System.currentTimeMillis()),
        )
    }

    override fun initialize() {
        try {
            Clerk.initialize(app, BuildConfig.LECTURN_CLERK_PUBLISHABLE_KEY,
                ClerkConfigurationOptions(enableDebugMode = false, telemetryEnabled = false))
            configurationFailed.value = false
        } catch (_: Exception) { configurationFailed.value = true }
    }
    override fun retry() {
        if (configurationFailed.value) initialize() else Clerk.reinitialize()
    }
    override fun reset() { Clerk.reset(); initialize() }
    override suspend fun token(): String? = when (val result = Clerk.auth.getToken(
        GetTokenOptions(template = BuildConfig.LECTURN_CLERK_JWT_TEMPLATE, skipCache = true),
    )) {
        is ClerkResult.Success -> result.value.takeIf { it.isNotBlank() }
        is ClerkResult.Failure -> null
    }
    override suspend fun signOut(): Boolean {
        // The SDK clears local credentials even when revocation fails. Reset additionally fences
        // cached client state and in-flight refresh work before another auth attempt or app restart.
        return try { Clerk.auth.signOut() is ClerkResult.Success }
        finally { Clerk.reset(); initialize() }
    }
}

internal data class ConnectState(
    val configured: Boolean,
    val state: String = if (configured) "loading" else "signed-out",
    val account: ConnectSession? = null,
    val relayUrl: String? = null,
    val error: String? = null,
) {
    fun json(): JSONObject = JSONObject().put("configured", configured).put("state", state)
        .put("account", account?.let {
            JSONObject().put("id", it.accountId).apply { it.email?.let { email -> put("email", email) } }
        } ?: JSONObject.NULL).put("relayUrl", relayUrl ?: JSONObject.NULL)
        .apply { error?.let { put("error", it) } }
}

/** Process-scoped auth owner; auth UI can outlive any individual bridge request or host Activity. */
class NativeConnect internal constructor(
    private val configured: Boolean,
    private val relayUrl: String?,
    private val sdk: ConnectSdk,
    private val scope: CoroutineScope,
) {
    constructor(app: Application) : this(BuildConfig.CONNECT_CONFIGURED,
        BuildConfig.LECTURN_RELAY_URL.takeIf { BuildConfig.CONNECT_CONFIGURED }, ClerkConnectSdk(app),
        CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate))

    private val mutableState = MutableStateFlow(ConnectState(configured, relayUrl = relayUrl))
    internal val state = mutableState.asStateFlow()
    private val mutablePresented = MutableStateFlow(false)
    internal val presented = mutablePresented.asStateFlow()
    private var generation = 0L
    private var signingOut = false
    private var storageUnavailable = false
    private var refreshSequence = 0L

    fun initialize() {
        if (!configured) return
        sdk.initialize()
        scope.launch { sdk.changes.collectLatest { refresh() } }
    }

    /** The Activity owns cancellation; equal states never trigger another web refresh. */
    fun subscribe(listener: Runnable): Runnable {
        val job = scope.launch { state.collect { listener.run() } }
        return Runnable { job.cancel() }
    }

    private fun publish(status: String, account: ConnectSession? = null, error: String? = null) {
        mutableState.value = ConnectState(configured, status, account, relayUrl, error)
    }
    private fun pending(snapshot: ConnectSdkState) {
        when {
            snapshot.failed -> publish("error", error = "Sign-in is unavailable. Check your connection and retry.")
            snapshot.ready && snapshot.session != null && state.value.state == "signed-in"
                && state.value.account == snapshot.session -> Unit
            mutablePresented.value -> publish("authorizing")
            !snapshot.ready || snapshot.session != null -> publish("loading")
            else -> publish("signed-out")
        }
    }
    internal suspend fun refresh(): ConnectState {
        if (!configured || signingOut || storageUnavailable) return state.value
        val version = generation
        val sequence = ++refreshSequence
        val before = sdk.snapshot()
        if (!before.ready || before.failed) {
            pending(before)
            return state.value
        }
        val session = before.session
        if (session == null) { pending(before); return state.value }
        // Stable signed-in/error reads must not oscillate through loading and retrigger web reads.
        if (state.value.state == "signed-out"
            || (state.value.state == "signed-in" && state.value.account != session)) pending(before)
        val token = fetchToken(session, version)
        if (version != generation || sequence != refreshSequence || signingOut) return state.value
        val after = sdk.snapshot()
        if (!after.ready || after.failed || after.session != session) { pending(after); return state.value }
        if (token == null) publish("error", error = "Could not verify your account. Check your connection and retry.")
        else publish("signed-in", session)
        return state.value
    }
    private suspend fun fetchToken(expected: ConnectSession, version: Long): String? {
        if (signingOut || storageUnavailable || version != generation || !sdk.snapshot().ready
            || sdk.snapshot().session != expected) return null
        val result = try { withTimeoutOrNull(30_000) { sdk.token() } }
        catch (cancelled: CancellationException) { throw cancelled }
        catch (_: Exception) { null }
        return result?.takeIf {
            version == generation && !signingOut && !storageUnavailable
                && sdk.snapshot().ready && sdk.snapshot().session == expected
        }
    }
    fun getState(reply: Consumer<JSONObject>) { scope.launch { reply.accept(refresh().json()) } }
    fun deliveryContext(accountId: String): String? {
        val snapshot = sdk.snapshot()
        val session = snapshot.session
        return if (configured && !signingOut && !storageUnavailable && snapshot.ready && session?.accountId == accountId)
            "$generation:${session.id}" else null
    }
    fun getToken(accountId: String, reply: Consumer<JSONObject>) {
        scope.launch {
            val session = sdk.snapshot().session?.takeIf { configured && it.accountId == accountId }
            val token = session?.let { fetchToken(it, generation) }
            reply.accept(JSONObject().put("token", token ?: JSONObject.NULL))
        }
    }
    fun open(): JSONObject {
        if (!configured || signingOut) return state.value.json()
        generation++
        mutablePresented.value = true
        publish("authorizing")
        if (!storageUnavailable) sdk.retry()
        return state.value.json()
    }
    fun dismiss() {
        if (!mutablePresented.value) return
        mutablePresented.value = false
        // Keep any actual completed SDK session; dismissing the UI cannot manufacture one.
        generation++
        if (!storageUnavailable) pending(sdk.snapshot())
        scope.launch { refresh() }
    }
    fun launchFailed() {
        dismiss()
        publish("error", error = "Sign-in could not open. Please retry.")
    }
    fun signOut(reply: Consumer<JSONObject>) {
        if (!configured || signingOut) { reply.accept(state.value.json()); return }
        signingOut = true
        generation++
        mutablePresented.value = false
        publish("signed-out")
        scope.launch {
            var localFailure = false
            val revoked = try { withTimeoutOrNull(30_000) { sdk.signOut() } == true }
            catch (cancelled: CancellationException) { throw cancelled }
            catch (_: Exception) { localFailure = true; false }
            signingOut = false
            storageUnavailable = localFailure
            if (localFailure) publish("error", error = "Saved sign-in could not be cleared. Reopen sign-in and reset it on this phone.")
            else publish("signed-out", error = if (revoked) null else
                    "Signed out on this phone. Server sign-out could not be confirmed.")
            reply.accept(state.value.json())
        }
    }
    internal fun retry() {
        if (storageUnavailable) resetSignIn() else sdk.retry()
        scope.launch { refresh() }
    }
    internal fun resetSignIn() {
        generation++
        try { sdk.reset(); storageUnavailable = false; pending(sdk.snapshot()) }
        catch (_: Exception) {
            storageUnavailable = true
            publish("error", error = "Saved sign-in could not be reset. Close and reopen Lecturn, then retry.")
        }
    }
}
