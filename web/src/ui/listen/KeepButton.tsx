/**
 * Keep this song in the browser.
 *
 * The bundle on the Space is pruned after six hours, so without this a link to a finished
 * run stops working overnight — with the project still describing files that are gone.
 */

import { useState } from "preact/hooks";
import { keepCurrent } from "../../model/jobStore";
import { Button } from "../components/primitives";
import { toast } from "../components/Toast";

/**
 * No size is shown before saving on purpose: the only figure available up front is the
 * full bundle's, and this stores a much smaller subset — the stems and instruments the
 * page plays, not the loops and 24-bit samples. Quoting the bundle size would be wrong by
 * an order of magnitude.
 */
export function KeepButton() {
  const [state, setState] = useState<"idle" | "saving" | "kept">("idle");
  const [progress, setProgress] = useState({ done: 0, total: 0 });

  if (state === "kept") {
    return <span class="small" style={{ color: "var(--success)" }}>✓ Kept in this browser</span>;
  }

  return (
    <Button
      variant="ghost"
      disabled={state === "saving"}
      title="Store the stems and instruments here so this keeps working after the server forgets it"
      onClick={() => {
        setState("saving");
        void keepCurrent((done, total) => setProgress({ done, total }))
          .then(() => setState("kept"))
          .catch((e) => {
            setState("idle");
            toast(`Could not keep it: ${(e as Error).message}`, { tone: "error" });
          });
      }}
    >
      {state === "saving"
        ? `Keeping… ${progress.total ? `${progress.done}/${progress.total}` : ""}`
        : "Keep in this browser"}
    </Button>
  );
}
