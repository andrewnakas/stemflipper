/**
 * Studio keyboard shortcuts. Installed only while Studio is on screen, so Space does not
 * start playback while someone is reading the landing page.
 */

import { nudge, seek, togglePlay, toggleLoop } from "../../model/playback";
import { duration, pxPerSecond, redo, selection, tool, undo } from "../../model/store";
import { deleteSelection, nudgeVelocity, quantizeSelection } from "./gestures";

export function installKeymap(onHelp: () => void): () => void {
  const onKey = (e: KeyboardEvent) => {
    const tag = (e.target as HTMLElement)?.tagName?.toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select") return;
    const step = e.shiftKey ? 5 : 1;

    if (e.key === " " || e.key === "Spacebar") {
      e.preventDefault();
      void togglePlay();
    } else if (e.key === "ArrowLeft") nudge(-step);
    else if (e.key === "ArrowRight") nudge(step);
    else if (e.key === "Home" || e.key === "0") seek(0);
    else if (e.key === "End") seek(duration());
    else if (e.key === "l" || e.key === "L") toggleLoop();
    else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
    } else if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      deleteSelection();
    } else if (e.key === "q" || e.key === "Q") quantizeSelection();
    else if (e.key === "v" || e.key === "V") tool.value = "select";
    else if (e.key === "d" || e.key === "D") tool.value = "draw";
    else if (e.key === "e" || e.key === "E") tool.value = "erase";
    else if (e.key === "?" || (e.key === "/" && e.shiftKey)) onHelp();
    else if (e.key === "Escape") selection.value = new Set();
    else if (e.key === "ArrowUp" && selection.value.size) {
      e.preventDefault();
      nudgeVelocity(e.shiftKey ? 16 : 4);
    } else if (e.key === "ArrowDown" && selection.value.size) {
      e.preventDefault();
      nudgeVelocity(e.shiftKey ? -16 : -4);
    } else if (e.key === "=" || e.key === "+") pxPerSecond.value = Math.min(400, pxPerSecond.value * 1.3);
    else if (e.key === "-") pxPerSecond.value = Math.max(4, pxPerSecond.value / 1.3);
  };

  window.addEventListener("keydown", onKey);
  return () => window.removeEventListener("keydown", onKey);
}

export const SHORTCUTS: { keys: string[]; what: string }[] = [
  { keys: ["Space"], what: "Play or pause" },
  { keys: ["←", "→"], what: "Nudge one second (Shift for five)" },
  { keys: ["Home", "End"], what: "Jump to the start or end" },
  { keys: ["L"], what: "Loop the selected region" },
  { keys: ["V", "D", "E"], what: "Select, draw, erase" },
  { keys: ["Q"], what: "Quantise the selection to the snap setting" },
  { keys: ["↑", "↓"], what: "Louder or quieter (Shift for bigger steps)" },
  { keys: ["Delete"], what: "Delete the selected notes" },
  { keys: ["Cmd/Ctrl", "Z"], what: "Undo (add Shift to redo)" },
  { keys: ["+", "−"], what: "Zoom in and out" },
  { keys: ["?"], what: "Show this list" },
];
