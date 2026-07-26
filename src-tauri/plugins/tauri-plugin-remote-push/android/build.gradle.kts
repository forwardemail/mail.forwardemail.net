plugins {
    id("com.android.library")
    kotlin("android")
}

android {
    namespace = "app.tauri.remotepush"
    compileSdk = 34

    defaultConfig {
        minSdk = 21
        consumerProguardFiles("proguard-rules.pro")
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_1_8
        targetCompatibility = JavaVersion.VERSION_1_8
    }
    kotlinOptions {
        jvmTarget = "1.8"
    }
}

dependencies {
    // This correctly points to the local :tauri-android module included by settings.gradle
    compileOnly(project(":tauri-android"))
    implementation("com.google.firebase:firebase-messaging:23.4.1")
} 