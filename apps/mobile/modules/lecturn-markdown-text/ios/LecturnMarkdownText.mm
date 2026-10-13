#import "LecturnMarkdownText.h"
#import "LecturnMarkdownTextShadowNode.h"
#import "LecturnMarkdownTextComponentDescriptor.h"
#import "LecturnMarkdownTextRun.h"
#import <React/RCTConversions.h>
#import <objc/runtime.h>

#import <react/renderer/textlayoutmanager/RCTAttributedTextUtils.h>
#import <react/renderer/components/LecturnMarkdownTextSpec/EventEmitters.h>
#import <react/renderer/components/LecturnMarkdownTextSpec/Props.h>
#import <react/renderer/components/LecturnMarkdownTextSpec/RCTComponentViewHelpers.h>
#import "RCTFabricComponentsPlugins.h"

using namespace facebook::react;

static void LecturnMarkdownTextApplyParagraphStyles(
    NSMutableAttributedString *attributedString,
    const std::vector<LecturnMarkdownTextParagraphStyleRange> &styleRanges)
{
  for (const auto &styleRange : styleRanges) {
    if (styleRange.length == 0 || styleRange.location >= attributedString.length) {
      continue;
    }

    const NSRange markerRange = NSMakeRange(
        styleRange.location,
        MIN(styleRange.length, attributedString.length - styleRange.location));
    const NSRange paragraphRange = [attributedString.string paragraphRangeForRange:markerRange];
    const NSParagraphStyle *existingStyle =
        [attributedString attribute:NSParagraphStyleAttributeName
                            atIndex:paragraphRange.location
                     effectiveRange:nil];
    NSMutableParagraphStyle *paragraphStyle =
        existingStyle ? [existingStyle mutableCopy] : [NSMutableParagraphStyle new];
    paragraphStyle.firstLineHeadIndent = styleRange.firstLineHeadIndent;
    paragraphStyle.headIndent = styleRange.headIndent;
    paragraphStyle.paragraphSpacing = styleRange.paragraphSpacing;
    paragraphStyle.tabStops = @[
      [[NSTextTab alloc] initWithTextAlignment:NSTextAlignmentLeft
                                      location:styleRange.headIndent
                                       options:@{}]
    ];
    paragraphStyle.defaultTabInterval = styleRange.headIndent;
    [attributedString addAttribute:NSParagraphStyleAttributeName
                             value:paragraphStyle
                             range:paragraphRange];
  }
}

static void LecturnMarkdownTextApplyAttachments(
    NSMutableAttributedString *attributedString,
    const std::vector<LecturnMarkdownTextAttachmentRange> &attachmentRanges,
    NSDictionary<NSString *, UIImage *> *images)
{
  for (const auto &attachmentRange : attachmentRanges) {
    if (attachmentRange.length == 0 || attachmentRange.location >= attributedString.length) {
      continue;
    }

    NSString *imageUri = [NSString stringWithUTF8String:attachmentRange.imageUri.c_str()];
    NSTextAttachment *attachment = [[NSTextAttachment alloc] init];
    UIImage *image = images[imageUri];
    const BOOL isSymbol = [imageUri hasPrefix:@"sf:"];
    if (isSymbol) {
      image = [UIImage systemImageNamed:[imageUri substringFromIndex:3]];
    }
    UIColor *foregroundColor = [attributedString attribute:NSForegroundColorAttributeName
                                                   atIndex:attachmentRange.location
                                            effectiveRange:nil];
    if (image != nil && (isSymbol || attachmentRange.tintWithForeground)) {
      image = [image imageWithTintColor:foregroundColor ?: UIColor.labelColor
                          renderingMode:UIImageRenderingModeAlwaysOriginal];
    }
    attachment.image = image ?: [[UIImage alloc] init];
    const CGFloat attachmentSize = LecturnMarkdownTextAttachmentSize(attachmentRange);
    attachment.bounds = CGRectMake(
        0,
        LecturnMarkdownTextAttachmentBaselineOffset(attachmentRange),
        attachmentSize,
        attachmentSize);
    const NSRange range = NSMakeRange(
        attachmentRange.location,
        MIN(attachmentRange.length, attributedString.length - attachmentRange.location));
    NSMutableAttributedString *attachmentString =
        [[NSAttributedString attributedStringWithAttachment:attachment] mutableCopy];
    // Keep the run color on the attachment so a later re-apply (after the image
    // loads asynchronously) still tints with the link color, not labelColor.
    if (foregroundColor != nil) {
      [attachmentString addAttribute:NSForegroundColorAttributeName
                               value:foregroundColor
                               range:NSMakeRange(0, attachmentString.length)];
    }
    [attributedString replaceCharactersInRange:range withAttributedString:attachmentString];
  }
}

// Diagnostic artifact only; never install this observer in the normal app.
static BOOL LecturnFileChipDiagnosticVisible(UIView *view, UITextView *textView)
{
  if (!NSThread.isMainThread || view.window == nil || textView == nil ||
      textView.attributedText.length == 0 || textView.attributedText.length > 4096 ||
      [textView.attributedText.string rangeOfString:@"report.pdf"].location == NSNotFound) {
    return NO;
  }
  for (UIView *parent = view; parent != nil; parent = parent.superview) {
    if (parent.hidden || parent.alpha <= 0) return NO;
  }
  return YES;
}

static NSMutableDictionary *LecturnFileChipDiagnosticSnapshot(UIView *view, UITextView *tv)
{
  NSMutableDictionary *out = [NSMutableDictionary dictionary];
  NSMutableArray *hosts = [NSMutableArray array];
  out[@"hosts"] = hosts;
  @try {
    if (!LecturnFileChipDiagnosticVisible(view, tv) ||
        view.window.windowScene.activationState != UISceneActivationStateForegroundActive) return out;
    Class runClass = [LecturnMarkdownTextRun class];
    Ivar configIvar = class_getInstanceVariable(runClass, "_contextMenuConfig");
    if (!configIvar) @throw @"missing_native_ivars";
    if (view.subviews.count > 256) @throw @"content_limit";
    NSString *(^safeText)(NSString *) = ^NSString *(NSString *s) {
      NSString *rest = [s stringByReplacingOccurrencesOfString:@"report.pdf" withString:@""];
      NSCharacterSet *allowed = [NSCharacterSet characterSetWithCharactersInString:@" \t\r\n\u00a0\ufffc"];
      return [rest rangeOfCharacterFromSet:[allowed invertedSet]].location == NSNotFound
          ? s : @"[redacted-nonfixture-text]";
    };
    NSDictionary *(^rangeJSON)(NSRange) = ^NSDictionary *(NSRange r) {
      return @{@"location": @(r.location), @"length": @(r.length)};
    };
    NSArray *knownIDs = @[@"copy-full-path", @"copy-relative-path", @"open-file", @"save"];
    NSAttributedString *attr = tv.attributedText;
    NSString *rendered = attr.string ?: @"";
    NSMutableArray *runs = [NSMutableArray array];
    NSUInteger offset = 0, runIndex = 0, reportRuns = 0, configUnits = 0;
    NSRange reportRange = NSMakeRange(0, 0);
    for (NSUInteger si = 0; si < view.subviews.count; ++si) {
      UIView *child = view.subviews[si];
      if (![child isKindOfClass:runClass]) continue;
      if (![child respondsToSelector:@selector(text)] ||
          ![child respondsToSelector:@selector(hasContextMenu)]) @throw @"missing_run_selector";
      NSString *text = [(LecturnMarkdownTextRun *)child text] ?: @"";
      if (text.length > 4096 - offset) @throw @"content_limit";
      NSRange runRange = NSMakeRange(offset, text.length);
      if ([text rangeOfString:@"report.pdf"].location != NSNotFound) {
        reportRuns++;
        reportRange = runRange;
      }
      NSString *config = (NSString *)object_getIvar(child, configIvar);
      if (config && ![config isKindOfClass:[NSString class]]) @throw @"unexpected_config_type";
      NSMutableArray *ids = [NSMutableArray array];
      NSString *configStatus = @"empty";
      if (config.length > 65536 - configUnits) @throw @"content_limit";
      configUnits += config.length;
      if (config.length) {
        id parsed = [NSJSONSerialization JSONObjectWithData:[config dataUsingEncoding:NSUTF8StringEncoding]
                                                   options:0 error:NULL];
        configStatus = @"invalid";
        if ([parsed isKindOfClass:[NSDictionary class]] && [parsed[@"actions"] isKindOfClass:[NSArray class]]) {
          if ([parsed[@"actions"] count] > 256) @throw @"content_limit";
          configStatus = @"parsed";
          for (id action in parsed[@"actions"]) {
            id actionID = [action isKindOfClass:[NSDictionary class]] ? action[@"id"] : nil;
            [ids addObject:[knownIDs containsObject:actionID ?: @""] ? actionID : @"[redacted-action-id]"];
          }
        }
      }
      [runs addObject:@{@"index": @(runIndex++), @"subview_index": @(si),
        @"address": [NSString stringWithFormat:@"%p", child], @"text": safeText(text),
        @"utf16_length": @(text.length), @"range": rangeJSON(runRange),
        @"hasContextMenu": @((BOOL)[(LecturnMarkdownTextRun *)child hasContextMenu]),
        @"config_utf16_length": @(config.length), @"config_status": configStatus, @"action_ids": ids}];
      offset += text.length;
    }

    NSMutableArray *attachments = [NSMutableArray array], *filenameLinks = [NSMutableArray array];
    NSDictionary *(^linkAt)(NSUInteger) = ^NSDictionary *(NSUInteger index) {
      NSRange effective = NSMakeRange(0, 0);
      id link = [attr attribute:NSLinkAttributeName atIndex:index effectiveRange:&effective];
      return @{@"index": @(index), @"link_present": @(link != nil), @"effective_range": rangeJSON(effective)};
    };
    // Inspect every actual attachment, including ones outside the proposed run
    // range: a range mismatch must remain visible rather than be filtered out.
    for (NSUInteger i = 0; i < attr.length; ++i) {
      if ([attr attribute:NSAttachmentAttributeName atIndex:i effectiveRange:NULL]) {
        NSMutableDictionary *entry = [linkAt(i) mutableCopy];
        entry[@"in_report_run"] = @(reportRuns == 1 && NSLocationInRange(i, reportRange));
        entry[@"object_replacement_character"] = @([rendered characterAtIndex:i] == 0xfffc);
        [attachments addObject:entry];
      }
    }
    NSUInteger cursor = 0, filenames = 0;
    NSMutableArray *filenameRanges = [NSMutableArray array];
    while (cursor < rendered.length) {
      NSRange r = [rendered rangeOfString:@"report.pdf" options:0 range:NSMakeRange(cursor, rendered.length-cursor)];
      if (r.location == NSNotFound) break;
      filenames++;
      [filenameRanges addObject:rangeJSON(r)];
      for (NSUInteger i = r.location; i < NSMaxRange(r); ++i) [filenameLinks addObject:linkAt(i)];
      cursor = NSMaxRange(r);
    }
    id delegate = tv.delegate;
    [hosts addObject:@{@"address": [NSString stringWithFormat:@"%p", view],
      @"class": NSStringFromClass([view class]), @"hidden": @(view.hidden), @"alpha": @(view.alpha),
      @"window_address": [NSString stringWithFormat:@"%p", view.window],
      @"textview_address": [NSString stringWithFormat:@"%p", tv],
      @"delegate_class": delegate ? NSStringFromClass([delegate class]) : @"<nil>",
      @"menu_delegate_selector": @([delegate respondsToSelector:@selector(textView:menuConfigurationForTextItem:defaultMenu:)]),
      @"runs": runs, @"runs_utf16_length": @(offset), @"report_run_count": @(reportRuns),
      @"report_run_range": rangeJSON(reportRange), @"attributed_utf16_length": @(attr.length),
      @"filename_count": @(filenames), @"filename_ranges": filenameRanges,
      @"filename_links": filenameLinks, @"attachments": attachments}];
    out[@"views_scanned"] = @(1 + view.subviews.count);
  } @catch (id exception) {
    NSArray *errors = @[@"missing_native_ivars", @"missing_run_selector",
      @"unexpected_config_type", @"content_limit"];
    out[@"native_error"] = [errors containsObject:exception] ? exception : @"native_exception";
  }
  return out;
}

// Closed, diagnostic-only status journal. No content or NSError descriptions.
#import <math.h>
static NSMutableArray<NSDictionary *> *LecturnFileChipStatusEvents;
static double LecturnFileChipStatusTime(double value)
{
  return isfinite(value) && value >= 0 ? value : 0;
}

static NSDictionary *LecturnFileChipStatusEvent(
    NSString *stage, NSUInteger attempt, NSDictionary *facts, NSString *reason, NSError *error)
{
  if (![@[@"initialized", @"start_decision", @"sample", @"snapshot", @"serialize", @"write"]
      containsObject:stage]) return nil;
  NSMutableDictionary *event = [@{@"stage": stage,
    @"unix_ms": @(LecturnFileChipStatusTime(NSDate.date.timeIntervalSince1970 * 1000)),
    @"uptime_ms": @(LecturnFileChipStatusTime(NSProcessInfo.processInfo.systemUptime * 1000))} mutableCopy];
  if (attempt <= 40) event[@"attempt"] = @(attempt);
  NSArray *keys = @[@"main_thread", @"view_alive", @"textview_alive", @"has_window",
    @"has_report", @"visible", @"app_active", @"scene_active", @"already_started", @"armed",
    @"hosts_present", @"native_error_present", @"success"];
  for (NSString *key in keys) {
    id value = facts[key];
    if ([value isKindOfClass:NSNumber.class] &&
        CFGetTypeID((__bridge CFTypeRef)value) == CFBooleanGetTypeID()) event[key] = value;
  }
  if ([@[@"none", @"no_state", @"ineligible", @"already_started", @"inactive", @"host_lost",
      @"empty_snapshot", @"native_exception", @"serialization_failed", @"write_failed"]
      containsObject:reason]) event[@"reason"] = reason;
  if (error != nil) {
    event[@"error_code"] = @(error.code);
    event[@"error_domain"] = [error.domain isEqual:NSCocoaErrorDomain] ? @"cocoa" :
        [error.domain isEqual:NSPOSIXErrorDomain] ? @"posix" : @"other";
  }
  return event;
}

static NSDictionary *LecturnFileChipStatusRoot(void)
{
  return @{@"schema": @1, @"diagnostic_only": @YES,
    @"pid": @(NSProcessInfo.processInfo.processIdentifier),
    @"source_tree": @"7aac649707d0b2043c0cc7c7444c411abed8f4c0",
    @"source_blob": @"25afaf4c62e3ec43ce92828eb9becab9f3e17163",
    @"source_sha256": @"dc7b26af086141f70f9ace39814420d34e4f6b58673c9a7103225f76b0135403",
    @"observed_unix_ms": @(LecturnFileChipStatusTime(NSDate.date.timeIntervalSince1970 * 1000)),
    @"observed_uptime_ms": @(LecturnFileChipStatusTime(NSProcessInfo.processInfo.systemUptime * 1000)),
    @"events": [LecturnFileChipStatusEvents copy] ?: @[]};
}

// Caller holds the journal lock. Failure never recursively journals or logs error text.
static BOOL LecturnFileChipStatusPersist(NSDictionary *root, NSString *path)
{
  @try {
    NSError *error = nil;
    NSData *data = [NSJSONSerialization dataWithJSONObject:root options:0 error:&error];
    if (data != nil && [data writeToFile:path options:NSDataWritingAtomic error:&error]) return YES;
  } @catch (id exception) {
    (void)exception;
  }
  NSLog(@"Lecturn filechip diagnostic status unavailable");
  return NO;
}

static void LecturnFileChipStatusRecord(
    NSString *stage, NSUInteger attempt, NSDictionary *facts, NSString *reason, NSError *error)
{
  NSDictionary *event = LecturnFileChipStatusEvent(stage, attempt, facts, reason, error);
  if (event == nil) return;
  @synchronized (NSProcessInfo.processInfo) {
    if (LecturnFileChipStatusEvents == nil) LecturnFileChipStatusEvents = [NSMutableArray array];
    [LecturnFileChipStatusEvents addObject:event];
    if (LecturnFileChipStatusEvents.count > 128) {
      // Preserve initialization, bounded start decisions, all sample/ snapshot facts.
      // Evict the oldest intermediate output result; newest terminal results remain.
      NSUInteger victim = [LecturnFileChipStatusEvents indexOfObjectPassingTest:
          ^BOOL(NSDictionary *candidate, NSUInteger index, BOOL *stop) {
        (void)index; (void)stop;
        return [@[@"serialize", @"write"] containsObject:candidate[@"stage"]];
      }];
      [LecturnFileChipStatusEvents removeObjectAtIndex:victim == NSNotFound ? 0 : victim];
    }
    LecturnFileChipStatusPersist(LecturnFileChipStatusRoot(), [NSTemporaryDirectory()
        stringByAppendingPathComponent:@"lecturn-filechip-native-status.json"]);
  }
}

static NSDictionary *LecturnFileChipStatusFacts(UIView *view, UITextView *textView)
{
  const NSUInteger length = textView.attributedText.length;
  return @{@"main_thread": @(NSThread.isMainThread), @"view_alive": @(view != nil),
    @"textview_alive": @(textView != nil), @"has_window": @(view.window != nil),
    @"has_report": @(length > 0 && length <= 4096 &&
        [textView.attributedText.string rangeOfString:@"report.pdf"].location != NSNotFound),
    @"visible": @(LecturnFileChipDiagnosticVisible(view, textView)),
    @"app_active": @(UIApplication.sharedApplication.applicationState == UIApplicationStateActive),
    @"scene_active": @(view.window.windowScene.activationState == UISceneActivationStateForegroundActive)};
}

static void LecturnFileChipStatusStartDecision(NSDictionary *facts, NSString *reason, BOOL armed)
{
  // Six distinct rejected decisions, one armed decision, one already-started decision.
  // Budget <=8 regardless of irrelevant draw count, leaving sample/terminal room.
  @synchronized (NSProcessInfo.processInfo) {
    static NSUInteger rejected = 0;
    static BOOL armedRecorded = NO, alreadyRecorded = NO;
    static NSDictionary *lastRejected;
    NSMutableDictionary *decision = [facts mutableCopy];
    decision[@"armed"] = @(armed);
    if (![reason isEqual:@"no_state"]) decision[@"already_started"] = @([reason isEqual:@"already_started"]);
    decision[@"reason"] = reason;
    if (armed) {
      if (armedRecorded) return;
      armedRecorded = YES;
    } else if ([reason isEqual:@"already_started"]) {
      if (alreadyRecorded) return;
      alreadyRecorded = YES;
    } else {
      if (rejected >= 6 || [lastRejected isEqual:decision]) return;
      rejected++;
      lastRejected = [decision copy];
    }
    LecturnFileChipStatusRecord(@"start_decision", 0, decision, reason, nil);
  }
}

static void LecturnFileChipStatusDraw(UIView *view, UITextView *textView, BOOL hasState)
{
  @synchronized (NSProcessInfo.processInfo) {
    static BOOL firstDraw = YES;
    if (firstDraw) {
      firstDraw = NO;
      LecturnFileChipStatusRecord(@"initialized", 0, LecturnFileChipStatusFacts(view, textView),
          hasState ? @"none" : @"no_state", nil);
    }
  }
  if (!hasState) LecturnFileChipStatusStartDecision(
      LecturnFileChipStatusFacts(view, textView), @"no_state", NO);
}

static void LecturnFileChipStatusSnapshot(NSDictionary *out, NSUInteger attempt)
{
  const BOOL hosts = [out[@"hosts"] count] > 0, error = out[@"native_error"] != nil;
  LecturnFileChipStatusRecord(@"snapshot", attempt,
      @{@"hosts_present": @(hosts), @"native_error_present": @(error)},
      error ? @"native_exception" : hosts ? @"none" : @"empty_snapshot", nil);
}

static void LecturnFileChipDiagnosticWrite(NSDictionary *out, NSUInteger attempt, NSString *path)
{
  NSError *error = nil;
  NSData *data = nil;
  @try {
    data = [NSJSONSerialization dataWithJSONObject:out options:0 error:&error];
  } @catch (id exception) {
    (void)exception;
  }
  LecturnFileChipStatusRecord(@"serialize", attempt, @{@"success": @(data != nil)},
      data ? @"none" : @"serialization_failed", error);
  if (data == nil) return;
  error = nil;
  BOOL success = NO;
  @try {
    success = [data writeToFile:path options:NSDataWritingAtomic error:&error];
  } @catch (id exception) {
    (void)exception;
  }
  LecturnFileChipStatusRecord(@"write", attempt, @{@"success": @(success)},
      success ? @"none" : @"write_failed", error);
}

static void LecturnFileChipDiagnosticSample(
    UIView *view, UITextView *textView, NSUInteger attempt,
    NSUInteger reportSamples, NSTimeInterval startedAt)
{
  @autoreleasepool {
    NSDictionary *facts = LecturnFileChipStatusFacts(view, textView);
    NSString *reason = view == nil || textView == nil ? @"host_lost" :
        ![facts[@"app_active"] boolValue] || ![facts[@"scene_active"] boolValue] ? @"inactive" :
        ![facts[@"visible"] boolValue] ? @"ineligible" : @"none";
    LecturnFileChipStatusRecord(@"sample", attempt, facts, reason, nil);
    if (UIApplication.sharedApplication.applicationState == UIApplicationStateActive) {
      NSMutableDictionary *out = LecturnFileChipDiagnosticSnapshot(view, textView);
      LecturnFileChipStatusSnapshot(out, attempt);
      if ([out[@"hosts"] count] > 0) {
        reportSamples++;
        out[@"diagnostic_only"] = @YES;
        out[@"source_tree"] = @"7aac649707d0b2043c0cc7c7444c411abed8f4c0";
        out[@"source_blob"] = @"25afaf4c62e3ec43ce92828eb9becab9f3e17163";
        out[@"source_sha256"] = @"dc7b26af086141f70f9ace39814420d34e4f6b58673c9a7103225f76b0135403";
        out[@"pid"] = @(NSProcessInfo.processInfo.processIdentifier);
        out[@"sample_attempt"] = @(attempt);
        out[@"report_sample_count"] = @(reportSamples);
        out[@"sample_limit"] = @40;
        out[@"sample_interval_ms"] = @250;
        out[@"sampling_started_uptime_ms"] = @(startedAt * 1000);
        out[@"observed_uptime_ms"] = @(NSProcessInfo.processInfo.systemUptime * 1000);
        out[@"observed_unix_ms"] = @(NSDate.date.timeIntervalSince1970 * 1000);
        LecturnFileChipDiagnosticWrite(out, attempt, [NSTemporaryDirectory()
            stringByAppendingPathComponent:@"lecturn-filechip-native-diagnostic.json"]);
      }
    }
    if (attempt < 40 && view != nil && textView != nil) {
      __weak UIView *weakView = view;
      __weak UITextView *weakTextView = textView;
      dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 250 * NSEC_PER_MSEC),
                     dispatch_get_main_queue(), ^{
        LecturnFileChipDiagnosticSample(weakView, weakTextView, attempt + 1, reportSamples, startedAt);
      });
    }
  }
}

// Main-queue lifecycle: one deferred chain per process, including terminal failure.
typedef NS_ENUM(NSUInteger, LecturnFileChipDiagnosticState) {
  LecturnFileChipDiagnosticIdle,
  LecturnFileChipDiagnosticDeferred,
  LecturnFileChipDiagnosticStarted,
  LecturnFileChipDiagnosticTerminal,
};
static LecturnFileChipDiagnosticState LecturnFileChipDiagnosticLifecycle;

static void LecturnFileChipDiagnosticArm(UIView *view, UITextView *textView)
{
  LecturnFileChipDiagnosticLifecycle = LecturnFileChipDiagnosticStarted;
  const NSTimeInterval startedAt = NSProcessInfo.processInfo.systemUptime;
  __weak UIView *weakView = view;
  __weak UITextView *weakTextView = textView;
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 250 * NSEC_PER_MSEC),
                 dispatch_get_main_queue(), ^{
    LecturnFileChipDiagnosticSample(weakView, weakTextView, 1, 0, startedAt);
  });
  LecturnFileChipStatusStartDecision(LecturnFileChipStatusFacts(view, textView), @"none", YES);
}

static void LecturnFileChipDiagnosticEligibility(
    UIView *view, UITextView *textView, NSUInteger attempt)
{
  if (LecturnFileChipDiagnosticLifecycle != LecturnFileChipDiagnosticDeferred) return;
  if (view != nil && textView != nil && LecturnFileChipDiagnosticVisible(view, textView)) {
    LecturnFileChipDiagnosticArm(view, textView);
    return;
  }
  if (view == nil || textView == nil || attempt == 40) {
    LecturnFileChipDiagnosticLifecycle = LecturnFileChipDiagnosticTerminal;
    NSMutableDictionary *facts = [LecturnFileChipStatusFacts(view, textView) mutableCopy];
    facts[@"armed"] = @NO;
    facts[@"already_started"] = @NO;
    // Bypass rejected-decision deduplication so the bounded terminal is retained.
    LecturnFileChipStatusRecord(@"start_decision", attempt, facts,
        view == nil || textView == nil ? @"host_lost" : @"ineligible", nil);
    return;
  }
  __weak UIView *weakView = view;
  __weak UITextView *weakTextView = textView;
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 250 * NSEC_PER_MSEC),
                 dispatch_get_main_queue(), ^{
    LecturnFileChipDiagnosticEligibility(weakView, weakTextView, attempt + 1);
  });
}

static void LecturnFileChipDiagnosticStart(UIView *view, UITextView *textView)
{
  NSDictionary *facts = LecturnFileChipStatusFacts(view, textView);
  if (![facts[@"main_thread"] boolValue]) {
    LecturnFileChipStatusStartDecision(facts, @"ineligible", NO);
    return;
  }
  if (LecturnFileChipDiagnosticLifecycle == LecturnFileChipDiagnosticStarted) {
    LecturnFileChipStatusStartDecision(facts, @"already_started", NO);
    return;
  }
  if (LecturnFileChipDiagnosticLifecycle != LecturnFileChipDiagnosticIdle) return;
  if (LecturnFileChipDiagnosticVisible(view, textView)) {
    LecturnFileChipDiagnosticArm(view, textView);
    return;
  }
  LecturnFileChipStatusStartDecision(facts, @"ineligible", NO);
  // Only a natural report-bearing draw can claim the single bounded chain.
  if (view == nil || textView == nil || ![facts[@"has_report"] boolValue]) return;
  LecturnFileChipDiagnosticLifecycle = LecturnFileChipDiagnosticDeferred;
  __weak UIView *weakView = view;
  __weak UITextView *weakTextView = textView;
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 250 * NSEC_PER_MSEC),
                 dispatch_get_main_queue(), ^{
    LecturnFileChipDiagnosticEligibility(weakView, weakTextView, 1);
  });
}

@protocol LecturnMarkdownOutsideTapTarget <NSObject>
- (void)clearSelectionForOutsideTapWithHitView:(UIView *)hitView;
@end

@interface LecturnMarkdownOutsideTapCoordinator : NSObject <UIGestureRecognizerDelegate>

- (instancetype)initWithWindow:(UIWindow *)window;
- (void)addTarget:(id<LecturnMarkdownOutsideTapTarget>)target;
- (void)removeTarget:(id<LecturnMarkdownOutsideTapTarget>)target;

@end

static const void *LecturnMarkdownOutsideTapCoordinatorKey =
    &LecturnMarkdownOutsideTapCoordinatorKey;

@implementation LecturnMarkdownOutsideTapCoordinator {
  __weak UIWindow *_window;
  UITapGestureRecognizer *_recognizer;
  NSHashTable<id<LecturnMarkdownOutsideTapTarget>> *_targets;
}

- (instancetype)initWithWindow:(UIWindow *)window
{
  if (self = [super init]) {
    _window = window;
    _targets = [NSHashTable weakObjectsHashTable];
    _recognizer = [[UITapGestureRecognizer alloc] initWithTarget:self
                                                          action:@selector(handleTap:)];
    _recognizer.cancelsTouchesInView = NO;
    _recognizer.delegate = self;
    [window addGestureRecognizer:_recognizer];
  }
  return self;
}

- (void)addTarget:(id<LecturnMarkdownOutsideTapTarget>)target
{
  [_targets addObject:target];
}

- (void)removeTarget:(id<LecturnMarkdownOutsideTapTarget>)target
{
  [_targets removeObject:target];
  if (_targets.count > 0) {
    return;
  }

  UIWindow *window = _window;
  [window removeGestureRecognizer:_recognizer];
  if (objc_getAssociatedObject(window, LecturnMarkdownOutsideTapCoordinatorKey) == self) {
    objc_setAssociatedObject(
        window,
        LecturnMarkdownOutsideTapCoordinatorKey,
        nil,
        OBJC_ASSOCIATION_RETAIN_NONATOMIC);
  }
}

- (void)handleTap:(UITapGestureRecognizer *)sender
{
  UIWindow *window = _window;
  if (window == nil) {
    return;
  }

  UIView *hitView = [window hitTest:[sender locationInView:window] withEvent:nil];
  if (hitView == nil) {
    return;
  }
  for (id<LecturnMarkdownOutsideTapTarget> target in _targets.allObjects) {
    [target clearSelectionForOutsideTapWithHitView:hitView];
  }
}

- (BOOL)gestureRecognizer:(UIGestureRecognizer *)gestureRecognizer
    shouldRecognizeSimultaneouslyWithGestureRecognizer:(UIGestureRecognizer *)otherGestureRecognizer
{
  return YES;
}

@end

static LecturnMarkdownOutsideTapCoordinator *
LecturnMarkdownOutsideTapCoordinatorForWindow(UIWindow *window)
{
  LecturnMarkdownOutsideTapCoordinator *coordinator =
      objc_getAssociatedObject(window, LecturnMarkdownOutsideTapCoordinatorKey);
  if (coordinator == nil) {
    coordinator = [[LecturnMarkdownOutsideTapCoordinator alloc] initWithWindow:window];
    objc_setAssociatedObject(
        window,
        LecturnMarkdownOutsideTapCoordinatorKey,
        coordinator,
        OBJC_ASSOCIATION_RETAIN_NONATOMIC);
  }
  return coordinator;
}

@interface LecturnMarkdownText () <RCTLecturnMarkdownTextViewProtocol, UIGestureRecognizerDelegate, UITextViewDelegate>

@end

@interface LecturnMarkdownText () <LecturnMarkdownOutsideTapTarget>
@end

@implementation LecturnMarkdownText {
  UIView * _view;
  UITextView * _textView;
  LecturnMarkdownTextShadowNode::ConcreteState::Shared _state;
  __weak UIWindow * _outsideTapWindow;
  BOOL _suppressSelectionChange;
  NSMutableDictionary<NSString *, UIImage *> * _attachmentImages;
  NSMutableSet<NSString *> * _pendingAttachmentUris;
  UILongPressGestureRecognizer *_longPressGestureRecognizer;
  UITapGestureRecognizer *_pressGestureRecognizer;
}

+ (ComponentDescriptorProvider)componentDescriptorProvider
{
  return concreteComponentDescriptorProvider<LecturnMarkdownTextComponentDescriptor>();
}

- (instancetype)initWithFrame:(CGRect)frame
{
  if (self = [super initWithFrame:frame]) {
    static const auto defaultProps = std::make_shared<const LecturnMarkdownTextProps>();
    _props = defaultProps;

    _view = [[UIView alloc] init];
    self.contentView = _view;
    self.clipsToBounds = true;

    _textView = [[UITextView alloc] init];
    _attachmentImages = [[NSMutableDictionary alloc] init];
    _pendingAttachmentUris = [[NSMutableSet alloc] init];
    _textView.scrollEnabled = false;
    _textView.editable = false;
    _textView.textContainerInset = UIEdgeInsetsZero;
    _textView.textContainer.lineFragmentPadding = 0;
    _textView.delegate = self;
    // Chat text supports selection and contextual actions, but not drag-and-drop.
    _textView.textDragInteraction.enabled = NO;
    _textView.linkTextAttributes = @{};
    // Must match RCTTextLayoutManager, which measures with usesFontLeading = NO.
    _textView.layoutManager.usesFontLeading = NO;
    [self addSubview:_textView];

    _longPressGestureRecognizer = [[UILongPressGestureRecognizer alloc] initWithTarget:self
                                                                                 action:@selector(handleLongPressIfNecessary:)];
    _longPressGestureRecognizer.delegate = self;

    _pressGestureRecognizer = [[UITapGestureRecognizer alloc] initWithTarget:self
                                                                       action:@selector(handlePressIfNecessary:)];
    _pressGestureRecognizer.delegate = self;
    [_pressGestureRecognizer requireGestureRecognizerToFail:_longPressGestureRecognizer];

    [_textView addGestureRecognizer:_pressGestureRecognizer];
    [_textView addGestureRecognizer:_longPressGestureRecognizer];
  }

  return self;
}

- (void)didMoveToWindow
{
  [super didMoveToWindow];
  if (_outsideTapWindow == self.window) {
    return;
  }
  if (_outsideTapWindow != nil) {
    LecturnMarkdownOutsideTapCoordinator *coordinator =
        objc_getAssociatedObject(_outsideTapWindow, LecturnMarkdownOutsideTapCoordinatorKey);
    [coordinator removeTarget:self];
  }
  _outsideTapWindow = self.window;
  if (_outsideTapWindow != nil) {
    [LecturnMarkdownOutsideTapCoordinatorForWindow(_outsideTapWindow) addTarget:self];
  }
}

- (void)dealloc
{
  LecturnMarkdownOutsideTapCoordinator *coordinator =
      objc_getAssociatedObject(_outsideTapWindow, LecturnMarkdownOutsideTapCoordinatorKey);
  [coordinator removeTarget:self];
}

// See RCTParagraphComponentView
- (void)prepareForRecycle
{
  [super prepareForRecycle];
  LecturnMarkdownOutsideTapCoordinator *coordinator =
      objc_getAssociatedObject(_outsideTapWindow, LecturnMarkdownOutsideTapCoordinatorKey);
  [coordinator removeTarget:self];
  _outsideTapWindow = nil;
  _state.reset();

  // Reset the frame to zero so that when it properly lays out on the next use
  _textView.frame = CGRectZero;
  _textView.attributedText = nil;
}

- (void)layoutSubviews
{
  [super layoutSubviews];
  // _textView's frame is assigned inside drawRect, which only fires when
  // state changes. Trigger a redraw whenever the host frame moves out from
  // under it (rotation, parent relayout) so the text view resizes and
  // onTextLayout re-fires with the new line wrapping.
  if (!CGRectEqualToRect(_textView.frame, _view.frame)) {
    [self setNeedsDisplay];
  }
}

- (void)drawRect:(CGRect)rect
{
  LecturnFileChipStatusDraw(self, _textView, _state != nullptr);
  if (!_state) {
    return;
  }

  const auto &props = *std::static_pointer_cast<LecturnMarkdownTextProps const>(_props);

  const auto attrString = _state->getData().attributedString;
  NSMutableAttributedString *convertedAttrString =
      [RCTNSAttributedStringFromAttributedString(attrString) mutableCopy];
  LecturnMarkdownTextApplyParagraphStyles(
      convertedAttrString,
      _state->getData().paragraphStyleRanges);
  LecturnMarkdownTextApplyAttachments(
      convertedAttrString,
      _state->getData().attachmentRanges,
      _attachmentImages);
  NSUInteger runLocation = 0;
  for (UIView *child in self.subviews) {
    if (![child isKindOfClass:[LecturnMarkdownTextRun class]]) {
      continue;
    }

    LecturnMarkdownTextRun *textChild = (LecturnMarkdownTextRun *)child;
    const NSRange runRange = NSMakeRange(runLocation, textChild.text.length);
    runLocation = NSMaxRange(runRange);
    if (![textChild hasContextMenu] || runRange.length == 0 ||
        NSMaxRange(runRange) > convertedAttrString.length) {
      continue;
    }

    NSURL *link = [NSURL URLWithString:
        [NSString stringWithFormat:@"lecturn-markdown-run://%ld", (long)textChild.tag]];
    if (link != nil) {
      [convertedAttrString addAttribute:NSLinkAttributeName value:link range:runRange];
    }
  }
  [self loadAttachmentImages:_state->getData().attachmentRanges];

  // Setting attributedText clears any active text selection, and re-assigning
  // the frame triggers a layout flush that has the same effect. Bail out
  // entirely when nothing actually changed so a JS-side state update made in
  // response to onSelectionChange doesn't deselect what the user is selecting.
  const BOOL textChanged = ![_textView.attributedText isEqualToAttributedString:convertedAttrString];
  const BOOL frameChanged = !CGRectEqualToRect(_textView.frame, _view.frame);
  if (!textChanged && !frameChanged) {
    LecturnFileChipDiagnosticStart(self, _textView);
    return;
  }
  if (textChanged) {
    // Reassigning attributedText clears any active selection. Save it and
    // restore after, while suppressing the synthetic textViewDidChangeSelection
    // events the clear-then-restore would otherwise produce — those would
    // round-trip to JS and re-trigger this same path, causing a loop.
    const NSRange savedRange = _textView.selectedRange;
    _suppressSelectionChange = YES;
    _textView.attributedText = convertedAttrString;
    if (savedRange.length > 0 && NSMaxRange(savedRange) <= _textView.attributedText.length) {
      _textView.selectedRange = savedRange;
    }
    _suppressSelectionChange = NO;
  }
  if (frameChanged) {
    _textView.frame = _view.frame;
  }

  __block std::vector<std::string> lines;
  const int maxLines = props.numberOfLines;
  [_textView.layoutManager enumerateLineFragmentsForGlyphRange:NSMakeRange(0, convertedAttrString.string.length) usingBlock:^(CGRect rect,
                                                                                              CGRect usedRect,
                                                                                              NSTextContainer * _Nonnull textContainer,
                                                                                              NSRange glyphRange,
                                                                                              BOOL * _Nonnull stop) {
    const auto charRange = [self->_textView.layoutManager characterRangeForGlyphRange:glyphRange actualGlyphRange:nil];
    const auto line = [self->_textView.text substringWithRange:charRange];
    lines.push_back(line.UTF8String);
    // enumerateLineFragments overshoots maximumNumberOfLines by one on iOS
    // 18, so cap explicitly.
    if (maxLines > 0 && lines.size() >= (size_t)maxLines) {
      *stop = YES;
    }
  }];

  if (_eventEmitter != nullptr) {
    std::dynamic_pointer_cast<const facebook::react::LecturnMarkdownTextEventEmitter>(_eventEmitter)
    ->onTextLayout(facebook::react::LecturnMarkdownTextEventEmitter::OnTextLayout{static_cast<int>(self.tag), lines});
  };
  LecturnFileChipDiagnosticStart(self, _textView);
}

- (void)loadAttachmentImages:(const std::vector<LecturnMarkdownTextAttachmentRange> &)attachmentRanges
{
  for (const auto &attachmentRange : attachmentRanges) {
    NSString *imageUri = [NSString stringWithUTF8String:attachmentRange.imageUri.c_str()];
    if ([imageUri hasPrefix:@"sf:"]) {
      continue;
    }
    if (_attachmentImages[imageUri] != nil || [_pendingAttachmentUris containsObject:imageUri]) {
      continue;
    }

    NSURL *url = [NSURL URLWithString:imageUri];
    if (url == nil) {
      continue;
    }
    if (url.isFileURL) {
      UIImage *image = [UIImage imageWithContentsOfFile:url.path];
      if (image != nil) {
        _attachmentImages[imageUri] = image;
        dispatch_async(dispatch_get_main_queue(), ^{
          [self refreshDisplayedAttachments];
        });
      }
      continue;
    }

    [_pendingAttachmentUris addObject:imageUri];
    [[[NSURLSession sharedSession] dataTaskWithURL:url
                                completionHandler:^(NSData *data, NSURLResponse *response, NSError *error) {
      UIImage *image = data == nil ? nil : [UIImage imageWithData:data];
      dispatch_async(dispatch_get_main_queue(), ^{
        [self->_pendingAttachmentUris removeObject:imageUri];
        if (image != nil) {
          self->_attachmentImages[imageUri] = image;
          [self refreshDisplayedAttachments];
        }
      });
    }] resume];
  }
}

- (void)refreshDisplayedAttachments
{
  if (!_state || _textView.attributedText == nil) {
    return;
  }

  NSMutableAttributedString *attributedText = [_textView.attributedText mutableCopy];
  LecturnMarkdownTextApplyAttachments(
      attributedText,
      _state->getData().attachmentRanges,
      _attachmentImages);

  const NSRange savedRange = _textView.selectedRange;
  _suppressSelectionChange = YES;
  _textView.attributedText = attributedText;
  if (savedRange.location != NSNotFound &&
      NSMaxRange(savedRange) <= _textView.attributedText.length) {
    _textView.selectedRange = savedRange;
  }
  _suppressSelectionChange = NO;
  [_textView setNeedsDisplay];
}

- (void)updateProps:(Props::Shared const &)props oldProps:(Props::Shared const &)oldProps
{
  const auto &oldViewProps = *std::static_pointer_cast<LecturnMarkdownTextProps const>(_props);
  const auto &newViewProps = *std::static_pointer_cast<LecturnMarkdownTextProps const>(props);

  if (oldViewProps.numberOfLines != newViewProps.numberOfLines) {
    _textView.textContainer.maximumNumberOfLines = newViewProps.numberOfLines;
  }

  if (oldViewProps.selectable != newViewProps.selectable) {
    _textView.selectable = newViewProps.selectable;
  }

  if (oldViewProps.allowFontScaling != newViewProps.allowFontScaling) {
    if (@available(iOS 11.0, *)) {
      _textView.adjustsFontForContentSizeCategory = newViewProps.allowFontScaling;
    }
  }

  if (oldViewProps.ellipsizeMode != newViewProps.ellipsizeMode) {
    if (newViewProps.ellipsizeMode == LecturnMarkdownTextEllipsizeMode::Head) {
      _textView.textContainer.lineBreakMode = NSLineBreakMode::NSLineBreakByTruncatingHead;
    } else if (newViewProps.ellipsizeMode == LecturnMarkdownTextEllipsizeMode::Middle) {
      _textView.textContainer.lineBreakMode = NSLineBreakMode::NSLineBreakByTruncatingMiddle;
    } else if (newViewProps.ellipsizeMode == LecturnMarkdownTextEllipsizeMode::Tail) {
      _textView.textContainer.lineBreakMode = NSLineBreakMode::NSLineBreakByTruncatingTail;
    } else if (newViewProps.ellipsizeMode == LecturnMarkdownTextEllipsizeMode::Clip) {
      _textView.textContainer.lineBreakMode = NSLineBreakMode::NSLineBreakByClipping;
    }
  }


  // I'm not sure if this is really the right way to handle this style. This means that the entire _view_ the text
  // is in will have this background color applied. To apply it just to a particular part of a string, you'd need
  // to do <Text><Text style={{backgroundColor: 'blue'}}>Hello</Text></Text>.
  // This is how the base <Text> component works though, so we'll go with it for now. Can change later if we want.
  if (oldViewProps.backgroundColor != newViewProps.backgroundColor) {
    _textView.backgroundColor = RCTUIColorFromSharedColor(newViewProps.backgroundColor);
  }

  [super updateProps:props oldProps:oldProps];
}

// See RCTParagraphComponentView
- (void)updateState:(const facebook::react::State::Shared &)state oldState:(const facebook::react::State::Shared &)oldState
{
  _state = std::static_pointer_cast<const LecturnMarkdownTextShadowNode::ConcreteState>(state);
  [self setNeedsDisplay];
}

// MARK: - UIGestureRecognizerDelegate

- (BOOL)gestureRecognizer:(UIGestureRecognizer *)gestureRecognizer shouldRecognizeSimultaneouslyWithGestureRecognizer:(UIGestureRecognizer *)otherGestureRecognizer
{
  return YES;
}

- (BOOL)gestureRecognizerShouldBegin:(UIGestureRecognizer *)gestureRecognizer
{
  if (gestureRecognizer != _longPressGestureRecognizer &&
      gestureRecognizer != _pressGestureRecognizer) {
    return YES;
  }

  const auto location = [self getLocationOfPress:gestureRecognizer];
  const auto child = [self getTouchChild:location];
  return ![child hasContextMenu];
}

- (BOOL)gestureRecognizer:(UIGestureRecognizer *)gestureRecognizer shouldReceiveTouch:(UITouch *)touch
{
  return YES;
}

- (void)clearSelectionForOutsideTapWithHitView:(UIView *)hitView
{
  if ([hitView isDescendantOfView:self]) {
    return;
  }
  // Defer past the current event loop turn so any in-flight edit-menu action
  // (Copy / Define / Look Up / …) reads the live selection before we clear it.
  UITextView *textView = _textView;
  dispatch_async(dispatch_get_main_queue(), ^{
    UITextRange *range = textView.selectedTextRange;
    if (range != nil && !range.isEmpty) {
      textView.selectedTextRange = nil;
    }
  });
}

// MARK: - Touch handling

- (nullable LecturnMarkdownTextRun *)childForCharacterRange:(NSRange)characterRange
{
  NSUInteger location = 0;
  for (UIView *child in self.subviews) {
    if (![child isKindOfClass:[LecturnMarkdownTextRun class]]) {
      continue;
    }

    LecturnMarkdownTextRun *textChild = (LecturnMarkdownTextRun *)child;
    const NSRange range = NSMakeRange(location, textChild.text.length);
    if (NSIntersectionRange(range, characterRange).length > 0) {
      return textChild;
    }
    location = NSMaxRange(range);
  }
  return nil;
}

- (CGPoint)getLocationOfPress:(UIGestureRecognizer*)sender
{
  return [sender locationInView:_textView];
}

- (LecturnMarkdownTextRun*)getTouchChild:(CGPoint)location
{
  const auto charIndex = [_textView.layoutManager characterIndexForPoint:location
                                                         inTextContainer:_textView.textContainer
                                fractionOfDistanceBetweenInsertionPoints:nil
  ];

  int currIndex = -1;
  for (UIView* child in self.subviews) {
    if (![child isKindOfClass:[LecturnMarkdownTextRun class]]) {
      continue;
    }

    LecturnMarkdownTextRun* textChild = (LecturnMarkdownTextRun*)child;

    // This is UTF16 code units!!
    currIndex += textChild.text.length;

    if (charIndex <= currIndex) {
      return textChild;
    }
  }

  return nil;
}

- (void)handlePressIfNecessary:(UITapGestureRecognizer*)sender
{
  const auto location = [self getLocationOfPress:sender];
  const auto child = [self getTouchChild:location];

  if (child) {
    [child onPress];
  }
}

- (void)handleLongPressIfNecessary:(UILongPressGestureRecognizer*)sender
{
  if (sender.state != UIGestureRecognizerStateBegan) {
    return;
  }

  const auto location = [self getLocationOfPress:sender];
  const auto child = [self getTouchChild:location];

  if (child) {
    [child onLongPress];
  }
}

// MARK: - UITextViewDelegate

- (nullable UIAction *)textView:(UITextView *)textView
    primaryActionForTextItem:(UITextItem *)textItem
               defaultAction:(UIAction *)defaultAction API_AVAILABLE(ios(17.0))
{
  LecturnMarkdownTextRun *child = [self childForCharacterRange:textItem.range];
  if (![child hasContextMenu]) {
    return defaultAction;
  }

  __weak LecturnMarkdownTextRun *weakChild = child;
  return [UIAction actionWithHandler:^(__kindof UIAction *action) {
    [weakChild onPress];
  }];
}

- (nullable UITextItemMenuConfiguration *)textView:(UITextView *)textView
                      menuConfigurationForTextItem:(UITextItem *)textItem
                                       defaultMenu:(UIMenu *)defaultMenu API_AVAILABLE(ios(17.0))
{
  LecturnMarkdownTextRun *child = [self childForCharacterRange:textItem.range];
  UIMenu *menu = [child contextMenu];
  return [UITextItemMenuConfiguration configurationWithMenu:menu ?: defaultMenu];
}

- (void)textViewDidChangeSelection:(UITextView *)textView
{
  if (_suppressSelectionChange) {
    return;
  }
  if (_eventEmitter == nullptr) {
    return;
  }

  const NSRange selectedRange = textView.selectedRange;
  if (selectedRange.location == NSNotFound) {
    return;
  }

  // Fires on programmatic selection changes too (e.g. the outside-tap clear
  // in handleOutsideTap:), so JS will see a synthetic empty-range event then.
  std::dynamic_pointer_cast<const facebook::react::LecturnMarkdownTextEventEmitter>(_eventEmitter)
    ->onSelectionChange(facebook::react::LecturnMarkdownTextEventEmitter::OnSelectionChange{
      static_cast<int>(self.tag),
      static_cast<int>(selectedRange.location),
      static_cast<int>(selectedRange.location + selectedRange.length),
    });
}

Class<RCTComponentViewProtocol> LecturnMarkdownTextCls(void)
{
  return LecturnMarkdownText.class;
}

@end
