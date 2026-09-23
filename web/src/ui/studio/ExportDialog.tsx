/**
 * What goes in the export zip.
 *
 * `buildExportZip` has always been able to render each track separately, but nothing
 * exposed it — so the one thing a person most often wants out of an editor, the stems as
 * they currently sound with their edits, was unreachable.
 */

import { useState } from "preact/hooks";
import { busy, notesByTrack, project } from "../../model/store";
import { Button } from "../components/primitives";
import { Modal } from "../components/Modal";
import { downloadBundle } from "../exports";

export function ExportDialog({ onClose }: { onClose: () => void }) {
  const [midi, setMidi] = useState(true);
  const [mix, setMix] = useState(true);
  const [stems, setStems] = useState(false);
  const p = project.value;
  const edits = Object.values(notesByTrack.value).reduce((n, list) => n + list.length, 0);

  const rows: { on: boolean; set: (v: boolean) => void; label: string; hint: string }[] = [
    { on: midi, set: setMidi, label: "MIDI", hint: `your edited notes — ${edits} across ${p?.tracks.length ?? 0} tracks` },
    { on: mix, set: setMix, label: "Mixed audio", hint: "one WAV of everything as it sounds right now" },
    { on: stems, set: setStems, label: "Each track separately", hint: "one WAV per track, same balance — slower to render" },
  ];

  return (
    <Modal
      title="Export"
      onClose={onClose}
      footer={
        <>
          <Button
            variant="primary"
            disabled={busy.value || (!midi && !mix && !stems)}
            onClick={() => {
              void downloadBundle({ midi, mix, stems });
              onClose();
            }}
          >
            Download zip
          </Button>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
        </>
      }
    >
      <div class="stack" style={{ gap: "var(--s3)" }}>
        {rows.map((r) => (
          <label key={r.label} class="row" style={{ alignItems: "flex-start", gap: "var(--s2)" }}>
            <input type="checkbox" checked={r.on} onChange={(e) => r.set((e.target as HTMLInputElement).checked)} />
            <span class="stack">
              <b>{r.label}</b>
              <span class="xs dim">{r.hint}</span>
            </span>
          </label>
        ))}
      </div>
      <p class="xs dim" style={{ marginTop: "var(--s4)" }}>
        Rendering happens in this browser, so it takes about as long as the song. The
        project file is always included.
      </p>
    </Modal>
  );
}
