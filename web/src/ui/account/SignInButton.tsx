/**
 * Sign in with Hugging Face.
 *
 * Hidden entirely when no OAuth client id is configured, so the site still works — the
 * whole flow is optional and anonymous visitors get the shared 2 GPU-minutes a day.
 */

import { useState } from "preact/hooks";
import { isConfigured, login } from "../../api/hfAuth";
import { auth, signOut, tier } from "../../model/auth";
import { dailyBudgetS } from "../../model/quota";
import { formatSeconds } from "../../model/quota";
import { Avatar, Button } from "../components/primitives";

export function SignInButton() {
  const [open, setOpen] = useState(false);
  const a = auth.value;

  if (a.status === "anonymous" && !isConfigured()) return null;

  if (a.status === "anonymous") {
    return (
      <Button size="sm" onClick={() => void login()} title="Use your own free GPU time instead of the shared pool">
        Sign in with Hugging Face
      </Button>
    );
  }

  const name = a.status === "signed_in" ? a.user.name : "token";
  const picture = a.status === "signed_in" ? a.user.picture : null;
  const budget = formatSeconds(dailyBudgetS(tier()));

  return (
    <div style={{ position: "relative" }}>
      <Button size="sm" variant="ghost" onClick={() => setOpen(!open)} aria-expanded={open}>
        <Avatar src={picture} name={name} size={20} />
        <span class="nowrap">{name}</span>
      </Button>
      {open ? (
        <div
          class="card"
          style={{ position: "absolute", right: 0, top: "calc(100% + 6px)", width: "240px", zIndex: 40 }}
          onMouseLeave={() => setOpen(false)}
        >
          <div class="small">
            Signed in{a.status === "signed_in" && a.user.isPro ? " with PRO" : ""}.
          </div>
          <div class="small dim" style={{ marginTop: "4px" }}>
            {budget} of GPU time a day, billed to your account.
          </div>
          <Button
            size="sm"
            variant="ghost"
            block
            style={{ marginTop: "10px" }}
            onClick={() => {
              signOut();
              setOpen(false);
            }}
          >
            Sign out
          </Button>
        </div>
      ) : null}
    </div>
  );
}
