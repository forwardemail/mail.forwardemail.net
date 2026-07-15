const COMMANDS: &[&str] = &[
    "get_state",
    "register",
    "pick_distributor",
    "drain_messages",
    "unregister",
    "registerListener",
    "removeListener",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .build();
}
