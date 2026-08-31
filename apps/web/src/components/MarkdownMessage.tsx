import Markdown from "react-markdown";

/**
 * The one renderer for model-authored conversational text.
 *
 * Both an Agent's private workspace and the Team conversation use this, so the
 * two views cannot drift apart again. `react-markdown` builds React elements
 * directly — no `dangerouslySetInnerHTML`, and no raw HTML from model output is
 * ever parsed, so a reply cannot inject markup.
 *
 * Only Agent output goes through here. User-authored text stays plain, and
 * status cards like "Could not finish" stay ordinary components.
 */
export function MarkdownMessage({
  content,
  className = "",
}: {
  content: string;
  className?: string;
}) {
  return (
    <div className={("markdown-message " + className).trim()}>
      <Markdown
        components={{
          // Model output is a fragment of a conversation, not a document, so
          // its headings must not compete with the page's real heading levels.
          h1: ({ children }) => <p className="markdown-heading">{children}</p>,
          h2: ({ children }) => <p className="markdown-heading">{children}</p>,
          h3: ({ children }) => <p className="markdown-heading">{children}</p>,
          h4: ({ children }) => <p className="markdown-heading">{children}</p>,
          h5: ({ children }) => <p className="markdown-heading">{children}</p>,
          h6: ({ children }) => <p className="markdown-heading">{children}</p>,
          // Links in model output are untrusted; never let one reach the opener.
          a: ({ children, href }) => (
            <a href={href} target="_blank" rel="noopener noreferrer nofollow">
              {children}
            </a>
          ),
        }}
      >
        {content}
      </Markdown>
    </div>
  );
}
