#import <React/RCTUIManager.h>
#import <React/RCTViewManager.h>

@interface LecturnSourceTextManager : RCTViewManager
@end

@implementation LecturnSourceTextManager

RCT_EXPORT_MODULE(LecturnSourceText)

- (UIView *)view {
  return [[UIView alloc] init];
}

@end

@interface LecturnSourceTextRunManager : RCTViewManager
@end

@implementation LecturnSourceTextRunManager

RCT_EXPORT_MODULE(LecturnSourceTextRun)

- (UIView *)view {
  return nil;
}

@end
