#import <UIKit/UIKit.h>
#import <objc/runtime.h>
#import <UserNotifications/UserNotifications.h>

/**
 * TaoWindowCapture + APNs Delegate Injection
 *
 * This file uses +load to swizzle two things BEFORE the app delegate runs:
 *
 * 1. UIWindow.makeKeyAndVisible — captures tao's window reference so the
 *    SceneDelegate can assign the windowScene later (iOS 26 fix).
 *
 * 2. UIApplication.setDelegate: — injects APNs callback methods
 *    (didRegisterForRemoteNotificationsWithDeviceToken: and
 *    didFailToRegisterForRemoteNotificationsWithError:) into whatever class
 *    is being set as the app delegate, BEFORE the original setDelegate: runs.
 *    This ensures UIApplication's internal respondsToSelector: cache includes
 *    our methods from the start — no delegate reassignment needed.
 *
 * +load is the ONLY reliable way to run code before didFinishLaunchingWithOptions.
 * Swift does not support +load, hence this Objective-C file.
 *
 * The APNs injection pattern is the same approach used by Firebase's
 * GULAppDelegateSwizzler — inject methods before UIApplication caches them.
 */

// Static storage for captured windows
static NSMutableArray<UIWindow *> *_capturedWindows = nil;
static BOOL _swizzleInstalled = NO;
static BOOL _apnsMethodsInjected = NO;

// Original IMP for UIApplication.setDelegate:
static void (*_originalSetDelegate)(id, SEL, id<UIApplicationDelegate>) = NULL;

// Forward declaration
static void _injectApnsMethodsIntoClass(Class cls);

#pragma mark - TaoWindowCapture interface

@interface TaoWindowCapture : NSObject
+ (NSArray<UIWindow *> *)capturedWindows;
+ (void)clearCapturedWindows;
+ (BOOL)apnsMethodsInjected;
@end

@implementation TaoWindowCapture

+ (void)load {
    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{
        _capturedWindows = [NSMutableArray new];

        // === Swizzle 1: UIWindow.makeKeyAndVisible ===
        Class windowCls = [UIWindow class];
        SEL originalSel = @selector(makeKeyAndVisible);
        SEL swizzledSel = @selector(tao_captured_makeKeyAndVisible);

        Method originalMethod = class_getInstanceMethod(windowCls, originalSel);
        Method swizzledMethod = class_getInstanceMethod(windowCls, swizzledSel);

        if (originalMethod && swizzledMethod) {
            BOOL didAdd = class_addMethod(windowCls, originalSel,
                                          method_getImplementation(swizzledMethod),
                                          method_getTypeEncoding(swizzledMethod));
            if (didAdd) {
                class_replaceMethod(windowCls, swizzledSel,
                                    method_getImplementation(originalMethod),
                                    method_getTypeEncoding(originalMethod));
            } else {
                method_exchangeImplementations(originalMethod, swizzledMethod);
            }
            _swizzleInstalled = YES;
            NSLog(@"[TaoWindowCapture:+load] Swizzled UIWindow.makeKeyAndVisible");
        } else {
            NSLog(@"[TaoWindowCapture:+load] ERROR: Could not find UIWindow methods to swizzle");
        }

        // === Swizzle 2: UIApplication.setDelegate: ===
        // This intercepts the delegate assignment so we can inject APNs methods
        // into the delegate class BEFORE UIApplication builds its cache.
        Class appCls = [UIApplication class];
        SEL setDelegateSel = @selector(setDelegate:);
        Method setDelegateMethod = class_getInstanceMethod(appCls, setDelegateSel);

        if (setDelegateMethod) {
            _originalSetDelegate = (void (*)(id, SEL, id<UIApplicationDelegate>))method_getImplementation(setDelegateMethod);

            IMP newImp = imp_implementationWithBlock(^(id self, id<UIApplicationDelegate> delegate) {
                if (delegate && !_apnsMethodsInjected) {
                    Class delegateCls = object_getClass(delegate);
                    NSLog(@"[TaoWindowCapture:setDelegate] Injecting APNs methods into %@ before original setDelegate:", NSStringFromClass(delegateCls));
                    _injectApnsMethodsIntoClass(delegateCls);
                    _apnsMethodsInjected = YES;
                }

                // Call original setDelegate: — UIApplication will now build its
                // respondsToSelector: cache with our methods already present.
                if (_originalSetDelegate) {
                    _originalSetDelegate(self, setDelegateSel, delegate);
                }
            });

            method_setImplementation(setDelegateMethod, newImp);
            NSLog(@"[TaoWindowCapture:+load] Swizzled UIApplication.setDelegate:");
        } else {
            NSLog(@"[TaoWindowCapture:+load] ERROR: Could not find UIApplication.setDelegate:");
        }
    });
}

+ (NSArray<UIWindow *> *)capturedWindows {
    return [_capturedWindows copy];
}

+ (void)clearCapturedWindows {
    [_capturedWindows removeAllObjects];
}

+ (BOOL)apnsMethodsInjected {
    return _apnsMethodsInjected;
}

@end

#pragma mark - UIWindow swizzle category

@implementation UIWindow (TaoCapture)

- (void)tao_captured_makeKeyAndVisible {
    NSLog(@"[TaoWindowCapture:swizzle] makeKeyAndVisible called on %@, windowScene=%@",
          self, self.windowScene);

    if (self.windowScene == nil) {
        NSLog(@"[TaoWindowCapture:swizzle] Captured sceneless window: %@", self);
        [_capturedWindows addObject:self];
    }

    // Call original (swizzled to this selector)
    [self tao_captured_makeKeyAndVisible];
}

@end

#pragma mark - APNs method injection

/**
 * Injects didRegisterForRemoteNotificationsWithDeviceToken: and
 * didFailToRegisterForRemoteNotificationsWithError: into the given class.
 *
 * These implementations post NSNotifications that MobilePushPlugin.swift
 * observes. This decouples the ObjC injection from the Swift plugin — the
 * plugin doesn't need to do any delegate manipulation at all.
 */
static void _injectApnsMethodsIntoClass(Class cls) {
    // --- didRegisterForRemoteNotificationsWithDeviceToken: ---
    SEL didRegisterSel = sel_registerName("application:didRegisterForRemoteNotificationsWithDeviceToken:");

    if (!class_respondsToSelector(cls, didRegisterSel)) {
        IMP didRegisterImp = imp_implementationWithBlock(^(id _self, UIApplication *app, NSData *tokenData) {
            NSString *tokenString = @"";
            const unsigned char *bytes = (const unsigned char *)[tokenData bytes];
            NSMutableString *hex = [NSMutableString stringWithCapacity:tokenData.length * 2];
            for (NSUInteger i = 0; i < tokenData.length; i++) {
                [hex appendFormat:@"%02x", bytes[i]];
            }
            tokenString = [hex copy];

            NSLog(@"[TaoWindowCapture:APNs] Token received: %@...", [tokenString substringToIndex:MIN(16, tokenString.length)]);

            // Post notification for MobilePushPlugin.swift to pick up
            [[NSNotificationCenter defaultCenter]
                postNotificationName:@"APNsTokenReceived"
                object:nil
                userInfo:@{@"token": tokenString, @"tokenData": tokenData}];
        });

        if (class_addMethod(cls, didRegisterSel, didRegisterImp, "v@:@@")) {
            NSLog(@"[TaoWindowCapture:APNs] Added didRegisterForRemoteNotificationsWithDeviceToken: to %@", NSStringFromClass(cls));
        } else {
            NSLog(@"[TaoWindowCapture:APNs] WARN: class_addMethod failed for didRegister on %@", NSStringFromClass(cls));
        }
    } else {
        NSLog(@"[TaoWindowCapture:APNs] didRegisterForRemoteNotificationsWithDeviceToken: already exists on %@", NSStringFromClass(cls));
    }

    // --- didFailToRegisterForRemoteNotificationsWithError: ---
    SEL didFailSel = sel_registerName("application:didFailToRegisterForRemoteNotificationsWithError:");

    if (!class_respondsToSelector(cls, didFailSel)) {
        IMP didFailImp = imp_implementationWithBlock(^(id _self, UIApplication *app, NSError *error) {
            NSLog(@"[TaoWindowCapture:APNs] Registration failed: %@", error.localizedDescription);

            // Post notification for MobilePushPlugin.swift to pick up
            [[NSNotificationCenter defaultCenter]
                postNotificationName:@"APNsRegistrationFailed"
                object:nil
                userInfo:@{@"error": error.localizedDescription ?: @"Unknown error"}];
        });

        if (class_addMethod(cls, didFailSel, didFailImp, "v@:@@")) {
            NSLog(@"[TaoWindowCapture:APNs] Added didFailToRegisterForRemoteNotificationsWithError: to %@", NSStringFromClass(cls));
        } else {
            NSLog(@"[TaoWindowCapture:APNs] WARN: class_addMethod failed for didFail on %@", NSStringFromClass(cls));
        }
    } else {
        NSLog(@"[TaoWindowCapture:APNs] didFailToRegisterForRemoteNotificationsWithError: already exists on %@", NSStringFromClass(cls));
    }

    // --- application:didReceiveRemoteNotification:fetchCompletionHandler: ---
    SEL didReceiveSel = sel_registerName("application:didReceiveRemoteNotification:fetchCompletionHandler:");

    if (!class_respondsToSelector(cls, didReceiveSel)) {
        IMP didReceiveImp = imp_implementationWithBlock(^(id _self, UIApplication *app, NSDictionary *userInfo, void (^completionHandler)(UIBackgroundFetchResult)) {
            NSLog(@"[TaoWindowCapture:APNs] Remote notification received (background)");

            [[NSNotificationCenter defaultCenter]
                postNotificationName:@"PushNotificationReceived"
                object:nil
                userInfo:userInfo];

            if (completionHandler) {
                completionHandler(UIBackgroundFetchResultNewData);
            }
        });

        if (class_addMethod(cls, didReceiveSel, didReceiveImp, "v@:@@?")) {
            NSLog(@"[TaoWindowCapture:APNs] Added didReceiveRemoteNotification:fetchCompletionHandler: to %@", NSStringFromClass(cls));
        } else {
            NSLog(@"[TaoWindowCapture:APNs] WARN: class_addMethod failed for didReceive on %@", NSStringFromClass(cls));
        }
    } else {
        NSLog(@"[TaoWindowCapture:APNs] didReceiveRemoteNotification:fetchCompletionHandler: already exists on %@", NSStringFromClass(cls));
    }
}
