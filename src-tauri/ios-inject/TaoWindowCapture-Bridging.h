#import <UIKit/UIKit.h>

/**
 * Bridging header for TaoWindowCapture.
 * Exposes the captured window references to Swift (SceneDelegate).
 */

@interface TaoWindowCapture : NSObject
/// Returns all UIWindows that called makeKeyAndVisible without a windowScene.
+ (NSArray<UIWindow *> * _Nonnull)capturedWindows;
/// Clears the captured windows array (call after assigning the scene).
+ (void)clearCapturedWindows;
@end
