package expo.modules.lecturnnativecontrols

import android.content.Context
import android.view.ViewGroup
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationBarItemDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.ComposeView
import androidx.compose.ui.platform.ViewCompositionStrategy
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.sp
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView

class LecturnWorkspaceNavigationModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("LecturnWorkspaceNavigation")
    View(LecturnWorkspaceNavigationView::class) {
      Prop("selectedTab") { view: LecturnWorkspaceNavigationView, value: String ->
        view.selectedTab = value
      }
      Prop("dark") { view: LecturnWorkspaceNavigationView, value: Boolean -> view.dark = value }
      Prop("textScale") { view: LecturnWorkspaceNavigationView, value: Float ->
        view.textScale = value
      }
      Prop("containerColor") { view: LecturnWorkspaceNavigationView, value: Int ->
        view.containerColor = value
      }
      Prop("selectedColor") { view: LecturnWorkspaceNavigationView, value: Int ->
        view.selectedColor = value
      }
      Prop("indicatorColor") { view: LecturnWorkspaceNavigationView, value: Int ->
        view.indicatorColor = value
      }
      Prop("unselectedColor") { view: LecturnWorkspaceNavigationView, value: Int ->
        view.unselectedColor = value
      }
      Events("onTabSelected")
    }
  }
}

/** Material3 bottom navigation for the compact workspace. */
class LecturnWorkspaceNavigationView(
  context: Context,
  appContext: AppContext
) : ExpoView(context, appContext) {
  // Compose must remeasure native children when Yoga resizes the folded window.
  override val shouldUseAndroidLayout = true

  private val onTabSelected by EventDispatcher()
  var selectedTab by mutableStateOf("threads")
  var dark by mutableStateOf(false)
  var textScale by mutableStateOf(1f)
  var containerColor by mutableStateOf(0)
  var selectedColor by mutableStateOf(0)
  var indicatorColor by mutableStateOf(0)
  var unselectedColor by mutableStateOf(0)

  override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
    // Fabric measures the replacement bar before attaching it on a fold.
    // Compose needs an attached window to obtain its lifecycle recomposer.
    if (!isAttachedToWindow) {
      setMeasuredDimension(
        MeasureSpec.getSize(widthMeasureSpec),
        MeasureSpec.getSize(heightMeasureSpec)
      )
      return
    }
    super.onMeasure(widthMeasureSpec, heightMeasureSpec)
  }

  override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) {
    if (isAttachedToWindow) super.onLayout(changed, left, top, right, bottom)
  }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    requestLayout()
  }

  init {
    addView(
      ComposeView(context).apply {
        setViewCompositionStrategy(
          ViewCompositionStrategy.DisposeOnDetachedFromWindowOrReleasedFromPool
        )
        setContent {
          MaterialTheme(colorScheme = if (dark) darkColorScheme() else lightColorScheme()) {
            val tabs = listOf("threads", "apps", "pullRequests")
            NavigationBar(
              modifier = Modifier.fillMaxSize(),
              containerColor = Color(containerColor),
              tonalElevation = androidx.compose.ui.unit.Dp(0f),
              windowInsets = WindowInsets(0),
            ) {
              tabs.forEach { tab ->
                NavigationBarItem(
                  selected = selectedTab == tab,
                  onClick = { onTabSelected(mapOf("tab" to tab)) },
                  icon = { tabIcon(tab) },
                  label = {
                    // Three equal slots leave "Pull requests" too wide at larger
                    // text sizes; the short label matches the iOS tab bar.
                    val (title, description) = when (tab) {
                      "threads" -> "Chats" to "Chats"
                      "apps" -> "Apps" to "Apps"
                      else -> "Pulls" to "Pull requests"
                    }
                    Text(
                      title,
                      modifier = Modifier.semantics { contentDescription = description },
                      fontSize = (12 * textScale).sp,
                    )
                  },
                  colors = NavigationBarItemDefaults.colors(
                    selectedIconColor = Color(selectedColor),
                    selectedTextColor = Color(selectedColor),
                    indicatorColor = Color(indicatorColor),
                    unselectedIconColor = Color(unselectedColor),
                    unselectedTextColor = Color(unselectedColor),
                  ),
                )
              }
            }
          }
        }
      },
      LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
    )
  }

  @Composable
  private fun tabIcon(tab: String) {
    val (drawable, description) = when (tab) {
      "threads" -> R.drawable.lecturn_chats to "Chats"
      "apps" -> R.drawable.lecturn_apps to "Apps"
      else -> R.drawable.lecturn_pull_requests to "Pull requests"
    }
    Icon(
      painter = painterResource(drawable),
      contentDescription = description,
    )
  }
}
