/**
 * The settings that used to sit on the main path in v2: a raw backend URL and a token
 * field, both of which a first-time visitor had to read past before they could do
 * anything. They still exist — running the backend locally is genuinely useful — but they
 * belong behind a disclosure.
 */

import { useEffect, useRef, useState } from "preact/hooks";
import { signal } from "@preact/signals";
import { DEFAULT_BACKEND } from "../../config";
import { auth, setPastedToken, signOut } from "../../model/auth";
import { backend } from "../../model/store";
import { Button } from "../components/primitives";
import { Disclosure } from "../components/Disclosure";
import { saveBackend } from "../../model/store";

/**
 * Set when something elsewhere needs the token field — the quota panel, when the server
 * has just said in so many words that a token is what would fix this.
 */
export const wantToken = signal(false);

export function AdvancedPanel() {
  const [url, setUrl] = useState(backend.value.baseUrl);
  const [token, setToken] = useState(auth.value.status === "token" ? auth.value.token : "");
  const [remember, setRemember] = useState(auth.value.status === "token" ? auth.value.remembered : false);
  const tokenField = useRef<HTMLInputElement>(null);
  const details = useRef<HTMLDetailsElement>(null);
  const asked = wantToken.value;

  useEffect(() => {
    if (!asked) return;
    // Open the <details> imperatively rather than through a prop: clearing the signal
    // re-renders, and a controlled `open` would snap straight shut again.
    if (details.current) details.current.open = true;
    tokenField.current?.focus();
    tokenField.current?.scrollIntoView({ block: "center", behavior: "smooth" });
    wantToken.value = false;
  }, [asked]);

  return (
    <Disclosure summary={<span class="small dim">Advanced</span>} elemRef={details}>
      <label class="stack small" style={{ gap: "var(--s1)" }}>
        Processing server
        <input
          type="url"
          value={url}
          onInput={(e) => setUrl((e.target as HTMLInputElement).value)}
          onBlur={() => saveBackend({ ...backend.value, baseUrl: url || DEFAULT_BACKEND })}
          spellcheck={false}
        />
        <span class="xs dim">
          Run <code>python app.py</code> on your own machine and point this at{" "}
          <code>http://127.0.0.1:7860</code> to skip the queue and the daily limit entirely.
        </span>
      </label>

      <label class="stack small" style={{ gap: "var(--s1)", marginTop: "var(--s4)" }}>
        Hugging Face token
        <input
          ref={tokenField}
          type="password"
          value={token}
          placeholder="hf_…"
          autocomplete="off"
          onInput={(e) => setToken((e.target as HTMLInputElement).value)}
        />
        <span class="xs dim">
          Gives you your own daily allowance instead of the shared one.{" "}
          <a href="https://huggingface.co/settings/tokens" target="_blank" rel="noopener">
            Create one here
          </a>{" "}
          — a read-only fine-grained token is enough, and a free account works. Kept for this
          tab only unless you tick the box.
        </span>
      </label>
      <div class="row" style={{ marginTop: "var(--s2)" }}>
        <label class="xs row">
          <input type="checkbox" checked={remember} onChange={(e) => setRemember((e.target as HTMLInputElement).checked)} />
          Remember on this device
        </label>
        <span class="spacer" />
        <Button size="sm" onClick={() => (token.trim() ? setPastedToken(token, remember) : signOut())}>
          {token.trim() ? "Use this token" : "Clear"}
        </Button>
      </div>
    </Disclosure>
  );
}
