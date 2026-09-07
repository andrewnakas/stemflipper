import { describe, expect, it } from "vitest";
import { SseParser } from "../src/api/sse";

describe("SseParser", () => {
  it("parses a whole frame", () => {
    const p = new SseParser();
    expect(p.push('data: {"msg":"process_starts"}\n\n')).toEqual([
      { event: undefined, id: undefined, data: '{"msg":"process_starts"}' },
    ]);
  });

  it("buffers a frame split across chunks", () => {
    const p = new SseParser();
    expect(p.push('data: {"msg":"pro')).toEqual([]);
    const frames = p.push('gress"}\n\n');
    expect(frames).toHaveLength(1);
    expect(JSON.parse(frames[0].data).msg).toBe("progress");
  });

  it("handles CRLF and multiple frames in one chunk", () => {
    const p = new SseParser();
    const frames = p.push("data: one\r\n\r\ndata: two\r\n\r\n");
    expect(frames.map((f) => f.data)).toEqual(["one", "two"]);
  });

  it("joins multi-line data and skips comments", () => {
    const p = new SseParser();
    const frames = p.push(": keep-alive\ndata: a\ndata: b\n\n");
    expect(frames).toHaveLength(1);
    expect(frames[0].data).toBe("a\nb");
  });

  it("reads event and id fields", () => {
    const p = new SseParser();
    const [f] = p.push("event: heartbeat\nid: 7\ndata: x\n\n");
    expect(f.event).toBe("heartbeat");
    expect(f.id).toBe("7");
  });

  it("flushes a trailing frame with no blank line", () => {
    const p = new SseParser();
    expect(p.push("data: last")).toEqual([]);
    expect(p.flush().map((f) => f.data)).toEqual(["last"]);
  });
});
