#import "LecturnSourceTextRun.h"
#import <React/RCTFabricComponentsPlugins.h>
#import "LecturnSourceTextRunComponentDescriptor.h"
#import <react/renderer/components/LecturnSourceTextSpec/Props.h>
#import <react/renderer/components/LecturnSourceTextSpec/RCTComponentViewHelpers.h>

using namespace facebook::react;

@interface LecturnSourceTextRun () <RCTLecturnSourceTextRunViewProtocol>

@end

@implementation LecturnSourceTextRun {
  NSString *_text;
}

+ (ComponentDescriptorProvider)componentDescriptorProvider {
  return concreteComponentDescriptorProvider<
      LecturnSourceTextRunComponentDescriptor>();
}

- (instancetype)initWithFrame:(CGRect)frame {
  if (self = [super initWithFrame:frame]) {
    static const auto defaultProps =
        std::make_shared<const LecturnSourceTextRunProps>();
    _props = defaultProps;
  }
  return self;
}

- (void)updateProps:(Props::Shared const &)props
           oldProps:(Props::Shared const &)oldProps {
  const auto &oldViewProps =
      *std::static_pointer_cast<LecturnSourceTextRunProps const>(_props);
  const auto &newViewProps =
      *std::static_pointer_cast<LecturnSourceTextRunProps const>(props);

  if (newViewProps.text != oldViewProps.text) {
    NSString *text = [NSString stringWithUTF8String:newViewProps.text.c_str()];
    _text = text;
  }

  [super updateProps:props oldProps:oldProps];
}

+ (BOOL)shouldBeRecycled {
  return NO;
}

Class<RCTComponentViewProtocol> LecturnSourceTextRunCls(void) {
  return LecturnSourceTextRun.class;
}

@end
