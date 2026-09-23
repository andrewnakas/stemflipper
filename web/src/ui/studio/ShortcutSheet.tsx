import { Modal } from "../components/Modal";
import { SHORTCUTS } from "./keymap";

export function ShortcutSheet({ onClose }: { onClose: () => void }) {
  return (
    <Modal title="Studio shortcuts" onClose={onClose}>
      <p class="small dim" style={{ marginBottom: "var(--s3)" }}>
        Drag a note to move it, drag its edges to change its length, and drag on empty space to
        select several.
      </p>
      <table class="facts">
        <tbody>
          {SHORTCUTS.map((s) => (
            <tr key={s.what}>
              <td style={{ whiteSpace: "nowrap" }}>
                {s.keys.map((k, i) => (
                  <span key={k}>
                    {i > 0 ? <span class="dim"> </span> : null}
                    <kbd>{k}</kbd>
                  </span>
                ))}
              </td>
              <td class="small">{s.what}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Modal>
  );
}
