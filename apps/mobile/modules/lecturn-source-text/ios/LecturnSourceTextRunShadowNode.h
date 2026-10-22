#pragma once

#include <react/renderer/components/LecturnSourceTextSpec/EventEmitters.h>
#include <react/renderer/components/LecturnSourceTextSpec/Props.h>
#include <react/renderer/components/LecturnSourceTextSpec/States.h>
#include <react/renderer/components/view/ConcreteViewShadowNode.h>

namespace facebook::react {
extern const char LecturnSourceTextRunComponentName[];

using LecturnSourceTextRunShadowNode =
    ConcreteViewShadowNode<LecturnSourceTextRunComponentName, LecturnSourceTextRunProps,
                           LecturnSourceTextRunEventEmitter, LecturnSourceTextRunState>;
} // namespace facebook::react
