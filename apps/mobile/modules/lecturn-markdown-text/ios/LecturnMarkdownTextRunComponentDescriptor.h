#pragma once

#include "LecturnMarkdownTextRunShadowNode.h"

#include <react/renderer/core/ConcreteComponentDescriptor.h>
#include <react/renderer/componentregistry/ComponentDescriptorProviderRegistry.h>

namespace facebook::react {
using LecturnMarkdownTextRunComponentDescriptor = ConcreteComponentDescriptor<LecturnMarkdownTextRunShadowNode>;

void LecturnMarkdownTextRunSpec_registerComponentDescriptorsFromCodegen(
  std::shared_ptr<const ComponentDescriptorProviderRegistry> registry);
}
