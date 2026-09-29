//! Direct APNs registration for the macOS desktop app.
//!
//! The iOS side of this plugin is Swift (ios/Sources/MobilePushPlugin.swift).
//! Tauri has no Swift build step on macOS, so the same contract is
//! implemented here with objc2:
//!
//! - `request_permission` asks UNUserNotificationCenter for alert, badge and
//!   sound authorization and reports the same statuses as iOS.
//! - `get_token` calls `-[NSApplication registerForRemoteNotifications]` and
//!   waits for the app delegate callback, which is added to Tao's delegate
//!   class during plugin setup.
//! - Incoming pushes and token refreshes reach the page as the same
//!   `mobile-push:*` DOM events the Swift side dispatches. Taps are queued
//!   (`take_pending_taps`) like on iOS, because a tap that launches the app
//!   arrives before the page can listen.
//!
//! None of this is installed unless the running binary is signed with
//! `com.apple.developer.aps-environment`. A Developer ID app may carry that
//! restricted entitlement only when it embeds a provisioning profile granting
//! it (scripts/macos-push-signing.sh); without the profile the kernel kills
//! the app at launch (docs/desktop-postmortem-macos-entitlements-2026-05-19.md).
//! Builds without it (local `tauri dev`, pull request and e2e builds, releases
//! built without the profile) report "unsupported" and never touch
//! UNUserNotificationCenter, which raises for a binary outside an app bundle.

use std::collections::VecDeque;
use std::ffi::{c_char, c_void, CStr};
use std::ptr::NonNull;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use block2::{DynBlock, RcBlock};
use objc2::rc::Retained;
use objc2::runtime::{AnyClass, AnyObject, Bool, ProtocolObject, Sel};
use objc2::{define_class, msg_send, sel, AllocAnyThread, ClassType, MainThreadMarker};
use objc2_app_kit::{NSApplication, NSRemoteNotificationType, NSWorkspace};
use objc2_foundation::{
    NSBundle, NSData, NSDictionary, NSError, NSJSONSerialization, NSJSONWritingOptions, NSObject,
    NSObjectProtocol, NSString, NSUserDefaults, NSURL,
};
use objc2_user_notifications::{
    UNAuthorizationOptions, UNAuthorizationStatus, UNNotification,
    UNNotificationPresentationOptions, UNNotificationResponse, UNNotificationSettings,
    UNPushNotificationTrigger, UNUserNotificationCenter, UNUserNotificationCenterDelegate,
};
use tauri::{AppHandle, Manager, Runtime};

const APS_ENTITLEMENT: &str = "com.apple.developer.aps-environment";
const LAST_TOKEN_DEFAULTS_KEY: &str = "net.forwardemail.mobile-push.apns-token";
const MAIN_WINDOW_LABEL: &str = "main";

/// How long a query to UNUserNotificationCenter or the main thread may take.
const SETTINGS_TIMEOUT: Duration = Duration::from_secs(10);

/// Main-thread steps of `get_token` (registering, and the checks after a
/// timeout). Kept short so the whole call, with the APNs wait, still answers
/// before the page gives up (APNS_TOKEN_TIMEOUT_MS in push-notifications.js).
const TOKEN_MAIN_THREAD_TIMEOUT: Duration = Duration::from_secs(4);

/// How long the first registration may go unanswered before `get_token`
/// unregisters and registers again (once per launch). The rest of the
/// caller's budget is spent waiting on that second registration.
const FIRST_REGISTRATION_WAIT: Duration = Duration::from_secs(15);

/// A push can reach the app twice while it runs: through the UN delegate
/// (`willPresentNotification:`) and through the app delegate
/// (`application:didReceiveRemoteNotification:`). Identical payloads seen
/// within this window are dispatched to the page once.
const DUPLICATE_WINDOW: Duration = Duration::from_secs(30);
const DUPLICATE_HISTORY: usize = 32;

/// Taps kept for the page, as on iOS (MobilePushPlugin.swift).
const MAX_PENDING_TAPS: usize = 10;

// ---------------------------------------------------------------------------
// Entitlement check
// ---------------------------------------------------------------------------

#[link(name = "Security", kind = "framework")]
extern "C" {
    fn SecTaskCreateFromSelf(allocator: *const c_void) -> *mut c_void;
    fn SecTaskCopyValueForEntitlement(
        task: *mut c_void,
        entitlement: *const c_void,
        error: *mut *mut c_void,
    ) -> *mut c_void;
}

#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFRelease(cf: *const c_void);
}

/// The value of `com.apple.developer.aps-environment` this process is signed
/// with ("production" or "development"), or `None`.
pub(crate) fn aps_environment() -> Option<&'static str> {
    static VALUE: OnceLock<Option<String>> = OnceLock::new();
    VALUE
        .get_or_init(|| unsafe {
            let task = SecTaskCreateFromSelf(std::ptr::null());
            if task.is_null() {
                return None;
            }
            let key = NSString::from_str(APS_ENTITLEMENT);
            let raw = SecTaskCopyValueForEntitlement(
                task,
                Retained::as_ptr(&key).cast(),
                std::ptr::null_mut(),
            );
            CFRelease(task);
            // The Copy rule: `raw` is +1, so Retained takes ownership of it.
            let value = Retained::from_raw(raw.cast::<AnyObject>())?;
            let is_string: bool = msg_send![&*value, isKindOfClass: NSString::class()];
            if !is_string {
                return None;
            }
            let value = Retained::cast_unchecked::<NSString>(value).to_string();
            if value.is_empty() {
                None
            } else {
                Some(value)
            }
        })
        .as_deref()
}

/// Whether this build can register for remote notifications at all: it is a
/// bundled app (UNUserNotificationCenter raises outside one) and it carries
/// the APNs entitlement.
pub(crate) fn is_push_capable() -> bool {
    static CAPABLE: OnceLock<bool> = OnceLock::new();
    *CAPABLE.get_or_init(|| {
        let bundled = NSBundle::mainBundle()
            .bundleIdentifier()
            .is_some_and(|id| !id.to_string().is_empty());
        bundled && aps_environment().is_some()
    })
}

// ---------------------------------------------------------------------------
// State shared with the Objective-C callbacks
// ---------------------------------------------------------------------------

type Emitter = Box<dyn Fn(&'static str, String) + Send + Sync>;
type WindowRaiser = Box<dyn Fn() + Send + Sync>;

static EMITTER: OnceLock<Emitter> = OnceLock::new();
static RAISE_MAIN_WINDOW: OnceLock<WindowRaiser> = OnceLock::new();
type TokenSender = mpsc::Sender<Result<String, String>>;

/// `get_token` calls waiting for the APNs callback. A call that arrives while
/// one registration is in flight waits for that one's answer instead of
/// queueing behind it: queued calls used to outlast the page's timeout, so
/// every retry after a slow first attempt failed with a bare JS timeout.
static TOKEN_WAITERS: Mutex<Vec<(u64, TokenSender)>> = Mutex::new(Vec::new());
static NEXT_TOKEN_WAITER: AtomicU64 = AtomicU64::new(1);
static RECENT_PAYLOADS: Mutex<VecDeque<(Instant, String)>> = Mutex::new(VecDeque::new());
/// Taps the page has not taken yet (JSON `{"data": userInfo}` each).
static PENDING_TAPS: Mutex<VecDeque<String>> = Mutex::new(VecDeque::new());
/// The token APNs gave this process, including one that arrived after the
/// `get_token` call that asked for it had given up. Later calls answer with
/// it at once instead of registering and waiting again.
static SESSION_TOKEN: Mutex<Option<String>> = Mutex::new(None);
/// The unregister-and-register-again recovery runs at most once per launch.
static RECOVERY_ATTEMPTED: AtomicBool = AtomicBool::new(false);

fn emit(event: &'static str, detail: String) {
    if let Some(emitter) = EMITTER.get() {
        emitter(event, detail);
    }
}

fn is_duplicate(payload: &str) -> bool {
    let Ok(mut recent) = RECENT_PAYLOADS.lock() else {
        return false;
    };
    let now = Instant::now();
    recent.retain(|(seen, _)| now.duration_since(*seen) < DUPLICATE_WINDOW);
    if recent.iter().any(|(_, seen)| seen == payload) {
        return true;
    }
    if recent.len() >= DUPLICATE_HISTORY {
        recent.pop_front();
    }
    recent.push_back((now, payload.to_string()));
    false
}

fn user_defaults_token() -> Option<String> {
    let key = NSString::from_str(LAST_TOKEN_DEFAULTS_KEY);
    NSUserDefaults::standardUserDefaults()
        .stringForKey(&key)
        .map(|value| value.to_string())
        .filter(|value| !value.is_empty())
}

fn store_user_defaults_token(token: &str) {
    let key = NSString::from_str(LAST_TOKEN_DEFAULTS_KEY);
    let value = NSString::from_str(token);
    unsafe {
        NSUserDefaults::standardUserDefaults().setObject_forKey(Some(&value), &key);
    }
}

fn token_hex(data: &NSData) -> String {
    data.to_vec()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn deliver_token(token: String) {
    log::info!("[mobile-push] APNs token received ({} chars)", token.len());
    store_user_defaults_token(&token);
    if let Ok(mut session) = SESSION_TOKEN.lock() {
        *session = Some(token.clone());
    }
    answer_token_waiters(Ok(token.clone()));
    let detail = serde_json::json!({ "token": token }).to_string();
    emit("mobile-push:token-received", detail);
}

fn deliver_token_error(message: String) {
    log::warn!("[mobile-push] APNs registration failed: {message}");
    answer_token_waiters(Err(message));
}

/// Answer every waiting `get_token` call and clear the list, so the next call
/// starts a new registration.
fn answer_token_waiters(result: Result<String, String>) {
    let waiters: Vec<(u64, TokenSender)> = match TOKEN_WAITERS.lock() {
        Ok(mut waiters) => waiters.drain(..).collect(),
        Err(_) => return,
    };
    for (_, sender) in waiters {
        let _ = sender.send(result.clone());
    }
}

/// Serialize an APNs userInfo dictionary. APNs payloads are JSON to begin
/// with, so this only fails for something that did not come from APNs.
fn user_info_json(user_info: &NSDictionary) -> String {
    unsafe {
        if !NSJSONSerialization::isValidJSONObject(user_info) {
            return "{}".to_string();
        }
        match NSJSONSerialization::dataWithJSONObject_options_error(
            user_info,
            NSJSONWritingOptions(0),
        ) {
            Ok(data) => {
                let json = String::from_utf8(data.to_vec()).unwrap_or_else(|_| "{}".to_string());
                // Re-serialize through serde so what is evaluated in the page
                // is plain JSON data and nothing else.
                serde_json::from_str::<serde_json::Value>(&json)
                    .map(|value| value.to_string())
                    .unwrap_or_else(|_| "{}".to_string())
            }
            Err(_) => "{}".to_string(),
        }
    }
}

fn dictionary_value(dictionary: &AnyObject, key: &str) -> Option<Retained<AnyObject>> {
    let is_dictionary: bool = unsafe {
        msg_send![dictionary, isKindOfClass: NSDictionary::<AnyObject, AnyObject>::class()]
    };
    if !is_dictionary {
        return None;
    }
    let key = NSString::from_str(key);
    unsafe { msg_send![dictionary, objectForKey: &*key] }
}

/// Whether macOS draws this push itself: it has an `aps.alert`.
fn has_alert(user_info: &NSDictionary) -> bool {
    dictionary_value(user_info, "aps")
        .and_then(|aps| dictionary_value(&aps, "alert"))
        .is_some()
}

/// The user is looking at the app: it is the active application and one of
/// its windows is key. In that state an alert is not drawn by the system
/// (see `will_present`) and the page shows its own in-app notice instead.
fn user_is_in_app() -> bool {
    let Some(mtm) = MainThreadMarker::new() else {
        // UN delegate methods arrive on the main thread; if one ever does not,
        // treat the app as backgrounded so the system shows the alert.
        return false;
    };
    let app = NSApplication::sharedApplication(mtm);
    app.isActive() && app.keyWindow().is_some()
}

fn dispatch_received(user_info: &NSDictionary) {
    let payload = user_info_json(user_info);
    if is_duplicate(&payload) {
        return;
    }
    let displayed_by_system = has_alert(user_info) && !user_is_in_app();
    // `detail.data` matches the iOS and Android shape read by
    // dispatchPushPayload in src/utils/push-notifications.js.
    emit(
        "mobile-push:notification-received",
        format!("{{\"data\":{payload},\"displayedBySystem\":{displayed_by_system}}}"),
    );
}

fn dispatch_tapped(user_info: &NSDictionary) {
    let payload = format!("{{\"data\":{}}}", user_info_json(user_info));
    if let Ok(mut taps) = PENDING_TAPS.lock() {
        taps.push_back(payload.clone());
        while taps.len() > MAX_PENDING_TAPS {
            taps.pop_front();
        }
    }
    if let Some(raise) = RAISE_MAIN_WINDOW.get() {
        raise();
    }
    // Wake-up for a page that is already running; it drains the queue.
    emit("mobile-push:notification-tapped", payload);
}

/// Taps the page has not taken yet, oldest first.
pub(crate) fn take_pending_taps() -> Vec<serde_json::Value> {
    let taps: Vec<String> = match PENDING_TAPS.lock() {
        Ok(mut taps) => taps.drain(..).collect(),
        Err(_) => Vec::new(),
    };
    taps.iter()
        .filter_map(|tap| serde_json::from_str(tap).ok())
        .collect()
}

fn is_remote(notification: &UNNotification) -> bool {
    notification
        .request()
        .trigger()
        .is_some_and(|trigger| trigger.isKindOfClass(UNPushNotificationTrigger::class()))
}

// ---------------------------------------------------------------------------
// UNUserNotificationCenter delegate
// ---------------------------------------------------------------------------

/// A delegate that was installed before ours. Anything that is not a remote
/// push is forwarded to it, as the Swift side does on iOS. Nothing in the app
/// sets one on macOS today (tauri-plugin-notification posts through
/// NSUserNotificationCenter there), so this is normally empty.
static PREVIOUS_DELEGATE: Mutex<Option<usize>> = Mutex::new(None);

fn previous_delegate() -> Option<&'static AnyObject> {
    let address = (*PREVIOUS_DELEGATE.lock().ok()?)?;
    // Retained for the process lifetime in `install_notification_delegate`.
    Some(unsafe { &*(address as *const AnyObject) })
}

fn responds_to(object: &AnyObject, selector: Sel) -> bool {
    unsafe { msg_send![object, respondsToSelector: selector] }
}

define_class!(
    // SAFETY: NSObject has no subclassing requirements and this type does not
    // implement Drop.
    #[unsafe(super(NSObject))]
    #[name = "FEMobilePushNotificationCenterDelegate"]
    struct PushNotificationCenterDelegate;

    unsafe impl NSObjectProtocol for PushNotificationCenterDelegate {}

    unsafe impl UNUserNotificationCenterDelegate for PushNotificationCenterDelegate {
        #[unsafe(method(userNotificationCenter:willPresentNotification:withCompletionHandler:))]
        fn will_present(
            &self,
            center: &UNUserNotificationCenter,
            notification: &UNNotification,
            completion_handler: &DynBlock<dyn Fn(UNNotificationPresentationOptions)>,
        ) {
            if !is_remote(notification) {
                let selector =
                    sel!(userNotificationCenter:willPresentNotification:withCompletionHandler:);
                if let Some(previous) = previous_delegate().filter(|d| responds_to(d, selector)) {
                    unsafe {
                        let _: () = msg_send![
                            previous,
                            userNotificationCenter: center,
                            willPresentNotification: notification,
                            withCompletionHandler: completion_handler
                        ];
                    }
                    return;
                }
                completion_handler.call((UNNotificationPresentationOptions::Banner
                    | UNNotificationPresentationOptions::List
                    | UNNotificationPresentationOptions::Sound,));
                return;
            }

            let user_info = notification.request().content().userInfo();
            // Keep this decision identical to `dispatch_received`: when the
            // user is in the app, the page shows the notice and the system
            // draws nothing; otherwise the system draws the alert and the
            // page is told so it does not draw a second one.
            let options = if user_is_in_app() {
                UNNotificationPresentationOptions::empty()
            } else {
                UNNotificationPresentationOptions::Banner
                    | UNNotificationPresentationOptions::List
                    | UNNotificationPresentationOptions::Sound
            };
            dispatch_received(&user_info);
            completion_handler.call((options,));
        }

        #[unsafe(method(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:))]
        fn did_receive_response(
            &self,
            center: &UNUserNotificationCenter,
            response: &UNNotificationResponse,
            completion_handler: &DynBlock<dyn Fn()>,
        ) {
            let notification = response.notification();
            if !is_remote(&notification) {
                let selector = sel!(
                    userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:
                );
                if let Some(previous) = previous_delegate().filter(|d| responds_to(d, selector)) {
                    unsafe {
                        let _: () = msg_send![
                            previous,
                            userNotificationCenter: center,
                            didReceiveNotificationResponse: response,
                            withCompletionHandler: completion_handler
                        ];
                    }
                    return;
                }
                completion_handler.call(());
                return;
            }

            let user_info = notification.request().content().userInfo();
            dispatch_tapped(&user_info);
            completion_handler.call(());
        }
    }
);

impl PushNotificationCenterDelegate {
    fn new() -> Retained<Self> {
        let this = Self::alloc().set_ivars(());
        unsafe { msg_send![super(this), init] }
    }
}

fn install_notification_delegate() {
    let center = UNUserNotificationCenter::currentNotificationCenter();
    if let Some(existing) = center.delegate() {
        let already_ours: bool = unsafe {
            msg_send![&*existing, isKindOfClass: PushNotificationCenterDelegate::class()]
        };
        if already_ours {
            return;
        }
        let raw = Retained::into_raw(existing) as *const AnyObject as usize;
        if let Ok(mut previous) = PREVIOUS_DELEGATE.lock() {
            *previous = Some(raw);
        }
    }
    // The delegate property is weak: keep ours alive for the process lifetime.
    let delegate: &'static PushNotificationCenterDelegate =
        unsafe { &*Retained::into_raw(PushNotificationCenterDelegate::new()) };
    center.setDelegate(Some(ProtocolObject::from_ref(delegate)));
    log::info!(
        "[mobile-push] UNUserNotificationCenter delegate installed (previous forwarded: {})",
        previous_delegate().is_some()
    );
}

// ---------------------------------------------------------------------------
// NSApplicationDelegate callbacks, added to Tao's delegate class
// ---------------------------------------------------------------------------

extern "C-unwind" fn did_register(
    _this: &AnyObject,
    _cmd: Sel,
    _application: &NSApplication,
    device_token: &NSData,
) {
    deliver_token(token_hex(device_token));
}

extern "C-unwind" fn did_fail_to_register(
    _this: &AnyObject,
    _cmd: Sel,
    _application: &NSApplication,
    error: &NSError,
) {
    deliver_token_error(error.localizedDescription().to_string());
}

extern "C-unwind" fn did_receive_remote_notification(
    _this: &AnyObject,
    _cmd: Sel,
    _application: &NSApplication,
    user_info: &NSDictionary,
) {
    dispatch_received(user_info);
}

fn add_method(class: &AnyClass, selector: Sel, imp: objc2::runtime::Imp, types: &CStr) {
    let added = unsafe {
        objc2::ffi::class_addMethod(
            class as *const AnyClass as *mut AnyClass,
            selector,
            imp,
            types.as_ptr() as *const c_char,
        )
    };
    if !added.as_bool() {
        log::warn!(
            "[mobile-push] {} already implements {}; APNs callbacks may not reach the plugin",
            class.name().to_string_lossy(),
            selector.name().to_string_lossy()
        );
    }
}

const DID_REGISTER: &str = "application:didRegisterForRemoteNotificationsWithDeviceToken:";

/// Make sure the current NSApplication delegate answers the APNs callbacks,
/// adding them to its class if it does not. Runs at plugin setup and again
/// before every registration: AppKit delivers the token only to the delegate
/// it has when the answer arrives, and a delegate without these methods drops
/// it silently, which the page sees as a registration that never finishes.
///
/// Returns the delegate's class name, for diagnostics.
fn ensure_app_delegate_callbacks(mtm: MainThreadMarker) -> Result<String, String> {
    let app = NSApplication::sharedApplication(mtm);
    let Some(delegate) = app.delegate() else {
        return Err("NSApplication has no delegate".to_string());
    };
    let object: &AnyObject = ProtocolObject::as_ref(&*delegate);
    let class = object.class();
    let class_name = class.name().to_string_lossy().into_owned();

    let register = sel!(application:didRegisterForRemoteNotificationsWithDeviceToken:);
    let fail = sel!(application:didFailToRegisterForRemoteNotificationsWithError:);
    let receive = sel!(application:didReceiveRemoteNotification:);
    if responds_to(object, register) && responds_to(object, fail) && responds_to(object, receive) {
        return Ok(class_name);
    }

    type Callback<T> = extern "C-unwind" fn(&AnyObject, Sel, &NSApplication, &T);
    unsafe {
        if !responds_to(object, register) {
            add_method(
                class,
                register,
                std::mem::transmute::<Callback<NSData>, objc2::runtime::Imp>(did_register),
                c"v@:@@",
            );
        }
        if !responds_to(object, fail) {
            add_method(
                class,
                fail,
                std::mem::transmute::<Callback<NSError>, objc2::runtime::Imp>(did_fail_to_register),
                c"v@:@@",
            );
        }
        if !responds_to(object, receive) {
            add_method(
                class,
                receive,
                std::mem::transmute::<Callback<NSDictionary>, objc2::runtime::Imp>(
                    did_receive_remote_notification,
                ),
                c"v@:@@",
            );
        }
    }

    // NSApplication may cache which optional delegate methods exist when the
    // delegate is assigned; assigning it again refreshes that. Tao keeps its
    // own strong reference to the delegate, so clearing it releases nothing.
    app.setDelegate(None);
    app.setDelegate(Some(&delegate));

    if !responds_to(object, register) {
        return Err(format!("{class_name} does not accept {DID_REGISTER}"));
    }
    log::info!("[mobile-push] APNs callbacks added to {class_name}");
    Ok(class_name)
}

/// Install the APNs callbacks. Called from plugin setup on the main thread,
/// after Tao created the app delegate and before the app finished launching,
/// so a tap that launches the app still reaches the UN delegate.
pub(crate) fn init<R: Runtime>(app: &AppHandle<R>) {
    if !is_push_capable() {
        log::info!(
            "[mobile-push] macOS remote push disabled: this build is not signed with {APS_ENTITLEMENT}"
        );
        return;
    }
    let Some(mtm) = MainThreadMarker::new() else {
        log::warn!("[mobile-push] plugin setup is not on the main thread; remote push disabled");
        return;
    };

    let emitter_app = app.clone();
    let _ = EMITTER.set(Box::new(move |event, detail| {
        let script =
            format!("window.dispatchEvent(new CustomEvent('{event}',{{detail:{detail}}}))");
        let app = emitter_app.clone();
        // Evaluate from the async runtime: the webview call is then queued on
        // the event loop instead of running inside an AppKit callback.
        tauri::async_runtime::spawn(async move {
            match app.get_webview_window(MAIN_WINDOW_LABEL) {
                Some(window) => {
                    if let Err(error) = window.eval(&script) {
                        log::warn!("[mobile-push] could not deliver {event}: {error}");
                    }
                }
                None => log::warn!("[mobile-push] no main window for {event}"),
            }
        });
    }));

    let raiser_app = app.clone();
    let _ = RAISE_MAIN_WINDOW.set(Box::new(move || {
        let app = raiser_app.clone();
        tauri::async_runtime::spawn(async move {
            if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        });
    }));

    // Nothing logged here reaches the log file: this plugin is set up before
    // tauri-plugin-log. get_token checks and logs the same state again.
    if let Err(message) = ensure_app_delegate_callbacks(mtm) {
        log::warn!("[mobile-push] APNs callbacks not installed: {message}");
    }
    install_notification_delegate();
    log::info!(
        "[mobile-push] macOS remote push ready (aps-environment={})",
        aps_environment().unwrap_or("none")
    );
}

// ---------------------------------------------------------------------------
// Command implementations (called from the blocking pool)
// ---------------------------------------------------------------------------

/// Runs `work` on the main thread and waits for its result.
fn on_main_thread<R: Runtime, T: Send + 'static>(
    app: &AppHandle<R>,
    timeout: Duration,
    work: impl FnOnce(MainThreadMarker) -> T + Send + 'static,
) -> Result<T, String> {
    let (sender, receiver) = mpsc::channel();
    app.run_on_main_thread(move || {
        if let Some(mtm) = MainThreadMarker::new() {
            let _ = sender.send(work(mtm));
        }
    })
    .map_err(|error| format!("Could not reach the main thread: {error}"))?;
    receiver
        .recv_timeout(timeout)
        .map_err(|_| "The main thread did not respond".to_string())
}

fn authorization_status() -> Result<UNAuthorizationStatus, String> {
    let (sender, receiver) = mpsc::channel();
    let block = RcBlock::new(move |settings: NonNull<UNNotificationSettings>| {
        let status = unsafe { settings.as_ref() }.authorizationStatus();
        let _ = sender.send(status);
    });
    UNUserNotificationCenter::currentNotificationCenter()
        .getNotificationSettingsWithCompletionHandler(&block);
    receiver
        .recv_timeout(SETTINGS_TIMEOUT)
        .map_err(|_| "Timed out reading notification settings".to_string())
}

fn is_granted(status: UNAuthorizationStatus) -> bool {
    status == UNAuthorizationStatus::Authorized
        || status == UNAuthorizationStatus::Provisional
        || status == UNAuthorizationStatus::Ephemeral
}

/// Outcomes of `request_permission`, mapped to the iOS statuses in commands.rs.
pub(crate) enum PermissionOutcome {
    Granted,
    Denied,
    PreviouslyDenied,
    Timeout(String),
    Error(String),
    Unsupported,
}

pub(crate) fn request_permission<R: Runtime>(
    app: &AppHandle<R>,
    timeout: Duration,
) -> PermissionOutcome {
    if !is_push_capable() {
        return PermissionOutcome::Unsupported;
    }

    let status = match authorization_status() {
        Ok(status) => status,
        Err(message) => return PermissionOutcome::Timeout(message),
    };
    if is_granted(status) {
        return PermissionOutcome::Granted;
    }
    if status == UNAuthorizationStatus::Denied {
        return PermissionOutcome::PreviouslyDenied;
    }

    let (sender, receiver) = mpsc::channel::<(bool, Option<String>)>();
    let asked = on_main_thread(app, SETTINGS_TIMEOUT, move |_| {
        let block = RcBlock::new(move |granted: Bool, error: *mut NSError| {
            let message =
                unsafe { error.as_ref() }.map(|error| error.localizedDescription().to_string());
            let _ = sender.send((granted.as_bool(), message));
        });
        UNUserNotificationCenter::currentNotificationCenter()
            .requestAuthorizationWithOptions_completionHandler(
                UNAuthorizationOptions::Alert
                    | UNAuthorizationOptions::Badge
                    | UNAuthorizationOptions::Sound,
                &block,
            );
    });
    if let Err(message) = asked {
        return PermissionOutcome::Error(message);
    }

    match receiver.recv_timeout(timeout) {
        Ok((true, _)) => PermissionOutcome::Granted,
        Ok((false, Some(message))) => PermissionOutcome::Error(message),
        Ok((false, None)) => PermissionOutcome::Denied,
        Err(_) => PermissionOutcome::Timeout(
            "No answer to the notification permission prompt".to_string(),
        ),
    }
}

/// "granted" | "denied" | "prompt" | "unsupported" | "unknown", without prompting.
pub(crate) fn permission_state() -> &'static str {
    if !is_push_capable() {
        return "unsupported";
    }
    match authorization_status() {
        Ok(status) if is_granted(status) => "granted",
        Ok(status) if status == UNAuthorizationStatus::Denied => "denied",
        Ok(_) => "prompt",
        Err(_) => "unknown",
    }
}

/// The main bundle's identifier as AppKit reports it, and as Info.plist
/// declares it.
fn bundle_identifiers() -> (String, String) {
    let bundle = NSBundle::mainBundle();
    let reported = bundle
        .bundleIdentifier()
        .map(|id| id.to_string())
        .unwrap_or_default();
    let declared = bundle
        .objectForInfoDictionaryKey(&NSString::from_str("CFBundleIdentifier"))
        .and_then(|value| value.downcast::<NSString>().ok())
        .map(|id| id.to_string())
        .unwrap_or_default();
    (reported, declared)
}

/// Undo mac-notification-sys's replacement of -[NSBundle bundleIdentifier]
/// when it misreports this app.
///
/// tauri-plugin-notification shows local notifications on macOS through
/// mac-notification-sys, which on the first one exchanges
/// -[NSBundle bundleIdentifier] with its own -__bundleIdentifier for the rest
/// of the process. That answers the identifier it was given only if Launch
/// Services knows an app with it (it may not for a copy run from the disk
/// image, a translocated copy, or a fresh install), and "com.apple.Terminal"
/// otherwise. AppKit asks APNs for a token for the main bundle's identifier,
/// so it then asks for Terminal's topic, which this app is not entitled to,
/// and neither registration callback ever arrives.
///
/// Exchanging the two implementations again restores the real identifier.
/// Local notifications are unaffected: a bundled app posts them as itself.
fn restore_bundle_identifier() {
    let (reported, declared) = bundle_identifiers();
    if declared.is_empty() || reported == declared {
        return;
    }
    let class = NSBundle::class();
    let (Some(current), Some(replaced)) = (
        class.instance_method(sel!(bundleIdentifier)),
        class.instance_method(sel!(__bundleIdentifier)),
    ) else {
        log::warn!(
            "[mobile-push] main bundle reports {reported}, Info.plist declares {declared}; not restored"
        );
        return;
    };
    // SAFETY: both are NSBundle methods with the signature
    // `-(NSString *)`, and this runs on the main thread (as the original
    // exchange did), so no other thread is mid-call through either one.
    unsafe { current.exchange_implementation(replaced) };
    let (restored, _) = bundle_identifiers();
    if restored == declared {
        log::info!("[mobile-push] restored bundle identifier {declared} (was {reported})");
    } else {
        // Not the exchange this expects: put it back the way it was.
        unsafe { current.exchange_implementation(replaced) };
        log::warn!(
            "[mobile-push] main bundle reports {reported}, Info.plist declares {declared}; not restored"
        );
    }
}

/// What the app looks like to APNs, for the error the page shows when no
/// answer arrives. Runs on the main thread.
fn registration_diagnostics(mtm: MainThreadMarker) -> String {
    let app = NSApplication::sharedApplication(mtm);
    let delegate = match app.delegate() {
        Some(delegate) => {
            let object: &AnyObject = ProtocolObject::as_ref(&*delegate);
            let handles = responds_to(
                object,
                sel!(application:didRegisterForRemoteNotificationsWithDeviceToken:),
            );
            format!(
                "{} ({})",
                object.class().name().to_string_lossy(),
                if handles {
                    "handles the token"
                } else {
                    "does not handle the token"
                }
            )
        }
        None => "none".to_string(),
    };
    let (reported, declared) = bundle_identifiers();
    let bundle = if reported == declared {
        reported
    } else {
        format!("{reported} (Info.plist: {declared})")
    };
    format!(
        "delegate {delegate}; bundle {bundle}; aps-environment {}; registered {}",
        aps_environment().unwrap_or("none"),
        if app.isRegisteredForRemoteNotifications() {
            "yes"
        } else {
            "no"
        }
    )
}

pub(crate) fn get_token<R: Runtime>(
    app: &AppHandle<R>,
    timeout: Duration,
) -> Result<String, String> {
    if !is_push_capable() {
        return Err(format!(
            "APNs is unavailable: this build is not signed with {APS_ENTITLEMENT}"
        ));
    }

    // APNs already answered in this launch, possibly after an earlier call
    // had given up waiting. That token is current until APNs sends another.
    if let Some(token) = SESSION_TOKEN.lock().ok().and_then(|token| token.clone()) {
        log::info!("[mobile-push] using the APNs token received earlier in this launch");
        return Ok(token);
    }

    let deadline = Instant::now() + timeout;
    let id = NEXT_TOKEN_WAITER.fetch_add(1, Ordering::Relaxed);
    let (sender, receiver) = mpsc::channel();
    let starts_registration = {
        let mut waiters = TOKEN_WAITERS
            .lock()
            .map_err(|_| "Token waiters poisoned".to_string())?;
        waiters.push((id, sender));
        waiters.len() == 1
    };

    let outcome = (|| {
        if starts_registration {
            let started = on_main_thread(app, TOKEN_MAIN_THREAD_TIMEOUT, |mtm| {
                restore_bundle_identifier();
                let delegate = ensure_app_delegate_callbacks(mtm);
                if delegate.is_ok() {
                    NSApplication::sharedApplication(mtm).registerForRemoteNotifications();
                }
                delegate
            })
            .and_then(|delegate| delegate);
            match started {
                Ok(delegate) => log::info!(
                    "[mobile-push] registering for remote notifications (delegate {delegate}, aps-environment {})",
                    aps_environment().unwrap_or("none")
                ),
                Err(message) => {
                    let message = format!("Could not register with APNs: {message}");
                    log::warn!("[mobile-push] {message}");
                    // Callers that joined this registration get the same answer.
                    answer_token_waiters(Err(message.clone()));
                    return Err(message);
                }
            }
        } else {
            log::info!("[mobile-push] waiting for the APNs registration already in progress");
        }

        // The first registration gets a short wait when a recovery is still
        // possible; otherwise the whole budget.
        let recovery_possible = starts_registration && !RECOVERY_ATTEMPTED.load(Ordering::SeqCst);
        let first_wait = if recovery_possible {
            FIRST_REGISTRATION_WAIT.min(timeout)
        } else {
            timeout
        };
        let mut answer = receiver.recv_timeout(first_wait).ok();

        // A Mac that APNs registered before keeps its token while AppKit
        // still reports it registered. Answer with that instead of tearing a
        // working registration down on a slow network.
        if answer.is_none() && recovery_possible {
            if let Some(token) = user_defaults_token() {
                let registered = on_main_thread(app, TOKEN_MAIN_THREAD_TIMEOUT, |mtm| {
                    NSApplication::sharedApplication(mtm).isRegisteredForRemoteNotifications()
                })
                .unwrap_or(false);
                if registered {
                    log::info!(
                        "[mobile-push] no APNs answer after {}s; using the token from an earlier registration",
                        first_wait.as_secs()
                    );
                    if let Ok(mut session) = SESSION_TOKEN.lock() {
                        *session = Some(token.clone());
                    }
                    // Callers that joined this registration get it too.
                    answer_token_waiters(Ok(token.clone()));
                    answer = Some(Ok(token));
                }
            }
        }

        // No answer: register again from scratch, once per launch. An app
        // that AppKit already reports as registered may never be called back
        // for a repeated registration, and a registration that stalled in
        // apsd stays stalled; unregistering discards both. The second
        // registration goes through -registerForRemoteNotificationTypes:, the
        // older entry point, in case the newer one is what stalled.
        if answer.is_none() && recovery_possible && !RECOVERY_ATTEMPTED.swap(true, Ordering::SeqCst)
        {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining > TOKEN_MAIN_THREAD_TIMEOUT {
                let restarted = on_main_thread(app, TOKEN_MAIN_THREAD_TIMEOUT, |mtm| {
                    let before = registration_diagnostics(mtm);
                    let ns_app = NSApplication::sharedApplication(mtm);
                    ns_app.unregisterForRemoteNotifications();
                    restore_bundle_identifier();
                    let delegate = ensure_app_delegate_callbacks(mtm);
                    if delegate.is_ok() {
                        #[allow(deprecated)]
                        ns_app.registerForRemoteNotificationTypes(
                            NSRemoteNotificationType::Alert
                                | NSRemoteNotificationType::Badge
                                | NSRemoteNotificationType::Sound,
                        );
                    }
                    (before, delegate)
                });
                match restarted {
                    Ok((before, Ok(_))) => log::warn!(
                        "[mobile-push] no APNs answer after {}s ({before}); registering again",
                        first_wait.as_secs()
                    ),
                    Ok((before, Err(message))) => log::warn!(
                        "[mobile-push] no APNs answer ({before}) and could not register again: {message}"
                    ),
                    Err(message) => {
                        log::warn!("[mobile-push] could not register again: {message}")
                    }
                }
                answer = receiver
                    .recv_timeout(deadline.saturating_duration_since(Instant::now()))
                    .ok();
            }
        } else if answer.is_none() && first_wait < timeout {
            // The recovery ran in a concurrent call; wait out the budget.
            answer = receiver
                .recv_timeout(deadline.saturating_duration_since(Instant::now()))
                .ok();
        }

        match answer {
            Some(result) => result,
            None => {
                let diagnostics = on_main_thread(app, TOKEN_MAIN_THREAD_TIMEOUT, |mtm| {
                    (
                        NSApplication::sharedApplication(mtm).isRegisteredForRemoteNotifications(),
                        registration_diagnostics(mtm),
                    )
                });
                let (registered, detail) = match diagnostics {
                    Ok(pair) => pair,
                    Err(message) => (false, message),
                };
                log::warn!(
                    "[mobile-push] no APNs answer after {}s: {detail}",
                    timeout.as_secs()
                );
                // A token from an earlier registration is still this Mac's
                // token while the app stays registered, so prefer it over
                // failing on a slow network (same as the Swift side).
                let result = match user_defaults_token() {
                    Some(token) if registered => {
                        log::info!("[mobile-push] token callback timed out; using cached token");
                        if let Ok(mut session) = SESSION_TOKEN.lock() {
                            *session = Some(token.clone());
                        }
                        Ok(token)
                    }
                    // Signing and the callbacks are checked by now (they are
                    // in `detail`), so what is left is the Mac's connection
                    // to APNs, which apsd makes for every app.
                    _ => Err(format!(
                        "Apple Push Notification service did not answer within {} seconds ({detail}). \
                         If this repeats, check that this Mac can reach Apple's push servers \
                         (TCP port 5223 to *.push.apple.com, not blocked by a VPN, proxy or firewall).",
                        timeout.as_secs()
                    )),
                };
                // Calls that joined this registration get the same answer and
                // the list empties, so the next call registers afresh instead
                // of waiting on a registration that is not coming back.
                if starts_registration {
                    answer_token_waiters(result.clone());
                }
                result
            }
        }
    })();

    if let Ok(mut waiters) = TOKEN_WAITERS.lock() {
        waiters.retain(|(waiter, _)| *waiter != id);
    }
    outcome
}

/// Open the Notifications pane of System Settings, on this app's entry where
/// the OS supports it.
pub(crate) fn open_settings<R: Runtime>(app: &AppHandle<R>) -> bool {
    let bundle_id = NSBundle::mainBundle()
        .bundleIdentifier()
        .map(|id| id.to_string())
        .unwrap_or_default();
    on_main_thread(app, SETTINGS_TIMEOUT, move |_| {
        let workspace = NSWorkspace::sharedWorkspace();
        let candidates = [
            format!(
                "x-apple.systempreferences:com.apple.Notifications-Settings.extension?id={bundle_id}"
            ),
            "x-apple.systempreferences:com.apple.preference.notifications".to_string(),
        ];
        candidates.iter().any(|candidate| {
            NSURL::URLWithString(&NSString::from_str(candidate))
                .is_some_and(|url| workspace.openURL(&url))
        })
    })
    .unwrap_or(false)
}
