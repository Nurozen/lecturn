package com.cloudgatherer.lecturn.symba

import com.clerk.api.session.Session
import com.clerk.api.session.SessionTask
import com.clerk.api.user.User
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class NativeConnectTest {
    private val account = ConnectSession("session-a", "user-a", "fixture@example.invalid")
    private class Sdk : ConnectSdk {
        override val changes = MutableStateFlow(ConnectSdkState(true, false, null))
        var tokenCalls = 0
        var retries = 0
        var resets = 0
        var initializeCalls = 0
        var tokenResult: String? = "synthetic-jwt"
        var tokenWait: CompletableDeferred<String?>? = null
        var logoutWait: CompletableDeferred<Boolean>? = null
        var resetError = false
        override fun snapshot() = changes.value
        override fun initialize() { initializeCalls++ }
        override fun retry() { retries++ }
        override fun reset() {
            resets++
            if (resetError) error("synthetic storage failure")
            changes.value = ConnectSdkState(false, false, null)
        }
        override suspend fun token(): String? {
            tokenCalls++
            return tokenWait?.await() ?: tokenResult
        }
        override suspend fun signOut(): Boolean = try { logoutWait?.await() ?: true }
        finally { changes.value = ConnectSdkState(true, false, null) }
    }

    @Test fun noConfigurationDoesNotInitializeSdkOrOfferSignIn() = runTest {
        val sdk = Sdk()
        val connect = NativeConnect(false, null, sdk, backgroundScope)
        connect.initialize()
        assertFalse(connect.open().getBoolean("configured"))
        assertFalse(connect.presented.value)
        assertEquals(0, sdk.initializeCalls)
        assertTrue(connect.refresh().json().isNull("relayUrl"))
    }

    @Test fun coldInitializationAndDelayedReadyNeverClaimSignedOut() = runTest {
        val sdk = Sdk().apply { changes.value = ConnectSdkState(false, false, null) }
        val connect = NativeConnect(true, "https://relay.example.invalid", sdk, backgroundScope)
        val observed = mutableListOf<String>()
        backgroundScope.launch(UnconfinedTestDispatcher(testScheduler)) {
            connect.state.collect { observed.add(it.state) }
        }
        assertEquals("loading", connect.state.value.json().getString("state"))
        connect.initialize(); runCurrent()
        assertEquals("loading", connect.refresh().state)
        connect.open(); connect.dismiss()
        assertEquals("loading", connect.state.value.state)
        runCurrent()
        sdk.tokenWait = CompletableDeferred()
        sdk.changes.value = ConnectSdkState(true, false, account); runCurrent()
        assertEquals("loading", connect.state.value.state)
        sdk.tokenWait!!.complete("synthetic-jwt"); runCurrent()
        assertEquals("signed-in", connect.state.value.state)
        assertFalse(observed.contains("signed-out"))
    }

    @Test fun onlyReadyWithoutActiveSessionSettlesColdStartupAsSignedOut() = runTest {
        val sdk = Sdk().apply { changes.value = ConnectSdkState(false, false, null) }
        val connect = NativeConnect(true, null, sdk, backgroundScope)
        connect.initialize(); runCurrent()
        assertEquals("loading", connect.state.value.state)
        sdk.changes.value = ConnectSdkState(true, false, null); runCurrent()
        assertEquals("signed-out", connect.state.value.state)
    }

    @Test fun cancellingCompletedLoginWhileTokenIsPendingDoesNotPublishLogout() = runTest {
        val sdk = Sdk().apply { tokenWait = CompletableDeferred() }
        val connect = NativeConnect(true, null, sdk, backgroundScope)
        val observed = mutableListOf<String>()
        backgroundScope.launch(UnconfinedTestDispatcher(testScheduler)) {
            connect.state.collect { observed.add(it.state) }
        }
        connect.open()
        sdk.changes.value = ConnectSdkState(true, false, account)
        connect.getState { }; runCurrent()
        connect.dismiss()
        assertEquals("loading", connect.state.value.state)
        runCurrent()
        sdk.tokenWait!!.complete("synthetic-jwt"); runCurrent()
        assertEquals("signed-in", connect.state.value.state)
        assertFalse(observed.contains("signed-out"))
    }

    @Test fun resetWithoutAuthSurfaceStaysLoadingUntilSdkRestores() = runTest {
        val sdk = Sdk().apply { changes.value = ConnectSdkState(true, false, account) }
        val connect = NativeConnect(true, null, sdk, backgroundScope)
        connect.refresh()
        connect.resetSignIn()
        assertEquals("loading", connect.state.value.state)
        assertEquals("loading", connect.refresh().state)
        assertNull(connect.state.value.account)
    }

    @Test fun accountChangeDuringVerificationDoesNotPublishTransientLogout() = runTest {
        val sdk = Sdk().apply {
            changes.value = ConnectSdkState(true, false, account)
            tokenWait = CompletableDeferred()
        }
        val connect = NativeConnect(true, null, sdk, backgroundScope)
        connect.getState { }; runCurrent()
        sdk.changes.value = ConnectSdkState(true, false, account.copy(id = "session-b", accountId = "user-b"))
        sdk.tokenWait!!.complete("synthetic-old-token"); runCurrent()
        assertEquals("loading", connect.state.value.state)
        assertNull(connect.state.value.account)
        assertEquals("user-b", connect.refresh().account!!.accountId)
    }

    @Test fun lateReadyNotifiesWebAndIdenticalReadsDoNotLoopAndUnsubscribeStopsDelivery() = runTest {
        val sdk = Sdk().apply { changes.value = ConnectSdkState(false, false, null) }
        val connect = NativeConnect(true, null, sdk, backgroundScope)
        val replies = mutableListOf<String>()
        var notifications = 0
        val unsubscribe = connect.subscribe {
            assertTrue("State notification loop", ++notifications < 10)
            connect.getState { replies.add(it.getString("state")) }
        }
        connect.initialize(); runCurrent()
        assertEquals(listOf("loading"), replies)
        sdk.changes.value = ConnectSdkState(true, false, account); runCurrent()
        assertEquals(listOf("loading", "signed-in"), replies)
        connect.getState { }; runCurrent()
        assertEquals(2, notifications)
        sdk.tokenResult = null
        connect.getState { }; runCurrent()
        assertEquals(listOf("loading", "signed-in", "error"), replies)
        connect.getState { }; runCurrent()
        assertEquals(3, notifications)
        unsubscribe.run()
        sdk.changes.value = ConnectSdkState(true, false, null); runCurrent()
        assertEquals("signed-out", connect.state.value.state)
        assertEquals(3, notifications)
    }

    @Test fun authViewCanStayOpenIndefinitelyAndCancelReturnsSignedOut() = runTest {
        val sdk = Sdk()
        val connect = NativeConnect(true, "https://relay.example.invalid", sdk, backgroundScope)
        assertEquals("authorizing", connect.open().getString("state"))
        advanceTimeBy(600_000)
        assertEquals("authorizing", connect.refresh().state)
        connect.dismiss(); runCurrent()
        assertEquals("signed-out", connect.state.value.state)
        assertNull(connect.state.value.account)
        assertFalse(connect.presented.value)
    }

    @Test fun cachedAccountRequiresRealTokenBeforeReportingSignedIn() = runTest {
        val sdk = Sdk().apply { changes.value = ConnectSdkState(true, false, account); tokenResult = null }
        val connect = NativeConnect(true, "https://relay.example.invalid", sdk, backgroundScope)
        assertEquals("error", connect.refresh().state)
        assertNull(connect.state.value.account)
        sdk.tokenResult = "synthetic-jwt"
        assertEquals("signed-in", connect.refresh().state)
        assertEquals("user-a", connect.state.value.json().getJSONObject("account").getString("id"))
        assertFalse(connect.state.value.json().toString().contains("synthetic-jwt"))
    }

    @Test fun staleAccountRequestPreservesVerifiedAccountAndSubsequentTokenRead() = runTest {
        val sdk = Sdk().apply { changes.value = ConnectSdkState(true, false, account) }
        val connect = NativeConnect(true, "https://relay.example.invalid", sdk, backgroundScope)
        val verified = connect.refresh()
        assertEquals("signed-in", verified.state)
        assertNull(verified.error)
        val verifiedCalls = sdk.tokenCalls
        var result: JSONObject? = null

        connect.getToken("stale-account") { result = it }; runCurrent()
        assertTrue(result!!.isNull("token"))
        assertEquals(verifiedCalls, sdk.tokenCalls)
        assertEquals(verified, connect.state.value)

        connect.getToken(account.accountId) { result = it }; runCurrent()
        assertEquals("synthetic-jwt", result.getString("token"))
        assertEquals(verifiedCalls + 1, sdk.tokenCalls)
        assertEquals(verified, connect.state.value)
    }

    @Test fun wrongAccountNeverRequestsTokenAndAccountSwitchDuringAwaitDropsToken() = runTest {
        val sdk = Sdk().apply { changes.value = ConnectSdkState(true, false, account) }
        val connect = NativeConnect(true, "https://relay.example.invalid", sdk, backgroundScope)
        var result: JSONObject? = null
        connect.getToken("other-account") { result = it }; runCurrent()
        assertTrue(result!!.isNull("token")); assertEquals(0, sdk.tokenCalls)
        sdk.tokenWait = CompletableDeferred()
        result = null
        connect.getToken(account.accountId) { result = it }; runCurrent()
        sdk.changes.value = ConnectSdkState(true, false, account.copy(id = "session-b", accountId = "user-b"))
        sdk.tokenWait!!.complete("synthetic-old-token"); runCurrent()
        assertTrue(result!!.isNull("token"))
    }

    @Test fun failedSdkSnapshotCannotDeliverAnOtherwiseAvailableToken() = runTest {
        val sdk = Sdk().apply { changes.value = ConnectSdkState(true, true, account) }
        val connect = NativeConnect(true, null, sdk, backgroundScope)
        assertEquals("error", connect.refresh().state)
        var result: JSONObject? = null
        connect.getToken(account.accountId) { result = it }; runCurrent()
        assertTrue(result!!.isNull("token"))
        assertEquals(0, sdk.tokenCalls)
        assertNull(connect.deliveryContext(account.accountId))
    }

    @Test fun observedAccountRoundTripFencesPendingTokenDelivery() = runTest {
        val sdk = Sdk().apply { changes.value = ConnectSdkState(true, false, account) }
        val connect = NativeConnect(true, null, sdk, backgroundScope)
        connect.initialize(); runCurrent()
        assertEquals("signed-in", connect.state.value.state)
        val context = connect.deliveryContext(account.accountId)
        sdk.tokenWait = CompletableDeferred()
        var result: JSONObject? = null
        connect.getToken(account.accountId) { result = it }; runCurrent()
        sdk.changes.value = ConnectSdkState(true, false, account.copy(id = "session-b", accountId = "user-b"))
        runCurrent()
        sdk.changes.value = ConnectSdkState(true, false, account)
        runCurrent()
        sdk.tokenWait!!.complete("synthetic-old-token"); runCurrent()
        assertTrue(result!!.isNull("token"))
        assertNotEquals(context, connect.deliveryContext(account.accountId))
        sdk.tokenWait = null
        connect.getToken(account.accountId) { result = it }; runCurrent()
        assertEquals("synthetic-jwt", result.getString("token"))
    }

    @Test fun sameAccountWithReplacementSessionAlsoDropsToken() = runTest {
        val sdk = Sdk().apply { changes.value = ConnectSdkState(true, false, account); tokenWait = CompletableDeferred() }
        val connect = NativeConnect(true, "https://relay.example.invalid", sdk, backgroundScope)
        var result: JSONObject? = null
        connect.getToken(account.accountId) { result = it }; runCurrent()
        sdk.changes.value = ConnectSdkState(true, false, account.copy(id = "replacement-session"))
        sdk.tokenWait!!.complete("synthetic-old-token"); runCurrent()
        assertTrue(result!!.isNull("token"))
    }

    @Test fun signOutFencesInflightTokenAndReportsOfflineRevocationHonestly() = runTest {
        val sdk = Sdk().apply {
            changes.value = ConnectSdkState(true, false, account)
            tokenWait = CompletableDeferred(); logoutWait = CompletableDeferred()
        }
        val connect = NativeConnect(true, "https://relay.example.invalid", sdk, backgroundScope)
        val oldContext = connect.deliveryContext(account.accountId)
        var token: JSONObject? = null
        var signOut: JSONObject? = null
        connect.getToken(account.accountId) { token = it }; runCurrent()
        connect.signOut { signOut = it }; runCurrent()
        assertNull(connect.deliveryContext(account.accountId))
        assertEquals("signed-out", connect.state.value.state)
        sdk.tokenWait!!.complete("synthetic-old-token"); runCurrent()
        assertTrue(token!!.isNull("token"))
        sdk.logoutWait!!.complete(false); runCurrent()
        assertEquals("signed-out", signOut!!.getString("state"))
        assertTrue(signOut.getString("error").contains("could not be confirmed"))
        assertNull(connect.deliveryContext(account.accountId))
        assertNotNull(oldContext)
    }

    @Test fun initializationNetworkFailureCanRetryWithoutDestroyingTheSavedSession() = runTest {
        val sdk = Sdk().apply { changes.value = ConnectSdkState(false, true, null) }
        val connect = NativeConnect(true, "https://relay.example.invalid", sdk, backgroundScope)
        connect.open()
        assertEquals("error", connect.refresh().state)
        connect.retry(); runCurrent()
        sdk.changes.value = ConnectSdkState(true, false, account)
        assertEquals("signed-in", connect.refresh().state)
        assertEquals(0, sdk.resets)
        assertEquals(2, sdk.retries)
    }

    @Test fun explicitStorageResetDoesNotLeaveAnOldAccountAvailable() = runTest {
        val sdk = Sdk().apply { changes.value = ConnectSdkState(true, false, account) }
        val connect = NativeConnect(true, "https://relay.example.invalid", sdk, backgroundScope)
        connect.open(); connect.refresh()
        connect.resetSignIn()
        assertEquals(1, sdk.resets)
        assertNull(connect.deliveryContext(account.accountId))
        assertEquals("authorizing", connect.state.value.state)
        sdk.resetError = true
        connect.resetSignIn()
        assertEquals("error", connect.state.value.state)
        assertFalse(connect.state.value.error!!.contains("synthetic storage failure"))
    }

    @Test fun sdkRestoredSessionIsVerifiedAfterProcessRestartAndCancelKeepsCompletedSignIn() = runTest {
        val sdk = Sdk().apply { changes.value = ConnectSdkState(true, false, account) }
        val connect = NativeConnect(true, "https://relay.example.invalid", sdk, backgroundScope)
        connect.initialize(); runCurrent()
        assertEquals("signed-in", connect.state.value.state)
        assertFalse(connect.presented.value)
        connect.open(); connect.refresh()
        val observed = mutableListOf<String>()
        backgroundScope.launch(UnconfinedTestDispatcher(testScheduler)) {
            connect.state.collect { observed.add(it.state) }
        }
        connect.dismiss()
        assertEquals("signed-in", connect.state.value.state)
        runCurrent()
        assertEquals("signed-in", connect.state.value.state)
        assertEquals(listOf("signed-in"), observed)
        assertTrue(sdk.tokenCalls >= 2)
    }

    @Test fun tokenTimeoutDoesNotDismissNativeAuth() = runTest {
        val sdk = Sdk().apply { changes.value = ConnectSdkState(true, false, account); tokenWait = CompletableDeferred() }
        val connect = NativeConnect(true, "https://relay.example.invalid", sdk, backgroundScope)
        connect.open()
        var result: JSONObject? = null
        connect.getToken(account.accountId) { result = it }; runCurrent()
        advanceTimeBy(30_001); runCurrent()
        assertTrue(result!!.isNull("token"))
        assertTrue(connect.presented.value)
    }

    @Test fun uninitializedSdkCannotReturnACachedAccountToken() = runTest {
        val sdk = Sdk().apply { changes.value = ConnectSdkState(false, false, account) }
        val connect = NativeConnect(true, "https://relay.example.invalid", sdk, backgroundScope)
        var result: JSONObject? = null
        connect.getToken(account.accountId) { result = it }; runCurrent()
        assertTrue(result!!.isNull("token"))
        assertEquals(0, sdk.tokenCalls)
    }

    @Test fun corruptStorageFailsClosedAndCanBeRetriedFromANewAuthSurface() = runTest {
        val sdk = Sdk().apply { changes.value = ConnectSdkState(true, false, account); resetError = true }
        val connect = NativeConnect(true, "https://relay.example.invalid", sdk, backgroundScope)
        connect.open(); connect.resetSignIn(); connect.dismiss()
        assertNull(connect.deliveryContext(account.accountId))
        var token: JSONObject? = null
        connect.getToken(account.accountId) { token = it }; runCurrent()
        assertTrue(token!!.isNull("token"))
        assertEquals("authorizing", connect.open().getString("state"))
        connect.retry(); runCurrent()
        assertEquals("error", connect.state.value.state)
        sdk.resetError = false
        connect.retry(); runCurrent()
        sdk.changes.value = ConnectSdkState(true, false, account)
        assertEquals("signed-in", connect.refresh().state)
    }

    @Test fun actualSdkModelsRejectPendingTasksExpiredRevokedOrMismatchedUser() {
        val user = User(id = "user-a", hasImage = false, imageUrl = "", passkeys = emptyList(), passwordEnabled = false, phoneNumbers = emptyList(), totpEnabled = false, twoFactorEnabled = false, updatedAt = 1)
        val session = Session(id = "session-a", status = Session.SessionStatus.ACTIVE, expireAt = 2000,
            lastActiveAt = 1, createdAt = 1, updatedAt = 1, user = user)
        assertEquals("user-a", activeConnectSession(session, user, 1000)?.accountId)
        for (status in Session.SessionStatus.entries.filter { it != Session.SessionStatus.ACTIVE })
            assertNull(activeConnectSession(session.copy(status = status), user, 1000))
        assertNull(activeConnectSession(session.copy(expireAt = 1000), user, 1000))
        assertNull(activeConnectSession(session, user.copy(id = "other"), 1000))
        assertNull(activeConnectSession(session, null, 1000))
        val task = SessionTask(key = "choose-organization")
        assertNull(activeConnectSession(session.copy(currentTask = task), user, 1000))
        assertNull(activeConnectSession(session.copy(tasks = listOf(task)), user, 1000))
    }
}
