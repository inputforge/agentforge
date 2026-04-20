import { SiGithub, SiLinear } from "@icons-pack/react-simple-icons";
import { CheckCircle, ExternalLink, Import, XCircle, X } from "lucide-react";
import {
  type ChangeEvent,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useState,
} from "react";
import { api } from "../lib/api";
import type { GitHubIssue, LinearIssue, LinearTeam } from "../types";
import { useStore } from "../store";

type Tab = "github" | "linear";

// Moved outside components so it's never recreated
const PRIORITY_LABELS = ["No priority", "Urgent", "High", "Medium", "Low"] as const;
function priorityLabel(p: number): string {
  return PRIORITY_LABELS[p] ?? "Unknown";
}

// ─── Section heading ───────────────────────────────────────────────────────

function SectionLabel({ children, sub }: { children: ReactNode; sub: string }) {
  return (
    <div className="flex items-baseline gap-2 mb-3">
      <span className="forge-label">{children}</span>
      <span className="text-forge-text-muted text-[10px]">{sub}</span>
    </div>
  );
}

// ─── Account status badge ──────────────────────────────────────────────────

function AccountBadge({ connected }: { connected: boolean }) {
  return connected ? (
    <span className="flex items-center gap-1 text-forge-green text-[10px]">
      <CheckCircle size={10} />
      CONNECTED
    </span>
  ) : (
    <span className="flex items-center gap-1 text-forge-text-muted text-[10px]">
      <XCircle size={10} />
      NOT CONNECTED
    </span>
  );
}

// ─── Shared IssueRow ───────────────────────────────────────────────────────
// onImport receives the row's importId so the parent can pass a stable handler

function IssueRow({
  importId,
  label,
  title,
  state,
  url,
  labels,
  importing,
  onImport,
}: {
  importId: string | number;
  label: string;
  title: string;
  state: string;
  url: string;
  labels: string[];
  importing: boolean;
  onImport: (id: string | number) => void;
}) {
  const handleImport = useCallback(() => onImport(importId), [onImport, importId]);

  return (
    <div className="flex items-start gap-2 p-2 bg-forge-surface border border-forge-border hover:border-forge-border-bright transition-colors">
      <span className="text-forge-accent text-[10px] font-mono shrink-0 mt-0.5 w-14 truncate">
        {label}
      </span>
      <div className="flex-1 min-w-0">
        <p className="text-forge-text text-xs truncate">{title}</p>
        <div className="flex items-center gap-1 mt-0.5 flex-wrap">
          <span className="text-forge-text-muted text-[10px]">{state}</span>
          {labels.slice(0, 3).map((l) => (
            <span
              key={l}
              className="text-[10px] text-forge-text-dim border border-forge-border px-1"
            >
              {l}
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
        >
          <ExternalLink size={11} />
        </a>
        <button
          className="forge-btn-ghost py-0.5 px-2 flex items-center gap-1"
          onClick={handleImport}
          disabled={importing}
          title="Import as ticket"
        >
          <Import size={10} />
          <span className="text-[10px]">{importing ? "…" : "IMPORT"}</span>
        </button>
      </div>
    </div>
  );
}

// ─── GitHub Tab ────────────────────────────────────────────────────────────

function GitHubTab() {
  const { addNotification, addTicket } = useStore();

  const [pat, setPat] = useState("");
  const [hasPat, setHasPat] = useState(false);
  const [savingAccount, setSavingAccount] = useState(false);

  const [owner, setOwner] = useState("");
  const [repo, setRepo] = useState("");
  const [savingRepo, setSavingRepo] = useState(false);

  const [issues, setIssues] = useState<GitHubIssue[]>([]);
  const [loadingIssues, setLoadingIssues] = useState(false);
  const [importingId, setImportingId] = useState<number | null>(null);
  const [issueState, setIssueState] = useState<"open" | "closed" | "all">("open");

  // Map from issue number → labels array, computed once per fetch
  const [issueLabelsMap, setIssueLabelsMap] = useState<Map<number, string[]>>(new Map());

  useEffect(() => {
    api.integrations
      .getConfig("github")
      .then((cfg) => {
        setHasPat(cfg.hasPat);
        if (cfg.owner) setOwner(cfg.owner);
        if (cfg.repo) setRepo(cfg.repo);
      })
      .catch(() => {});
  }, []);

  const handlePatChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => setPat(e.target.value),
    [],
  );
  const handleOwnerChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => setOwner(e.target.value),
    [],
  );
  const handleRepoChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => setRepo(e.target.value),
    [],
  );
  const handleIssueStateChange = useCallback(
    (e: ChangeEvent<HTMLSelectElement>) =>
      setIssueState(e.target.value as "open" | "closed" | "all"),
    [],
  );
  const handlePatKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") void handleConnectAccount();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pat],
  );

  const handleConnectAccount = useCallback(async () => {
    if (!pat) return;
    setSavingAccount(true);
    try {
      await api.integrations.saveConfig("github", { pat });
      setHasPat(true);
      setPat("");
      addNotification({ type: "info", message: "GitHub account connected" });
    } catch (err) {
      addNotification({ type: "error", message: (err as Error).message });
    } finally {
      setSavingAccount(false);
    }
  }, [pat, addNotification]);

  const handleDisconnectAccount = useCallback(async () => {
    await api.integrations.disconnectAccount("github").catch(() => {});
    setHasPat(false);
    setPat("");
    setIssues([]);
    addNotification({ type: "info", message: "GitHub account disconnected" });
  }, [addNotification]);

  const handleSaveRepo = useCallback(async () => {
    setSavingRepo(true);
    try {
      await api.integrations.saveConfig("github", { owner, repo });
      addNotification({ type: "info", message: "Repository config saved" });
    } catch (err) {
      addNotification({ type: "error", message: (err as Error).message });
    } finally {
      setSavingRepo(false);
    }
  }, [owner, repo, addNotification]);

  const handleFetchIssues = useCallback(async () => {
    setLoadingIssues(true);
    try {
      const data = await api.integrations.github.listIssues(issueState);
      setIssues(data);
      setIssueLabelsMap(new Map(data.map((i) => [i.number, i.labels])));
    } catch (err) {
      addNotification({ type: "error", message: (err as Error).message });
    } finally {
      setLoadingIssues(false);
    }
  }, [issueState, addNotification]);

  const handleImport = useCallback(
    async (id: string | number) => {
      const num = id as number;
      setImportingId(num);
      const issue = issues.find((i) => i.number === num);
      if (!issue) return;
      try {
        const ticket = await api.integrations.github.importIssue(num);
        addTicket(ticket);
        addNotification({ type: "info", message: `Imported #${num} → backlog` });
      } catch (err) {
        addNotification({ type: "error", message: (err as Error).message });
      } finally {
        setImportingId(null);
      }
    },
    [issues, addTicket, addNotification],
  );

  return (
    <div className="flex flex-col gap-6">
      {/* ── Account (global) ── */}
      <div>
        <SectionLabel sub="global · ~/.agentforge/config.json">ACCOUNT</SectionLabel>
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <AccountBadge connected={hasPat} />
            {hasPat && (
              <button
                className="forge-btn-danger py-0.5 px-3 text-[10px]"
                onClick={handleDisconnectAccount}
              >
                DISCONNECT
              </button>
            )}
          </div>
          {!hasPat && (
            <div className="flex flex-col gap-2">
              <input
                type="password"
                className="forge-input"
                placeholder="ghp_…"
                value={pat}
                onChange={handlePatChange}
                onKeyDown={handlePatKeyDown}
              />
              <p className="text-forge-text-muted text-[10px]">
                Needs <code>repo</code> scope. Generate at GitHub → Settings → Developer settings →
                PATs.
              </p>
              <button
                className="forge-btn-primary py-1.5 px-4 self-start"
                onClick={handleConnectAccount}
                disabled={savingAccount || !pat}
              >
                {savingAccount ? "CONNECTING…" : "CONNECT"}
              </button>
            </div>
          )}
        </div>
      </div>

      {/* ── Repository (per-project) ── */}
      {hasPat && (
        <>
          <div className="h-px bg-forge-border" />
          <div>
            <SectionLabel sub="this project">REPOSITORY</SectionLabel>
            <div className="flex flex-col gap-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="forge-label mb-1.5 block">OWNER</label>
                  <input
                    className="forge-input"
                    placeholder="org-or-username"
                    value={owner}
                    onChange={handleOwnerChange}
                  />
                </div>
                <div>
                  <label className="forge-label mb-1.5 block">REPO</label>
                  <input
                    className="forge-input"
                    placeholder="repository-name"
                    value={repo}
                    onChange={handleRepoChange}
                  />
                </div>
              </div>
              <button
                className="forge-btn-ghost py-1.5 px-4 self-start"
                onClick={handleSaveRepo}
                disabled={savingRepo || !owner || !repo}
              >
                {savingRepo ? "SAVING…" : "SAVE"}
              </button>
            </div>
          </div>
        </>
      )}

      {/* ── Issues ── */}
      {hasPat && owner && repo && (
        <>
          <div className="h-px bg-forge-border" />
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-3">
              <span className="forge-label">ISSUES</span>
              <select
                className="forge-input w-auto py-0.5 px-2 text-xs"
                value={issueState}
                onChange={handleIssueStateChange}
              >
                <option value="open">Open</option>
                <option value="closed">Closed</option>
                <option value="all">All</option>
              </select>
              <button
                className="forge-btn-ghost py-0.5 px-3"
                onClick={handleFetchIssues}
                disabled={loadingIssues}
              >
                {loadingIssues ? "LOADING…" : "FETCH"}
              </button>
            </div>
            {issues.length > 0 ? (
              <div className="flex flex-col gap-1 max-h-56 overflow-y-auto">
                {issues.map((issue: GitHubIssue) => (
                  <div key={issue.number}>
                    <IssueRow
                      importId={issue.number}
                      label={`#${issue.number}`}
                      title={issue.title}
                      state={issue.state}
                      url={issue.url}
                      labels={issueLabelsMap.get(issue.number) ?? issue.labels}
                      importing={importingId === issue.number}
                      onImport={handleImport}
                    />
                  </div>
                ))}
              </div>
            ) : (
              !loadingIssues && (
                <p className="text-forge-text-muted text-xs">Click FETCH to load issues.</p>
              )
            )}
          </div>
        </>
      )}
    </div>
  );
}

// ─── Linear Tab ────────────────────────────────────────────────────────────

function LinearTab() {
  const { addNotification, addTicket } = useStore();

  const [pat, setPat] = useState("");
  const [hasPat, setHasPat] = useState(false);
  const [savingAccount, setSavingAccount] = useState(false);

  const [teams, setTeams] = useState<LinearTeam[]>([]);
  const [selectedTeamId, setSelectedTeamId] = useState("");
  const [savedTeamId, setSavedTeamId] = useState("");
  const [loadingTeams, setLoadingTeams] = useState(false);
  const [savingProject, setSavingProject] = useState(false);

  const [issues, setIssues] = useState<LinearIssue[]>([]);
  const [loadingIssues, setLoadingIssues] = useState(false);
  const [importingId, setImportingId] = useState<string | null>(null);

  // Precomputed label arrays per issue id
  const [issueLabelsMap, setIssueLabelsMap] = useState<Map<string, string[]>>(new Map());

  useEffect(() => {
    api.integrations
      .getConfig("linear")
      .then((cfg) => {
        setHasPat(cfg.hasPat);
        if (cfg.teamId) {
          setSelectedTeamId(cfg.teamId);
          setSavedTeamId(cfg.teamId);
        }
      })
      .catch(() => {});
  }, []);

  const handlePatChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => setPat(e.target.value),
    [],
  );
  const handleTeamChange = useCallback(
    (e: ChangeEvent<HTMLSelectElement>) => setSelectedTeamId(e.target.value),
    [],
  );
  const handlePatKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") void handleConnectAccount();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pat],
  );

  const handleConnectAccount = useCallback(async () => {
    if (!pat) return;
    setSavingAccount(true);
    try {
      await api.integrations.saveConfig("linear", { pat });
      setHasPat(true);
      setPat("");
      addNotification({ type: "info", message: "Linear account connected" });
    } catch (err) {
      addNotification({ type: "error", message: (err as Error).message });
    } finally {
      setSavingAccount(false);
    }
  }, [pat, addNotification]);

  const handleDisconnectAccount = useCallback(async () => {
    await api.integrations.disconnectAccount("linear").catch(() => {});
    setHasPat(false);
    setPat("");
    setTeams([]);
    setIssues([]);
    addNotification({ type: "info", message: "Linear account disconnected" });
  }, [addNotification]);

  const handleLoadTeams = useCallback(async () => {
    setLoadingTeams(true);
    try {
      const data = await api.integrations.linear.listTeams();
      setTeams(data);
    } catch (err) {
      addNotification({ type: "error", message: (err as Error).message });
    } finally {
      setLoadingTeams(false);
    }
  }, [addNotification]);

  const handleSaveProject = useCallback(async () => {
    setSavingProject(true);
    try {
      await api.integrations.saveConfig("linear", { teamId: selectedTeamId });
      setSavedTeamId(selectedTeamId);
      addNotification({ type: "info", message: "Project config saved" });
    } catch (err) {
      addNotification({ type: "error", message: (err as Error).message });
    } finally {
      setSavingProject(false);
    }
  }, [selectedTeamId, addNotification]);

  const handleFetchIssues = useCallback(async () => {
    setLoadingIssues(true);
    try {
      const data = await api.integrations.linear.listIssues();
      setIssues(data);
      setIssueLabelsMap(
        new Map(data.map((i) => [i.id, [priorityLabel(i.priority), ...i.labels].filter(Boolean)])),
      );
    } catch (err) {
      addNotification({ type: "error", message: (err as Error).message });
    } finally {
      setLoadingIssues(false);
    }
  }, [addNotification]);

  const handleImport = useCallback(
    async (id: string | number) => {
      const issueId = id as string;
      setImportingId(issueId);
      const issue = issues.find((i) => i.id === issueId);
      if (!issue) return;
      try {
        const ticket = await api.integrations.linear.importIssue(issueId);
        addTicket(ticket);
        addNotification({ type: "info", message: `Imported ${issue.identifier} → backlog` });
      } catch (err) {
        addNotification({ type: "error", message: (err as Error).message });
      } finally {
        setImportingId(null);
      }
    },
    [issues, addTicket, addNotification],
  );

  const teamLabel = savedTeamId
    ? (teams.find((t) => t.id === savedTeamId)?.name ?? savedTeamId)
    : "All teams";

  return (
    <div className="flex flex-col gap-6">
      {/* ── Account (global) ── */}
      <div>
        <SectionLabel sub="global · ~/.agentforge/config.json">ACCOUNT</SectionLabel>
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <AccountBadge connected={hasPat} />
            {hasPat && (
              <button
                className="forge-btn-danger py-0.5 px-3 text-[10px]"
                onClick={handleDisconnectAccount}
              >
                DISCONNECT
              </button>
            )}
          </div>
          {!hasPat && (
            <div className="flex flex-col gap-2">
              <input
                type="password"
                className="forge-input"
                placeholder="lin_api_…"
                value={pat}
                onChange={handlePatChange}
                onKeyDown={handlePatKeyDown}
              />
              <p className="text-forge-text-muted text-[10px]">
                Personal API key from Linear → Settings → API.
              </p>
              <button
                className="forge-btn-primary py-1.5 px-4 self-start"
                onClick={handleConnectAccount}
                disabled={savingAccount || !pat}
              >
                {savingAccount ? "CONNECTING…" : "CONNECT"}
              </button>
            </div>
          )}
        </div>
      </div>

      {/* ── Project (per-project) ── */}
      {hasPat && (
        <>
          <div className="h-px bg-forge-border" />
          <div>
            <SectionLabel sub="this project">PROJECT</SectionLabel>
            <div className="flex flex-col gap-3">
              <div className="flex items-center gap-2">
                <label className="forge-label">TEAM</label>
                <span className="text-forge-text-dim text-xs">{teamLabel}</span>
                <button
                  className="forge-btn-ghost py-0 px-2 text-[10px] ml-auto"
                  onClick={handleLoadTeams}
                  disabled={loadingTeams}
                >
                  {loadingTeams ? "…" : "LOAD TEAMS"}
                </button>
              </div>
              {teams.length > 0 && (
                <select className="forge-input" value={selectedTeamId} onChange={handleTeamChange}>
                  <option value="">All teams</option>
                  {teams.map((t: LinearTeam) => (
                    <option key={t.id} value={t.id}>
                      [{t.key}] {t.name}
                    </option>
                  ))}
                </select>
              )}
              <button
                className="forge-btn-ghost py-1.5 px-4 self-start"
                onClick={handleSaveProject}
                disabled={savingProject}
              >
                {savingProject ? "SAVING…" : "SAVE"}
              </button>
            </div>
          </div>
        </>
      )}

      {/* ── Issues ── */}
      {hasPat && (
        <>
          <div className="h-px bg-forge-border" />
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-3">
              <span className="forge-label">ISSUES</span>
              <button
                className="forge-btn-ghost py-0.5 px-3"
                onClick={handleFetchIssues}
                disabled={loadingIssues}
              >
                {loadingIssues ? "LOADING…" : "FETCH"}
              </button>
            </div>
            {issues.length > 0 ? (
              <div className="flex flex-col gap-1 max-h-56 overflow-y-auto">
                {issues.map((issue: LinearIssue) => (
                  <div key={issue.id}>
                    <IssueRow
                      importId={issue.id}
                      label={issue.identifier}
                      title={issue.title}
                      state={issue.state}
                      url={issue.url}
                      labels={issueLabelsMap.get(issue.id) ?? issue.labels}
                      importing={importingId === issue.id}
                      onImport={handleImport}
                    />
                  </div>
                ))}
              </div>
            ) : (
              !loadingIssues && (
                <p className="text-forge-text-muted text-xs">Click FETCH to load issues.</p>
              )
            )}
          </div>
        </>
      )}
    </div>
  );
}

// ─── Modal ─────────────────────────────────────────────────────────────────

interface IntegrationsModalProps {
  open: boolean;
  onClose: () => void;
}

export function IntegrationsModal({ open, onClose }: IntegrationsModalProps) {
  const [tab, setTab] = useState<Tab>("github");

  const handleBackdrop = useCallback(
    (e: MouseEvent<HTMLDivElement>) => {
      if (e.target === e.currentTarget) onClose();
    },
    [onClose],
  );

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      if (e.key === "Escape") onClose();
    },
    [onClose],
  );

  const setGitHub = useCallback(() => setTab("github"), []);
  const setLinear = useCallback(() => setTab("linear"), []);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 animate-fade-in"
      onClick={handleBackdrop}
      onKeyDown={handleKeyDown}
    >
      <div className="forge-panel w-[560px] max-h-[85vh] flex flex-col animate-fade-in">
        <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-forge-border shrink-0">
          <span className="forge-label">INTEGRATIONS</span>
          <button className="text-forge-text-muted hover:text-forge-text" onClick={onClose}>
            <X size={13} />
          </button>
        </div>

        <div className="flex border-b border-forge-border shrink-0">
          <TabButton active={tab === "github"} onClick={setGitHub}>
            <SiGithub size={11} />
            GITHUB
          </TabButton>
          <TabButton active={tab === "linear"} onClick={setLinear}>
            <SiLinear size={11} />
            LINEAR
          </TabButton>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-5">
          {tab === "github" ? <GitHubTab /> : <LinearTab />}
        </div>
      </div>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      className={`flex items-center gap-1.5 px-5 py-2.5 text-xs uppercase tracking-widest border-b-2 transition-colors font-mono ${
        active
          ? "border-forge-accent text-forge-accent"
          : "border-transparent text-forge-text-dim hover:text-forge-text"
      }`}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
