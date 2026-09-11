#pragma once

#include <react/renderer/components/LecturnMarkdownTextSpec/EventEmitters.h>
#include <react/renderer/components/LecturnMarkdownTextSpec/Props.h>
#include <react/renderer/components/LecturnMarkdownTextSpec/States.h>
#include <react/renderer/components/view/ConcreteViewShadowNode.h>

namespace facebook::react {
extern const char LecturnMarkdownTextRunComponentName[];

using LecturnMarkdownTextRunShadowNode = ConcreteViewShadowNode<
    LecturnMarkdownTextRunComponentName,
    LecturnMarkdownTextRunProps,
    LecturnMarkdownTextRunEventEmitter,
    LecturnMarkdownTextRunState>;
}
