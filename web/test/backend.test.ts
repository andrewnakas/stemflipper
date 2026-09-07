import { describe, expect, it } from "vitest";
import { apiRoot, assetUrl, fileUrl, spaceUrl } from "../src/api/backend";

const cfg = { baseUrl: "https://nakas-stemflipper.hf.space" };

describe("backend url helpers", () => {
  it("derives a space host", () => {
    expect(spaceUrl("nakas/stemflipper")).toBe("https://nakas-stemflipper.hf.space");
  });

  it("trims trailing slashes from the api root", () => {
    expect(apiRoot({ baseUrl: "http://127.0.0.1:7860/" })).toBe("http://127.0.0.1:7860/gradio_api");
  });

  it("resolves FileData shapes", () => {
    expect(fileUrl(cfg, "https://x/y.wav")).toBe("https://x/y.wav");
    expect(fileUrl(cfg, { url: "https://x/y.wav" })).toBe("https://x/y.wav");
    expect(fileUrl(cfg, { path: "/tmp/a.zip" })).toBe(
      "https://nakas-stemflipper.hf.space/gradio_api/file=/tmp/a.zip",
    );
    expect(fileUrl(cfg, null)).toBeNull();
  });

  it("builds bundle-relative asset urls", () => {
    expect(assetUrl(cfg, "/tmp/sf/song", "stems/vocals.flac")).toBe(
      "https://nakas-stemflipper.hf.space/gradio_api/file=/tmp/sf/song/stems/vocals.flac",
    );
    // tolerant of a trailing slash on the root and a leading slash on the asset
    expect(assetUrl(cfg, "/tmp/sf/song/", "/stems/vocals.flac")).toBe(
      "https://nakas-stemflipper.hf.space/gradio_api/file=/tmp/sf/song/stems/vocals.flac",
    );
  });
});
