plugins {
    id("com.android.application")
}

android {
    namespace = "com.somethingobvious.thelab"
    compileSdk {
        version = release(37) { minorApiLevel = 2 }
    }

    defaultConfig {
        applicationId = "com.somethingobvious.thelab"
        minSdk = 33
        targetSdk = 36
        // setup.ts bundle passes a rising number, which Play Console needs for each upload.
        versionCode = providers.gradleProperty("lab.versionCode").orNull?.toInt() ?: 1
        versionName = "1.0.0"
        resValue("string", "tile", "Ask the computer")
        resValue("string", "widget_hint", "Message your computer")
    }

    // setup.ts makes a keystore on the owner's Mac and passes it in, so every
    // later build from that Mac installs over the last one.
    val store = providers.gradleProperty("lab.keystore").orNull
    signingConfigs {
        if (store != null) {
            create("lab") {
                storeFile = file(store)
                storePassword = providers.gradleProperty("lab.keystorePassword").get()
                keyAlias = "lab"
                keyPassword = providers.gradleProperty("lab.keystorePassword").get()
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"))
            signingConfig = if (store != null) signingConfigs.getByName("lab") else signingConfigs.getByName("debug")
        }
    }

    buildFeatures {
        buildConfig = true
        resValues = true
    }

    // ask.js, the one script that can answer an Allow card, is shared with the
    // desktop windows and packed in at build time, out of the agent's reach.
    sourceSets.getByName("main").assets.directories.add("../../shared")

    // Tunnel logs through android.util.Log, which does nothing on the computer.
    testOptions.unitTests.isReturnDefaultValues = true

    lint {
        warningsAsErrors = true
        abortOnError = true
        checkAllWarnings = true
        checkTestSources = true
        checkDependencies = true
    }
}

kotlin {
    compilerOptions {
        allWarningsAsErrors = true
    }
}

dependencies {
    implementation("androidx.core:core:1.19.1")
    implementation("androidx.webkit:webkit:1.18.0")
    implementation("androidx.window:window:1.5.1")
    implementation("androidx.window:window-java:1.5.1")
    implementation("com.squareup.okhttp3:okhttp:5.5.1")
    implementation("com.squareup.okhttp3:okhttp-sse:5.5.1")
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20260814")
}
