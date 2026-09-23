import { useEffect, useRef, useState } from "preact/hooks";
import { LIMITS } from "../../config";

/** The one control that has to be obvious. Click, drop, or keyboard-activate. */
export function DropZone(props: { onFile: (f: File) => void; disabled?: boolean }) {
  const [hot, setHot] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const take = (f: File | null | undefined) => {
    if (f && !props.disabled) props.onFile(f);
  };

  return (
    <div
      class={"dropzone" + (hot ? " dropzone--hot" : "")}
      role="button"
      tabIndex={0}
      aria-label="Choose a song to flip"
      onClick={() => input.current?.click()}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          input.current?.click();
        }
      }}
      onDragOver={(e) => {
        e.preventDefault();
        setHot(true);
      }}
      onDragLeave={() => setHot(false)}
      onDrop={(e) => {
        e.preventDefault();
        setHot(false);
        take(e.dataTransfer?.files?.[0]);
      }}
    >
      <span class="dropzone__big">Drop a song here</span>
      <span class="dropzone__hint">or click to choose one</span>
      <span class="dropzone__hint">
        mp3, wav, flac, m4a · up to {LIMITS.maxMinutes} minutes · {LIMITS.maxBytesLabel}
      </span>
      <input
        ref={input}
        type="file"
        accept="audio/*,video/mp4,.zip"
        class="visually-hidden"
        onChange={(e) => {
          const el = e.target as HTMLInputElement;
          take(el.files?.[0]);
          el.value = "";
        }}
      />
    </div>
  );
}

/**
 * Lets the visitor drop a file anywhere on the page, not just on the box.
 *
 * Window-level listeners rather than a wrapper element: a drag that starts over a child
 * element fires dragleave on every boundary it crosses, so a counter is the only way to
 * know when the pointer has really left the window.
 */
export function DropVeil({ onFile, label = "Drop it anywhere" }: { onFile: (f: File) => void; label?: string }) {
  const [over, setOver] = useState(false);
  const depth = useRef(0);

  useEffect(() => {
    const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types || []).includes("Files");
    const onEnter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth.current++;
      setOver(true);
    };
    const onLeave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setOver(false);
    };
    const onOver = (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault();
    };
    const onDrop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth.current = 0;
      setOver(false);
      const f = e.dataTransfer?.files?.[0];
      if (f) onFile(f);
    };
    window.addEventListener("dragenter", onEnter);
    window.addEventListener("dragleave", onLeave);
    window.addEventListener("dragover", onOver);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragenter", onEnter);
      window.removeEventListener("dragleave", onLeave);
      window.removeEventListener("dragover", onOver);
      window.removeEventListener("drop", onDrop);
    };
  }, [onFile]);

  if (!over) return null;
  return <div class="dropveil">{label}</div>;
}
