#import <React/RCTViewManager.h>
#import <React/RCTUIManager.h>
#import "RCTBridge.h"
#import "Utils.h"

@interface LecturnMarkdownTextManager : RCTViewManager
@end

@implementation LecturnMarkdownTextManager

RCT_EXPORT_MODULE(LecturnMarkdownText)

- (UIView *)view
{
  return [[UIView alloc] init];
}

RCT_CUSTOM_VIEW_PROPERTY(color, NSString, UIView)
{
}

@end

@interface LecturnMarkdownTextRunManager : RCTViewManager
@end

@implementation LecturnMarkdownTextRunManager

RCT_EXPORT_MODULE(LecturnMarkdownTextRun)

- (UIView *)view
{
  return nil;
}

@end
