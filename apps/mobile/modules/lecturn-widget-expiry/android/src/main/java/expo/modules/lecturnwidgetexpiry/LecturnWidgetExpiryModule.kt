package expo.modules.lecturnwidgetexpiry

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class LecturnWidgetExpiryModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("LecturnWidgetExpiry")
    Function("schedule") { name: String, deadlines: List<Double> ->
      val context = appContext.reactContext ?: return@Function
      WidgetExpiryReceiver.schedule(context, name, deadlines.map { it.toLong() }.toLongArray())
    }
  }
}
