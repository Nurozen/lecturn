import java.net.URI
import java.util.Base64

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

// Public configuration only. Credentials and SDK session storage never enter BuildConfig.
val clerkKey = providers.environmentVariable("LECTURN_CLERK_PUBLISHABLE_KEY").orElse("").get().trim()
val clerkTemplate = providers.environmentVariable("LECTURN_CLERK_JWT_TEMPLATE").orElse("").get().trim()
val relayUrl = providers.environmentVariable("LECTURN_RELAY_URL").orElse("").get().trim()
val connectConfigured = listOf(clerkKey, clerkTemplate, relayUrl).any { it.isNotEmpty() }
if (connectConfigured) {
    require(clerkKey.matches(Regex("pk_(test|live)_[A-Za-z0-9+/=_-]+"))) {
        "LECTURN_CLERK_PUBLISHABLE_KEY must be a public Clerk publishable key"
    }
    val clerkDomain = runCatching {
        String(Base64.getDecoder().decode(clerkKey.substringAfter("pk_").substringAfter('_')), Charsets.UTF_8)
    }.getOrDefault("")
    require(clerkDomain.matches(Regex("[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\\$"))) {
        "LECTURN_CLERK_PUBLISHABLE_KEY must encode a Clerk frontend API host"
    }
    require(clerkTemplate.matches(Regex("[A-Za-z0-9_-]{1,128}"))) {
        "LECTURN_CLERK_JWT_TEMPLATE must name the Connect JWT template"
    }
    val relay = runCatching { URI(relayUrl) }.getOrNull()
    require(relay != null && relay.scheme == "https" && !relay.host.isNullOrBlank()
        && relay.rawUserInfo == null && relay.rawQuery == null && relay.rawFragment == null) {
        "LECTURN_RELAY_URL must be an HTTPS URL without credentials, query, or fragment"
    }
}
fun publicString(value: String) = "\"" + value.replace("\\", "\\\\").replace("\"", "\\\"") + "\""
android {
    namespace = "com.cloudgatherer.lecturn.symba"
    compileSdk = 36
    defaultConfig {
        applicationId = "com.cloudgatherer.lecturn.symba"
        minSdk = 29
        targetSdk = 36
        versionCode = 1
        versionName = "0.1.0"
        buildConfigField("boolean", "CONNECT_CONFIGURED", connectConfigured.toString())
        buildConfigField("String", "LECTURN_CLERK_PUBLISHABLE_KEY", publicString(clerkKey))
        buildConfigField("String", "LECTURN_CLERK_JWT_TEMPLATE", publicString(clerkTemplate))
        buildConfigField("String", "LECTURN_RELAY_URL", publicString(relayUrl))
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    lint { abortOnError = true }
    buildFeatures { compose = true; buildConfig = true }
    // JVM module metadata from transitive SDK jars is not used by Android.
    packaging { resources.excludes += "META-INF/versions/9/OSGI-INF/MANIFEST.MF" }
}
kotlin { compilerOptions { jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17) } }
dependencies {
    implementation("androidx.webkit:webkit:1.14.0")
    implementation("com.clerk:clerk-android-api:1.1.11")
    implementation("com.clerk:clerk-android-ui:1.1.11")
    implementation(platform("androidx.compose:compose-bom:2026.06.01"))
    implementation("androidx.activity:activity-compose:1.13.0")
    implementation("androidx.compose.material3:material3:1.4.0")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.10.0")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.10.0")
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.mockito:mockito-core:5.14.1")
    testImplementation("org.json:json:20240303")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.10.2")
}
