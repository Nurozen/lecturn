/**
 * `html_render` and `html_preview` for Squires. A Squire's page is always
 * locked down (`lockedHtmlRenderDocument`): no local files, no network, no
 * page scripts. Served as Squire role tools, so the mode comes from the home
 * thread's credential, never from an argument, and each call logs
 * `tool.called` like every other Squire tool.
 *
 * @module squire/SquireHtmlTools
 */
import {
  HTML_RENDER_COLUMN_WIDTH,
  HTML_RENDER_LAYOUT_GUIDE,
  HTML_RENDER_MAX_HEIGHT,
  HTML_RENDER_MAX_TITLE_LENGTH,
  HTML_RENDER_MIN_HEIGHT,
  HTML_RENDER_THEME_GUIDE,
  HTML_RENDER_TOOL_NAME,
} from "@lecturn/shared/htmlRender";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { resolveAttachmentRelativePath } from "../attachmentPaths.ts";
import * as ServerConfig from "../config.ts";
import * as HtmlRender from "../htmlRender/HtmlRender.ts";
import {
  SquireToolRegistry,
  type SquireToolContext,
  type SquireToolDefinition,
  type SquireToolHandler,
  type SquireToolKit,
} from "./squireToolKit.ts";

const HTML_PREVIEW_TOOL_NAME = "html_preview";

/** The `html` limit every agent has. */
const MAX_HTML_CHARS = 512_000;

const PAGE_RULES =
  "Your page is locked down: it must be self-contained, with inline <style>, and images as data: URIs or inline SVG. Page scripts do not run, links do not open, local file paths are refused, and nothing loads from the network.";

const RENDERED_MESSAGE =
  "Shown to the reader above your reply. Don't mention or describe the page; reply with only what it doesn't already say.";

const html = {
  type: "string",
  minLength: 1,
  maxLength: MAX_HTML_CHARS,
  description: "A complete, self-contained HTML document.",
};

const RENDER_DEFINITION: SquireToolDefinition = {
  name: HTML_RENDER_TOOL_NAME,
  description: `Show a finished HTML page (chart, table, diagram, mockup) inline in this thread, above your reply; call it before writing that reply, and don't restate the page in it. Check it with html_preview first. ${PAGE_RULES} ${HTML_RENDER_LAYOUT_GUIDE} ${HTML_RENDER_THEME_GUIDE}`,
  inputSchema: {
    type: "object",
    properties: {
      html,
      title: {
        type: "string",
        minLength: 1,
        maxLength: HTML_RENDER_MAX_TITLE_LENGTH,
        description: "Short name for the page.",
      },
      height: {
        type: "integer",
        minimum: HTML_RENDER_MIN_HEIGHT,
        maximum: HTML_RENDER_MAX_HEIGHT,
        description:
          "The frame height in CSS pixels. Use html_preview's contentHeight, or less to make long content scroll inside the frame.",
      },
    },
    required: ["html", "title", "height"],
    additionalProperties: false,
  },
};

const PREVIEW_DEFINITION: SquireToolDefinition = {
  name: HTML_PREVIEW_TOOL_NAME,
  description: `Render an HTML page in Lecturn's headless browser exactly as html_render will show it, and get back a PNG screenshot, contentHeight (the height the page needs at this width), and console output, where blocked scripts and loads are reported. ${PAGE_RULES} The page gets the theme variables and layout described in html_render.`,
  inputSchema: {
    type: "object",
    properties: {
      html,
      width: {
        type: "integer",
        minimum: 240,
        maximum: 1600,
        description: `Viewport width in CSS pixels. Defaults to ${HTML_RENDER_COLUMN_WIDTH}, the reply column; use about 390 to check phones.`,
      },
      appearance: {
        type: "string",
        enum: ["dark", "light"],
        description: "Theme to preview. Defaults to dark.",
      },
    },
    required: ["html"],
    additionalProperties: false,
  },
};

const toJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const Html = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(MAX_HTML_CHARS));

const RenderArgs = Schema.Struct({
  html: Html,
  title: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(HTML_RENDER_MAX_TITLE_LENGTH),
  ),
  height: Schema.Int,
});

const PreviewArgs = Schema.Struct({
  html: Html,
  width: Schema.optionalKey(Schema.Int),
  appearance: Schema.optionalKey(Schema.Literals(["dark", "light"])),
});

const make = Effect.gen(function* () {
  const registry = yield* Effect.serviceOption(SquireToolRegistry);
  if (Option.isNone(registry)) return;
  const htmlRender = yield* HtmlRender.HtmlRender;
  const fileSystem = yield* FileSystem.FileSystem;
  const { attachmentsDir } = yield* ServerConfig.ServerConfig;

  const render = Effect.fn("SquireHtmlTools.render")(function* (
    ctx: SquireToolContext,
    kit: SquireToolKit,
  ) {
    const args = yield* kit.decodeArgs(RenderArgs, ctx.args);
    if (!args.ok) {
      return yield* kit.refuse(ctx, "invalid-arguments", `Invalid arguments: ${args.message}`);
    }
    const published = yield* htmlRender
      .publish({ ...args.value, threadId: ctx.caller.threadId, locked: true })
      .pipe(
        Effect.map((reference) => ({ ok: true as const, reference })),
        Effect.catch((error) => Effect.succeed({ ok: false as const, message: error.message })),
      );
    if (!published.ok) return yield* kit.refuse(ctx, "invalid-page", published.message);
    const output = { htmlRender: published.reference, message: RENDERED_MESSAGE };
    const filePath = resolveAttachmentRelativePath({
      attachmentsDir,
      relativePath: `${published.reference.attachmentId}.html`,
    });
    return yield* kit
      .commit(ctx, null, Effect.succeed({ result: kit.ok(toJson(output), output) }))
      .pipe(
        // Only the committed result names the page, so an unrecorded one is removed.
        Effect.onError(() =>
          filePath === null
            ? Effect.void
            : fileSystem.remove(filePath, { force: true }).pipe(Effect.ignore),
        ),
      );
  });

  // A read: no lock and no stored result, so a screenshot never lands in the log.
  const preview = Effect.fn("SquireHtmlTools.preview")(function* (
    ctx: SquireToolContext,
    kit: SquireToolKit,
  ) {
    const args = yield* kit.decodeArgs(PreviewArgs, ctx.args);
    const outcome = !args.ok
      ? { ok: false as const, message: `Invalid arguments: ${args.message}` }
      : yield* htmlRender.preview({ ...args.value, locked: true }).pipe(
          Effect.map((preview) => ({ ok: true as const, preview })),
          Effect.catch((error) => Effect.succeed({ ok: false as const, message: error.message })),
        );
    if (!outcome.ok) {
      yield* kit.logRow(ctx, "tool.called", { tool: ctx.tool, isError: true });
      return kit.refused("invalid-page", outcome.message);
    }
    const { png, ...result } = outcome.preview;
    yield* kit.logRow(ctx, "tool.called", {
      tool: ctx.tool,
      width: result.width,
      contentHeight: result.contentHeight,
    });
    return { ...kit.ok(toJson(result)), image: { data: png, mimeType: "image/png" } };
  });

  const handlers: ReadonlyArray<SquireToolHandler> = [
    { definition: RENDER_DEFINITION, roles: ["lead", "squire"], call: render },
    { definition: PREVIEW_DEFINITION, roles: ["lead", "squire"], read: true, call: preview },
  ];
  yield* registry.value.register(handlers);
});

export const layer = Layer.effectDiscard(make);
