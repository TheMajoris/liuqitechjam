import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MarkdownMessage } from "../../../apps/web/src/components/MarkdownMessage";

describe("MarkdownMessage", () => {
  it("renders Agent Markdown as formatted elements, not literal syntax", () => {
    const html = renderToStaticMarkup(
      <MarkdownMessage
        content={[
          "**Completed Work**",
          "",
          "- Created `src/App.tsx`",
          "- Updated `src/App.css`",
        ].join("\n")}
      />,
    );

    expect(html).toContain("<strong>Completed Work</strong>");
    expect(html).toContain("<ul>");
    expect(html).toContain("<code>src/App.tsx</code>");
    // The raw syntax must be gone, not merely wrapped.
    expect(html).not.toContain("**Completed Work**");
    expect(html).not.toContain("`src/App.tsx`");
  });

  it("never emits raw HTML from model output", () => {
    const html = renderToStaticMarkup(
      <MarkdownMessage content={'<img src=x onerror="alert(1)">'} />,
    );

    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });
});
