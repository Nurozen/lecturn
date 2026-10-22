#pragma once

#include "LecturnSourceTextShadowNode.h"

#include <react/renderer/componentregistry/ComponentDescriptorProviderRegistry.h>
#include <react/renderer/core/ConcreteComponentDescriptor.h>

namespace facebook::react {
using LecturnSourceTextComponentDescriptor =
    ConcreteComponentDescriptor<LecturnSourceTextShadowNode>;

void LecturnSourceTextSpec_registerComponentDescriptorsFromCodegen(
    std::shared_ptr<const ComponentDescriptorProviderRegistry> registry);
} // namespace facebook::react
