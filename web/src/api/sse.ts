/**
 * Minimal SSE (text/event-stream) frame parser.
 *
 * We cannot use EventSource: it accepts no request headers, so a ZeroGPU quota token
 * (`Authorization: Bearer …`) could never be attached and every API call would be billed
 * to the shared anonymous pool (2 GPU-min/day). Instead we stream the response body with
 * fetch and split frames ourselves.
 */

export interface SseFrame {
  event?: string;
  data: string;
  id?: string;
}

/** Feed decoded chunks in; get whole frames out. Handles \n\n and \r\n\r\n separators. */
export class SseParser {
  private buf = "";

  push(chunk: string): SseFrame[] {
    this.buf += chunk;
    const frames: SseFrame[] = [];
    // Normalise CRLF so a single split rule covers both wire formats.
    this.buf = this.buf.replace(/\r\n/g, "\n");
    let idx: number;
    while ((idx = this.buf.indexOf("\n\n")) !== -1) {
      const raw = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + 2);
      const frame = parseFrame(raw);
      if (frame) frames.push(frame);
    }
    return frames;
  }

  /** Any trailing partial frame (a stream that ended without a blank line). */
  flush(): SseFrame[] {
    const rest = this.buf.trim();
    this.buf = "";
    if (!rest) return [];
    const frame = parseFrame(rest);
    return frame ? [frame] : [];
  }
}

function parseFrame(raw: string): SseFrame | null {
  const dataLines: string[] = [];
  let event: string | undefined;
  let id: string | undefined;
  for (const line of raw.split("\n")) {
    if (!line || line.startsWith(":")) continue; // comment / keep-alive
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") dataLines.push(value);
    else if (field === "event") event = value;
    else if (field === "id") id = value;
  }
  if (!dataLines.length) return null;
  return { event, id, data: dataLines.join("\n") };
}

/** Read a fetch Response body as a stream of SSE frames. */
export async function* readSse(res: Response, signal?: AbortSignal): AsyncGenerator<SseFrame> {
  if (!res.body) throw new Error("response has no body to stream");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const parser = new SseParser();
  try {
    for (;;) {
      if (signal?.aborted) return;
      const { done, value } = await reader.read();
      if (done) break;
      for (const frame of parser.push(decoder.decode(value, { stream: true }))) yield frame;
    }
    for (const frame of parser.flush()) yield frame;
  } finally {
    reader.releaseLock();
  }
}
