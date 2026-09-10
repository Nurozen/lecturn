# File previews

On mobile, image, video, and web-file previews show a connection notice when their environment
is offline. Retry the connection from the notice. If the file is missing or unavailable while
the environment is connected, choose **Try again** to request a new preview. Source and Markdown
views remain available independently of media preview loading.

On desktop, a preview annotation remains usable if its screenshot cannot be captured. Lecturn
shows a warning and keeps the annotation without the image, so you can continue composing or
sending. A stalled screenshot capture stops waiting after five seconds. If an element's React
context cannot be read, the annotation retains its DOM description.

Explicit URLs entered in the preview address bar are kept as entered. Links to discovered local
servers still resolve through the environment that runs them.
