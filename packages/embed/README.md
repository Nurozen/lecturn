# @lecturn/embed

Embed Lecturn's chat in your app and expose your app's tools to it.

## Host lifetime

`connect()` may start a private Lecturn server for your app (the sidecar) in `sidecar.baseDir`. The sidecar never outlives the process that started it:

- Pass your app's lifetime as `signal`. Aborting it while `connect()` is still starting the sidecar stops that process, and `connect()` rejects with the signal's reason only once the process has exited. Aborting it later closes the connection.
- The promise `connect()` returns also has `close()`, which works before it settles. Before ready, it stops a starting sidecar and resolves once the process has exited; after ready, it is the connection's `close()`.
- If your process exits without closing, crashes included, the sidecar notices and shuts itself down: it watches a pipe that only your process holds, and its parent process.

```ts
const quitting = new AbortController();
app.on("before-quit", () => quitting.abort());
const connection = await connect({ registration, sidecar, signal: quitting.signal });
```

A sidecar that another process of your app already runs in the same `baseDir` is attached to, not started, and is left running when this process closes.
