import { SiGithub, SiLinear } from "@icons-pack/react-simple-icons";
import { ArrowLeft, ExternalLink, Import, X } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import { api } from "../lib/api";
import { useStore } from "../store";
import type { GitHubIssue, LinearIssue, Ticket } from "../types";

type CreateMode = "manual" | "github" | "linear";

function titleFromDescription(description: string): string {
  const trimmed = description.trim();
  if (!trimmed) return "Untitled";
  const firstSentence = trimmed.split(/(?<=[.!?])\s+/)[0] ?? trimmed;
  const firstLine = trimmed.split(/\r?\n/)[0] ?? trimmed;
  const candidate = firstSentence.length <= firstLine.length ? firstSentence : firstLine;
  return candidate.length > 72 ? candidate.slice(0, 69).trimEnd() + "…" : candidate;
}

function matchesIssueSearch(query: string, title: string, numberOrIdentifier: string): boolean {
  const normalized = query.trim().toLowerCase().replace(/^#/, "");
  if (!normalized) return true;
  return (
    title.toLowerCase().includes(normalized) ||
    numberOrIdentifier.toLowerCase().includes(normalized)
  );
}

function githubIssueDraft(issue: GitHubIssue): string {
  return [`#${issue.number}: ${issue.title}`, issue.body].filter(Boolean).join("\n\n");
}

function linearIssueDraft(issue: LinearIssue): string {
  return [`${issue.identifier}: ${issue.title}`, issue.description].filter(Boolean).join("\n\n");
}

export function CreateTicketModal() {
  const { isCreateModalOpen, closeCreateModal, addTicket, addNotification, moveTicket } =
    useStore();
  const [screen, setScreen] = useState<CreateMode>("manual");
  const [description, setDescription] = useState("");
  const [startNow, setStartNow] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [githubAvailable, setGithubAvailable] = useState(false);
  const [linearAvailable, setLinearAvailable] = useState(false);

  const [githubIssues, setGithubIssues] = useState<GitHubIssue[]>([]);
  const [githubState, setGithubState] = useState<"open" | "closed" | "all">("open");
  const [githubSearch, setGithubSearch] = useState("");
  const [loadingGithub, setLoadingGithub] = useState(false);

  const [linearIssues, setLinearIssues] = useState<LinearIssue[]>([]);
  const [linearSearch, setLinearSearch] = useState("");
  const [loadingLinear, setLoadingLinear] = useState(false);

  const handleDescriptionChange = useCallback(
    (e: ChangeEvent<HTMLTextAreaElement>) => setDescription(e.target.value),
    [],
  );
  const handleStartNowChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => setStartNow(e.target.checked),
    [],
  );
  const handleGithubStateChange = useCallback(
    (e: ChangeEvent<HTMLSelectElement>) =>
      setGithubState(e.target.value as "open" | "closed" | "all"),
    [],
  );
  const handleGithubSearchChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => setGithubSearch(e.target.value),
    [],
  );
  const handleLinearSearchChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => setLinearSearch(e.target.value),
    [],
  );

  const filteredGithubIssues = useMemo(
    () =>
      githubIssues.filter((issue) =>
        matchesIssueSearch(githubSearch, issue.title, String(issue.number)),
      ),
    [githubIssues, githubSearch],
  );
  const filteredLinearIssues = useMemo(
    () =>
      linearIssues.filter((issue) =>
        matchesIssueSearch(linearSearch, issue.title, issue.identifier),
      ),
    [linearIssues, linearSearch],
  );

  useEffect(() => {
    if (!isCreateModalOpen) return;
    let cancelled = false;

    api.integrations
      .getConfig("github")
      .then((cfg) => {
        if (!cancelled) setGithubAvailable(cfg.hasPat && !!cfg.owner && !!cfg.repo);
      })
      .catch(() => {
        if (!cancelled) setGithubAvailable(false);
      });
    api.integrations
      .getConfig("linear")
      .then((cfg) => {
        if (!cancelled) setLinearAvailable(cfg.hasPat);
      })
      .catch(() => {
        if (!cancelled) setLinearAvailable(false);
      });

    return () => {
      cancelled = true;
    };
  }, [isCreateModalOpen]);

  const finishTicket = useCallback(
    async (ticket: Ticket) => {
      addTicket(ticket);
      closeCreateModal();
      setScreen("manual");
      setDescription("");
      setGithubSearch("");
      setLinearSearch("");
      setStartNow(false);
      if (startNow) await moveTicket(ticket.id, "in-progress");
    },
    [addTicket, closeCreateModal, moveTicket, startNow],
  );

  const handleCreate = useCallback(async () => {
    if (!description.trim()) return;
    setIsCreating(true);
    try {
      const ticket = await api.tickets.create({
        title: titleFromDescription(description),
        description: description.trim(),
      });
      await finishTicket(ticket);
    } catch (err) {
      addNotification({ type: "error", message: (err as Error).message });
    } finally {
      setIsCreating(false);
    }
  }, [description, finishTicket, addNotification]);

  const handleFetchGithubIssues = useCallback(async () => {
    setLoadingGithub(true);
    try {
      setGithubIssues(await api.integrations.github.listIssues(githubState));
    } catch (err) {
      addNotification({ type: "error", message: (err as Error).message });
    } finally {
      setLoadingGithub(false);
    }
  }, [githubState, addNotification]);

  const handleFetchLinearIssues = useCallback(async () => {
    setLoadingLinear(true);
    try {
      setLinearIssues(await api.integrations.linear.listIssues());
    } catch (err) {
      addNotification({ type: "error", message: (err as Error).message });
    } finally {
      setLoadingLinear(false);
    }
  }, [addNotification]);

  const handleImportGithubIssue = useCallback(
    async (id: string | number) => {
      const number = Number(id);
      const issue = githubIssues.find((item) => item.number === number);
      if (!issue) {
        addNotification({ type: "error", message: `GitHub issue #${number} is not loaded` });
        return;
      }
      setDescription(githubIssueDraft(issue));
      setScreen("manual");
      addNotification({ type: "info", message: `Prefilled from GitHub #${number}` });
    },
    [githubIssues, addNotification],
  );

  const handleImportLinearIssue = useCallback(
    async (id: string | number) => {
      const issueId = String(id);
      const issue = linearIssues.find((item) => item.id === issueId);
      if (!issue) {
        addNotification({ type: "error", message: "Linear issue is not loaded" });
        return;
      }
      setDescription(linearIssueDraft(issue));
      setScreen("manual");
      addNotification({ type: "info", message: `Prefilled from ${issue.identifier}` });
    },
    [linearIssues, addNotification],
  );

  const handleBackdrop = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget) closeCreateModal();
    },
    [closeCreateModal],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") closeCreateModal();
      if (screen === "manual" && e.key === "Enter" && (e.metaKey || e.ctrlKey)) handleCreate();
    },
    [closeCreateModal, handleCreate, screen],
  );

  const showManual = useCallback(() => setScreen("manual"), []);
  const showGithubImport = useCallback(() => setScreen("github"), []);
  const showLinearImport = useCallback(() => setScreen("linear"), []);

  if (!isCreateModalOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 animate-fade-in"
      onClick={handleBackdrop}
      onKeyDown={handleKeyDown}
    >
      <div className="forge-panel w-[560px] max-h-[85vh] flex flex-col animate-fade-in">
        <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-forge-border shrink-0">
          <span className="forge-label">CREATE TICKET</span>
          <button
            className="text-forge-text-muted hover:text-forge-text"
            onClick={closeCreateModal}
            title="ESC"
          >
            <X size={13} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-5">
          <label className="flex items-center gap-2 cursor-pointer select-none w-fit">
            <input
              type="checkbox"
              className="accent-forge-accent"
              checked={startNow}
              onChange={handleStartNowChange}
            />
            <span className="text-forge-text-dim text-xs uppercase tracking-widest">Start now</span>
          </label>

          {screen === "manual" && (
            <div className="flex flex-col gap-4 mt-4">
              {(githubAvailable || linearAvailable) && (
                <div className="flex items-center gap-2">
                  <span className="forge-label">IMPORT</span>
                  {githubAvailable && (
                    <button
                      className="forge-btn-ghost py-1 px-3 flex items-center gap-1.5"
                      onClick={showGithubImport}
                    >
                      <SiGithub size={11} />
                      <span>GITHUB</span>
                    </button>
                  )}
                  {linearAvailable && (
                    <button
                      className="forge-btn-ghost py-1 px-3 flex items-center gap-1.5"
                      onClick={showLinearImport}
                    >
                      <SiLinear size={11} />
                      <span>LINEAR</span>
                    </button>
                  )}
                </div>
              )}

              <div>
                <label className="forge-label mb-1.5 block">TASK</label>
                <textarea
                  className="forge-input resize-none h-36"
                  placeholder="Describe what needs to be built or fixed…"
                  value={description}
                  onChange={handleDescriptionChange}
                  autoFocus
                />
              </div>

              <div className="flex justify-end gap-2 pt-1">
                <button className="forge-btn-ghost py-1.5 px-4" onClick={closeCreateModal}>
                  CANCEL
                </button>
                <button
                  className="forge-btn-primary py-1.5 px-6"
                  onClick={handleCreate}
                  disabled={isCreating || !description.trim()}
                >
                  {isCreating ? (startNow ? "STARTING..." : "CREATING...") : "CREATE TICKET"}
                </button>
              </div>
            </div>
          )}

          {screen === "github" && (
            <div className="flex flex-col gap-3 mt-4">
              <StackHeader onBack={showManual}>
                <SiGithub size={11} />
                GITHUB ISSUES
              </StackHeader>
              <div className="flex items-center gap-3">
                <select
                  className="forge-input w-auto py-0.5 px-2 text-xs"
                  value={githubState}
                  onChange={handleGithubStateChange}
                >
                  <option value="open">Open</option>
                  <option value="closed">Closed</option>
                  <option value="all">All</option>
                </select>
                <button
                  className="forge-btn-ghost py-0.5 px-3"
                  onClick={handleFetchGithubIssues}
                  disabled={loadingGithub}
                >
                  {loadingGithub ? "LOADING…" : "FETCH"}
                </button>
              </div>
              <input
                className="forge-input"
                placeholder="Search title or #number"
                value={githubSearch}
                onChange={handleGithubSearchChange}
              />
              <IssueList
                emptyText={
                  githubIssues.length > 0
                    ? "No GitHub issues match that search."
                    : "Click FETCH to load GitHub issues."
                }
                loading={loadingGithub}
              >
                {filteredGithubIssues.map((issue) => (
                  <ImportIssueRow
                    key={issue.number}
                    importId={issue.number}
                    label={`#${issue.number}`}
                    title={issue.title}
                    state={issue.state}
                    url={issue.url}
                    labels={issue.labels}
                    onImport={handleImportGithubIssue}
                  />
                ))}
              </IssueList>
            </div>
          )}

          {screen === "linear" && (
            <div className="flex flex-col gap-3 mt-4">
              <StackHeader onBack={showManual}>
                <SiLinear size={11} />
                LINEAR ISSUES
              </StackHeader>
              <div className="flex items-center gap-3">
                <button
                  className="forge-btn-ghost py-0.5 px-3"
                  onClick={handleFetchLinearIssues}
                  disabled={loadingLinear}
                >
                  {loadingLinear ? "LOADING…" : "FETCH"}
                </button>
              </div>
              <input
                className="forge-input"
                placeholder="Search title or number"
                value={linearSearch}
                onChange={handleLinearSearchChange}
              />
              <IssueList
                emptyText={
                  linearIssues.length > 0
                    ? "No Linear issues match that search."
                    : "Click FETCH to load Linear issues."
                }
                loading={loadingLinear}
              >
                {filteredLinearIssues.map((issue) => (
                  <ImportIssueRow
                    key={issue.id}
                    importId={issue.id}
                    label={issue.identifier}
                    title={issue.title}
                    state={issue.state}
                    url={issue.url}
                    labels={issue.labels}
                    onImport={handleImportLinearIssue}
                  />
                ))}
              </IssueList>
            </div>
          )}
        </div>

        {screen === "manual" && (
          <p className="text-forge-text-muted text-xs px-6 pb-4">⌘+ENTER to create</p>
        )}
      </div>
    </div>
  );
}

function StackHeader({ onBack, children }: { onBack: () => void; children: ReactNode }) {
  return (
    <div className="flex items-center gap-3">
      <button
        className="forge-btn-ghost py-1 px-2 flex items-center gap-1.5"
        onClick={onBack}
        title="Back"
      >
        <ArrowLeft size={12} />
        <span>BACK</span>
      </button>
      <span className="forge-label flex items-center gap-1.5">{children}</span>
    </div>
  );
}

function IssueList({
  children,
  emptyText,
  loading,
}: {
  children: ReactNode;
  emptyText: string;
  loading: boolean;
}) {
  if (!loading && (!children || (Array.isArray(children) && children.length === 0))) {
    return <p className="text-forge-text-muted text-xs">{emptyText}</p>;
  }

  return <div className="flex flex-col gap-1 max-h-64 overflow-y-auto">{children}</div>;
}

function ImportIssueRow({
  importId,
  label,
  title,
  state,
  url,
  labels,
  onImport,
}: {
  importId: string | number;
  label: string;
  title: string;
  state: string;
  url: string;
  labels: string[];
  onImport: (id: string | number) => void;
}) {
  const handleImport = useCallback(() => onImport(importId), [onImport, importId]);
  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        onImport(importId);
      }
    },
    [onImport, importId],
  );
  const handleExternalClick = useCallback((e: MouseEvent<HTMLAnchorElement>) => {
    e.stopPropagation();
  }, []);

  return (
    <div
      className="flex items-start gap-2 p-2 bg-forge-surface border border-forge-border hover:border-forge-accent transition-colors cursor-pointer"
      role="button"
      tabIndex={0}
      onClick={handleImport}
      onKeyDown={handleKeyDown}
      title="Prefill new ticket"
    >
      <span className="text-forge-accent text-[10px] font-mono shrink-0 mt-0.5 w-14 truncate">
        {label}
      </span>
      <div className="flex-1 min-w-0">
        <p className="text-forge-text text-xs truncate">{title}</p>
        <div className="flex items-center gap-1 mt-0.5 flex-wrap">
          <span className="text-forge-text-muted text-[10px]">{state}</span>
          {labels.slice(0, 3).map((item) => (
            <span
              key={item}
              className="text-[10px] text-forge-text-dim border border-forge-border px-1"
            >
              {item}
            </span>
          ))}
        </div>
      </div>
      <div className="flex items-center gap-1 shrink-0">
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          className="text-forge-text-muted hover:text-forge-accent p-1"
          title="Open in browser"
          onClick={handleExternalClick}
        >
          <ExternalLink size={11} />
        </a>
        <Import size={12} className="text-forge-text-muted" />
      </div>
    </div>
  );
}
