package expo.modules.lecturnreviewdiff

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class LecturnReviewDiffModule : Module() {
  // One declaration per native view prop; splitting the definition would only scatter them.
  @Suppress("LongMethod")
  override fun definition() = ModuleDefinition {
    Name("LecturnReviewDiffSurface")

    View(LecturnReviewDiffView::class) {
      Prop("tokensResetKey") { view: LecturnReviewDiffView, tokensResetKey: String ->
        view.setTokensResetKey(tokensResetKey)
      }
      Prop("contentResetKey") { view: LecturnReviewDiffView, contentResetKey: String ->
        view.setContentResetKey(contentResetKey)
      }
      Prop("collapsedFileIdsJson") { view: LecturnReviewDiffView, collapsedFileIdsJson: String ->
        view.setCollapsedFileIdsJson(collapsedFileIdsJson)
      }
      Prop("viewedFileIdsJson") { view: LecturnReviewDiffView, viewedFileIdsJson: String ->
        view.setViewedFileIdsJson(viewedFileIdsJson)
      }
      Prop("selectedRowIdsJson") { view: LecturnReviewDiffView, selectedRowIdsJson: String ->
        view.setSelectedRowIdsJson(selectedRowIdsJson)
      }
      Prop("collapsedCommentIdsJson") {
          view: LecturnReviewDiffView,
          collapsedCommentIdsJson: String
        ->
        view.setCollapsedCommentIdsJson(collapsedCommentIdsJson)
      }
      Prop("appearanceScheme") { view: LecturnReviewDiffView, appearanceScheme: String ->
        view.setAppearanceScheme(appearanceScheme)
      }
      Prop("themeJson") { view: LecturnReviewDiffView, themeJson: String ->
        view.setThemeJson(themeJson)
      }
      Prop("styleJson") { view: LecturnReviewDiffView, styleJson: String ->
        view.setStyleJson(styleJson)
      }
      Prop("rowHeight") { view: LecturnReviewDiffView, rowHeight: Double ->
        view.setRowHeight(rowHeight.toFloat())
      }
      // Accept the shared prop while deriving Android's scroll range from the drawn text.
      Prop("contentWidth") { _: LecturnReviewDiffView, _: Double -> }
      Prop("contentInsetBottom") { view: LecturnReviewDiffView, value: Double ->
        view.setContentInsetBottom(value.toFloat())
      }
      Prop("scrollEnabled") { view: LecturnReviewDiffView, enabled: Boolean ->
        view.setScrollEnabled(enabled)
      }
      Prop("initialRowIndex") { view: LecturnReviewDiffView, initialRowIndex: Double ->
        view.setInitialRowIndex(initialRowIndex)
      }

      Events(
        "onDebug",
        "onVisibleFileChange",
        "onToggleFile",
        "onToggleViewedFile",
        "onPressLine",
        "onToggleComment",
      )

      AsyncFunction("scrollToFile") {
          view: LecturnReviewDiffView,
          fileId: String,
          animated: Boolean
        ->
        view.scrollToFile(fileId, animated)
      }
      AsyncFunction("scrollToTop") { view: LecturnReviewDiffView, animated: Boolean ->
        view.scrollToTop(animated)
      }
      AsyncFunction("setRowsJson") { view: LecturnReviewDiffView, rowsJson: String ->
        view.setRowsJson(rowsJson)
      }
      AsyncFunction("setTokensJson") { view: LecturnReviewDiffView, tokensJson: String ->
        view.setTokensJson(tokensJson)
      }
      AsyncFunction("setTokensPatchJson") { view: LecturnReviewDiffView, tokensPatchJson: String ->
        view.setTokensPatchJson(tokensPatchJson)
      }

      OnViewDestroys { view: LecturnReviewDiffView ->
        view.cleanup()
      }
    }
  }
}
