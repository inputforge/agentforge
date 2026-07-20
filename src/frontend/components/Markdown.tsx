import type { ComponentProps } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * The forge-themed markdown renderer, shared by every agent-facing conversation view
 * (AgentAcpPanel, PlanningPanel). Extracted rather than duplicated: both render the same
 * kind of content — an ACP agent's prose, including code blocks and links — and a second
 * copy would just be a second place to drift out of sync with the design tokens.
 */

const mdRemarkPlugins = [remarkGfm];

const mdComponents: ComponentProps<typeof ReactMarkdown>["components"] = {
  a: ({ href, children }) => (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="text-forge-accent underline underline-offset-2"
    >
      {children}
    </a>
  ),
  blockquote: ({ children }) => (
    <blockquote className="border-l-2 border-forge-accent/30 pl-3 my-1 text-forge-text-dim text-xs">
      {children}
    </blockquote>
  ),
  code: ({ className, children }) => {
    const lang = /language-(\w+)/.exec(className ?? "")?.[1];
    if (lang) {
      return (
        <div className="my-2 overflow-x-auto bg-forge-green/5 border-l-2 border-l-forge-green/50">
          <div className="px-3 pt-1.5 pb-0 text-[9px] uppercase tracking-widest text-forge-green/50">
            {lang}
          </div>
          <pre className="px-3 py-2 text-xs leading-relaxed whitespace-pre-wrap font-mono text-forge-green">
            {String(children).replace(/\n$/, "")}
          </pre>
        </div>
      );
    }
    return (
      <code className="font-mono text-xs text-forge-green bg-forge-surface px-1">{children}</code>
    );
  },
  em: ({ children }) => <em className="text-forge-text-dim italic">{children}</em>,
  h1: ({ children }) => <h1 className="text-sm font-mono text-forge-accent my-2">{children}</h1>,
  h2: ({ children }) => <h2 className="text-xs font-mono text-forge-accent my-2">{children}</h2>,
  h3: ({ children }) => <h3 className="text-xs font-mono text-forge-text-dim my-1">{children}</h3>,
  li: ({ children }) => <li className="leading-relaxed">{children}</li>,
  ol: ({ children }) => (
    <ol className="text-xs text-forge-text list-decimal list-inside my-1 space-y-0.5">
      {children}
    </ol>
  ),
  p: ({ children }) => <p className="text-xs leading-relaxed text-forge-text my-1">{children}</p>,
  pre: ({ children }) => <>{children}</>,
  strong: ({ children }) => (
    <strong className="text-forge-text-bright font-mono">{children}</strong>
  ),
  ul: ({ children }) => (
    <ul className="text-xs text-forge-text list-disc list-inside my-1 space-y-0.5">{children}</ul>
  ),
};

export function MarkdownContent({ text }: { text: string }) {
  return (
    <ReactMarkdown remarkPlugins={mdRemarkPlugins} components={mdComponents}>
      {text}
    </ReactMarkdown>
  );
}
