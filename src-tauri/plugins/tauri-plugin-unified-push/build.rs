const COMMANDS: &[&str] = &[
    "get_state",
    "register",
    "pick_distributor",
    "drain_messages",
    "take_pending_taps",
    "unregister",
    "registerListener",
    "removeListener",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .build();
}
