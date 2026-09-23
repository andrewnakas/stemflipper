/**
 * The settings that used to sit on the main path in v2: a raw backend URL and a token
 * field, both of which a first-time visitor had to read past before they could do
 * anything. They still exist — running the backend locally is genuinely useful — but they
 * belong behind a disclosure.
 */

import { useState } from "preact/hooks";
import { DEFAULT_BACKEND } from "../../config";
import { auth, setPastedToken, signOut } from "../../model/auth";
import { backend } from "../../model/store";
import { Button } from "../components/primitives";
import { Disclosure } from "../components/Disclosure";
import { saveBackend } from "../../model/store";

export function AdvancedPanel() {
  const [url, setUrl] = useState(backend.value.baseUrl);
  const [token, setToken] = useState(auth.value.status === "token" ? auth.value.token : "");
  const [remember, setRemember] = useState(auth.value.status === "token" ? auth.value.remembered : false);

  return (
    <Disclosure summary={<span class="small dim">Advanced</span>}>
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
          type="password"
          value={token}
          placeholder="hf_…"
          autocomplete="off"
          onInput={(e) => setToken((e.target as HTMLInputElement).value)}
        />
        <span class="xs dim">
          An alternative to signing in. A read-only fine-grained token is enough. Kept for this
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
