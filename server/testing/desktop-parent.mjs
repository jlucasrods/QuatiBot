// The desktop app's private parent port for the launcher's desktop mode (QUATI_TEST_DESKTOP_OWNER_TOKEN, with
// QUATI_DESKTOP_PARENT=1): the server runs as Electron's utility process, and only the test's owner capability crosses.
const token = process.env.QUATI_TEST_DESKTOP_OWNER_TOKEN;
delete process.env.QUATI_TEST_DESKTOP_OWNER_TOKEN;
if (token) {
  Object.defineProperty(process, "parentPort", {
    value: {
      on(event, listener) {
        if (event === "message") queueMicrotask(() => listener({ data: { type: "quatibot:desktop-mutation-token", token } }));
      },
      postMessage() {},
    },
  });
}
