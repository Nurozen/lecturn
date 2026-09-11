#pragma once

#include "LecturnMarkdownTextShadowNode.h"

#include <react/renderer/core/ConcreteComponentDescriptor.h>
#include <react/renderer/componentregistry/ComponentDescriptorProviderRegistry.h>

namespace facebook::react {
using LecturnMarkdownTextComponentDescriptor = ConcreteComponentDescriptor<LecturnMarkdownTextShadowNode>;

void LecturnMarkdownTextSpec_registerComponentDescriptorsFromCodegen(
  std::shared_ptr<const ComponentDescriptorProviderRegistry> registry);
}
