import { launchVerificationServer, runControlQuati } from "./control-quati.ts";
import { mountPreview, parkUntilSignal, type MountedPreview } from "./testing/preview-fixture.ts";

const fixture = await launchVerificationServer();
let ui: MountedPreview | undefined;
try {
  await runControlQuati(["new-bot", "--name", "VM Preview Test", "--url", fixture.info.url]);
  ui = await mountPreview(fixture, {
    entry: "/scripts/testing/vm-preview.tsx", route: "/__vm-preview.html", title: "Isolated VM Preview Test",
  });
  console.log(JSON.stringify({ ...fixture.info, previewUrl: ui.previewUrl }, null, 2));
  await parkUntilSignal();
} finally {
  await ui?.close();
  await fixture.close();
}
