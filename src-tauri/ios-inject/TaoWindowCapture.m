#import <UIKit/UIKit.h>
#import <objc/runtime.h>

/**
 * TaoWindowCapture
 *
 * This file uses +load to swizzle UIWindow.makeKeyAndVisible BEFORE the app
 * delegate runs. tao 0.34.x creates a UIWindow in
 * application:didFinishLaunchingWithOptions: and calls makeKeyAndVisible there.
 * On iOS 26, a UIWindow without a windowScene is not rendered.
 *
 * By swizzling in +load (which runs before ANY app code), we intercept tao's
 * makeKeyAndVisible call and store the window reference. The SceneDelegate then
 * retrieves this reference and assigns the windowScene.
 *
 * +load is the ONLY reliable way to run code before didFinishLaunchingWithOptions.
 * Swift does not support +load, hence this Objective-C file.
 */

// Static storage for captured windows
static NSMutableArray<UIWindow *> *_capturedWindows = nil;
static BOOL _swizzleInstalled = NO;

@interface TaoWindowCapture : NSObject
+ (NSArray<UIWindow *> *)capturedWindows;
+ (void)clearCapturedWindows;
@end

@implementation TaoWindowCapture

+ (void)load {
    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{
        _capturedWindows = [NSMutableArray new];

        Class cls = [UIWindow class];
        SEL originalSel = @selector(makeKeyAndVisible);
        SEL swizzledSel = @selector(tao_captured_makeKeyAndVisible);

        Method originalMethod = class_getInstanceMethod(cls, originalSel);
        Method swizzledMethod = class_getInstanceMethod(cls, swizzledSel);

        if (originalMethod && swizzledMethod) {
            // Add the swizzled method to the class first (in case it doesn't exist)
            BOOL didAdd = class_addMethod(cls, originalSel,
                                          method_getImplementation(swizzledMethod),
                                          method_getTypeEncoding(swizzledMethod));
            if (didAdd) {
                class_replaceMethod(cls, swizzledSel,
                                    method_getImplementation(originalMethod),
                                    method_getTypeEncoding(originalMethod));
            } else {
                method_exchangeImplementations(originalMethod, swizzledMethod);
            }
            _swizzleInstalled = YES;
            NSLog(@"[TaoWindowCapture:+load] Swizzled UIWindow.makeKeyAndVisible");
        } else {
            NSLog(@"[TaoWindowCapture:+load] ERROR: Could not find methods to swizzle");
        }
    });
}

+ (NSArray<UIWindow *> *)capturedWindows {
    return [_capturedWindows copy];
}

+ (void)clearCapturedWindows {
    [_capturedWindows removeAllObjects];
}

@end

@implementation UIWindow (TaoCapture)

- (void)tao_captured_makeKeyAndVisible {
    // Store reference to this window BEFORE calling original
    NSLog(@"[TaoWindowCapture:swizzle] makeKeyAndVisible called on %@, windowScene=%@",
          self, self.windowScene);

    // Capture windows that have no windowScene (these are tao's windows)
    if (self.windowScene == nil) {
        NSLog(@"[TaoWindowCapture:swizzle] Captured sceneless window: %@", self);
        [_capturedWindows addObject:self];
    }

    // Call original implementation (which is now at tao_captured_makeKeyAndVisible
    // due to the swizzle exchange)
    [self tao_captured_makeKeyAndVisible];
}

@end
