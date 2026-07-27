fn main() {
    // Ensure Swift source changes trigger rebuild
    println!("cargo:rerun-if-changed=ios/Sources/MobilePushPlugin.swift");
    println!("cargo:rerun-if-changed=ios/Package.swift");

    tauri_plugin::Builder::new(&["request_permission", "get_token", "register_listener"])
        .android_path("android")
        .ios_path("ios")
        .build();
}
