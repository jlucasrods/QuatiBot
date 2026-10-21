import { afterEach, expect, it, vi } from "vitest";
import { mountPreview } from "./preview-fixture.ts";

const { createServer } = vi.hoisted(() => ({ createServer: vi.fn() }));
vi.mock("vite", () => ({ createServer }));
afterEach(() => vi.clearAllMocks());

it("serves an isolated preview without file watchers and closes it on teardown", async () => {
  const vite = await vi.importActual<typeof import("vite")>("vite");
  createServer.mockImplementation(vite.createServer);

  const preview = await mountPreview({ info: { url: "http://127.0.0.1:5678" } }, {
    entry: "/scripts/testing/threads-preview.tsx", route: "/fixture.html", title: "Fixture", logLevel: "silent",
  });
  const server = await createServer.mock.results[0]!.value;
  const close = vi.spyOn(server, "close");

  try {
    expect(server.config.server.watch).toBeNull();
    expect(server.watcher.getWatched()).toEqual({});
    const page = await fetch(preview.previewUrl);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("/scripts/testing/threads-preview.tsx");
  } finally {
    await preview.close();
  }
  expect(close).toHaveBeenCalledOnce();
});

it("closes the preview if listening fails", async () => {
  const close = vi.fn();
  createServer.mockResolvedValue({ listen: vi.fn().mockRejectedValue(new Error("listen failed")), close });

  await expect(mountPreview({ info: { url: "http://127.0.0.1:5678" } }, {
    entry: "/fixture.tsx", route: "/fixture.html", title: "Fixture",
  })).rejects.toThrow("listen failed");
  expect(close).toHaveBeenCalledOnce();
});
