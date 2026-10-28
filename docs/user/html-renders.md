# Visual replies

Agents can answer with a page instead of only text: a chart, table, diagram, image collage, or mockup. Ask for one ("show this as a chart", "make a collage of these screenshots") and the agent builds a self-contained HTML page, which appears in the thread above its written reply. It works with every provider, on web, desktop, and mobile.

Pages use your current theme, including custom themes, and follow light and dark mode as you switch. Scripts run inside the page, but it is sandboxed away from Lecturn and your session. Links you click in a page open in your browser. Use the expand button to open a page full screen. On web and desktop, use the zoom controls to see more detail.

Agents can place local images in a page by file path. Lecturn embeds them when the page is published, so the page keeps working after the original files move or are deleted. Deleting the thread deletes its pages.

Before publishing, agents check their work with screenshots from a small headless browser that Lecturn keeps for itself; it never uses a browser you installed. The first preview on a machine downloads it once (about 120 MB) into Lecturn's data folder, so that preview can take a minute. Browser tabs on a remote environment use the same browser, so whichever comes first downloads it. Some Linux hosts need [setup](remote-access.md#browser-host-setup) before it can start. Pages publish without it.

## MCP apps

Some MCP servers return an interactive app with their tool results, following the [MCP Apps](https://github.com/modelcontextprotocol/ext-apps) standard. When an agent calls one of those tools, the app appears in the thread in place of the tool call, on web, desktop, and mobile. Codex supports this today, for any MCP server you have configured for it; other providers show these calls as ordinary tool calls. Cards from connected apps show on every provider.

Apps follow your theme. An app can call tools on its own server and post a message to the thread; Lecturn asks first unless the server marks the tool as read-only, and it asks before every message. On mobile, an app also asks before opening a link, and Lecturn asks before saving a file an app offers. An app stays viewable after its agent stops, but using it needs the agent of the thread that created it running, so send a message in that thread first if the app says it is unavailable. A connected app's card talks to the app itself instead, so it keeps working in stopped and copied threads while the app is connected; an action that needs approval asks in the thread, like the agent's own calls, and so needs a running turn. An app that navigates away from its own page is stopped.

An app can open full screen; use the button in its top corner, or press Escape outside the app, to return it to the thread. Anything else that needs your attention, such as an approval, also returns it to the thread. On mobile, full screen opens the app again in its own screen, so anything the app does not save itself starts over. An app can also keep the agent informed of what you did in it, such as a filter you picked; Lecturn sends the latest note from each app with your next message.
