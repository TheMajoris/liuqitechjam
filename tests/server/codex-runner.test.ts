import { describe, expect, it } from "vitest";
import {
  parseCodexEventLine,
  type ParsedEvents,
} from "../../apps/server/src/codex-runner.js";

function emptyParsed(): ParsedEvents {
  return { messages: [], threadId: null, usage: null, errors: [] };
}

describe("parseCodexEventLine observer tap", () => {
  it("forwards each parsed event to the observer", () => {
    const seen: Record<string, unknown>[] = [];
    const parsed = emptyParsed();
    parseCodexEventLine('{"type":"thread.started","thread_id":"t1"}', parsed, {
      onEvent: (event) => seen.push(event),
    });
    parseCodexEventLine(
      '{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"hi"}}',
      parsed,
      { onEvent: (event) => seen.push(event) },
    );

    expect(seen.map((event) => event.type)).toEqual([
      "thread.started",
      "item.completed",
    ]);
    expect(parsed.threadId).toBe("t1");
    expect(parsed.messages).toEqual(["hi"]);
  });

  it("does not call the observer for an unparsable line", () => {
    let calls = 0;
    parseCodexEventLine("not json", emptyParsed(), {
      onEvent: () => {
        calls += 1;
      },
    });

    expect(calls).toBe(0);
  });

  it("keeps parsing when the observer throws", () => {
    const parsed = emptyParsed();
    expect(() =>
      parseCodexEventLine(
        '{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"hi"}}',
        parsed,
        {
          onEvent: () => {
            throw new Error("observer exploded");
          },
        },
      ),
    ).not.toThrow();

    expect(parsed.messages).toEqual(["hi"]);
  });
});
