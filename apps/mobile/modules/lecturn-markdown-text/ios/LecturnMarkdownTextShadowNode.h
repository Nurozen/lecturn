#pragma once

#include <react/renderer/components/LecturnMarkdownTextSpec/EventEmitters.h>
#include <react/renderer/components/LecturnMarkdownTextSpec/Props.h>
#include <react/renderer/components/view/ConcreteViewShadowNode.h>
#include <react/renderer/textlayoutmanager/TextLayoutManager.h>
#include <react/renderer/core/LayoutContext.h>
#include <react/renderer/core/ShadowNode.h>

#include <string>
#include <vector>

namespace facebook::react {

extern const char LecturnMarkdownTextComponentName[];

struct LecturnMarkdownTextParagraphStyleRange {
  size_t location;
  size_t length;
  Float firstLineHeadIndent;
  Float headIndent;
  Float paragraphSpacing;
};

struct LecturnMarkdownTextAttachmentRange {
  size_t location;
  size_t length;
  std::string imageUri;
};

inline Float LecturnMarkdownTextAttachmentSize(const LecturnMarkdownTextAttachmentRange &) {
  return 14;
}

inline Float LecturnMarkdownTextAttachmentBaselineOffset(
    const LecturnMarkdownTextAttachmentRange &) {
  return -2;
}

class LecturnMarkdownTextStateReal final {
 public:
  AttributedString attributedString;
  std::vector<LecturnMarkdownTextParagraphStyleRange> paragraphStyleRanges;
  std::vector<LecturnMarkdownTextAttachmentRange> attachmentRanges;
};

class LecturnMarkdownTextShadowNode final : public ConcreteViewShadowNode<
LecturnMarkdownTextComponentName,
LecturnMarkdownTextProps,
LecturnMarkdownTextEventEmitter,
LecturnMarkdownTextStateReal> {
public:
  using ConcreteViewShadowNode::ConcreteViewShadowNode;

  LecturnMarkdownTextShadowNode(
   const ShadowNode& sourceShadowNode,
   const ShadowNodeFragment& fragment
  );

  static ShadowNodeTraits BaseTraits() {
    auto traits = ConcreteViewShadowNode::BaseTraits();
    traits.set(ShadowNodeTraits::Trait::LeafYogaNode);
    traits.set(ShadowNodeTraits::Trait::MeasurableYogaNode);
    return traits;
  }

  void layout(LayoutContext layoutContext) override;

  Size measureContent(
      const LayoutContext& layoutContext,
      const LayoutConstraints& layoutConstraints) const override;

private:
  mutable AttributedString _attributedString;
  mutable std::vector<LecturnMarkdownTextParagraphStyleRange> _paragraphStyleRanges;
  mutable std::vector<LecturnMarkdownTextAttachmentRange> _attachmentRanges;
};
} // namespace facebook::React
