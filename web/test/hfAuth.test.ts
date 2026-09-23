import { describe, expect, it } from "vitest";
import { authorizeUrl, challengeFor } from "../src/api/hfAuth";

describe("PKCE", () => {
  it("produces the challenge from RFC 7636's own test vector", async () => {
    // If this is wrong, Hugging Face rejects every sign-in with an opaque error.
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    expect(await challengeFor(verifier)).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  it("is base64url with no padding", async () => {
    const c = await challengeFor("a".repeat(43));
    expect(c).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(c).not.toContain("=");
  });

  it("is stable for one verifier and different for another", async () => {
    expect(await challengeFor("abc")).toBe(await challengeFor("abc"));
    expect(await challengeFor("abc")).not.toBe(await challengeFor("abd"));
  });
});

describe("authorize URL", () => {
  const url = authorizeUrl({
    clientId: "cid",
    redirectUri: "https://audiosaw.com/stemflipper/",
    state: "st8",
    challenge: "chal",
  });
  const params = new URL(url).searchParams;

  it("points at Hugging Face with a code+S256 flow", () => {
    expect(url.startsWith("https://huggingface.co/oauth/authorize?")).toBe(true);
    expect(params.get("response_type")).toBe("code");
    expect(params.get("code_challenge_method")).toBe("S256");
    expect(params.get("code_challenge")).toBe("chal");
    expect(params.get("state")).toBe("st8");
  });

  it("asks for nothing beyond identity", () => {
    // Anything more would let a leaked token touch the user's repos.
    expect(params.get("scope")).toBe("openid profile");
  });

  it("carries no secret", () => {
    expect(url).not.toMatch(/client_secret/);
  });

  it("sends the redirect URI exactly, since Hugging Face matches it literally", () => {
    expect(params.get("redirect_uri")).toBe("https://audiosaw.com/stemflipper/");
  });
});
