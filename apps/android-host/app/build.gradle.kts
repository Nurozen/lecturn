plugins { id("com.android.application") }
android {
    namespace = "com.cloudgatherer.lecturn.symba"
    compileSdk = 36
    defaultConfig {
        applicationId = "com.cloudgatherer.lecturn.symba"
        minSdk = 29
        targetSdk = 36
        versionCode = 1
        versionName = "0.1.0"
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    lint { abortOnError = true }
}
dependencies {
    implementation("androidx.webkit:webkit:1.14.0")
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20240303")
}
