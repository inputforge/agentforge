import { SiGithub, SiLinear } from "@icons-pack/react-simple-icons";
import { ExternalLink, Import, X } from "lucide-react";
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

// ─── GitHub Tab ────────────────────────────────────────────────────────────

function GitHubTab() {
  const { addNotification, addTicket } = useStore();
  const [pat, setPat] = useState("");
  const [owner, setOwner] = useState("");
  const [repo, setRepo] = useState("");
  const [hasPat, setHasPat] = useState(false);
  const [issues, setIssues] = useState<GitHubIssue[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [importingId, setImportingId] = useState<number | null>(null);
  const [issueState, setIssueState] = useState<"open" | "closed" | "all">("open");

  useEffect(() => {
    api.integrations.getConfig("github").then((cfg) => {
      setHasPat(cfg.hasPat);
      if (cfg.owner) setOwner(cfg.owner);
      if (cfg.repo) setRepo(cfg.repo);
    }).catch(() => {});
  }, []);

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      const data: Record<string, string> = { owner, repo };
      if (pat) data.pat = pat;
      await api.integrations.saveConfig("github", data);
      setHasPat(true);
      setPat("");
      addNotification({ type: "info", message: "GitHub config saved" });
    } catch (err) {
      addNotification({ type: "error", message: (err as Error).message });
    } finally {
      setSaving(false);
    }
  }, [pat, owner, repo, addNotification]);

  const handleDisconnect = useCallback(async () => {
    await api.integrations.deleteConfig("github").catch(() => {});
    setHasPat(false);
    setPat("");
    setOwner("");
    setRepo("");
    setIssues([]);
    addNotification({ type: "info", message: "GitHub disconnected" });
  }, [addNotification]);

  const handleFetchIssues = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.integrations.github.listIssues(issueState);
      setIssues(data);
    } catch (err) {
      addNotification({ type: "error", message: (err as Error).message });
    } finally {
      setLoading(false);
    }
  }, [issueState, addNotification]);

  const handleImport = useCallback(
    async (issue: GitHubIssue) => {
      setImportingId(issue.number);
      try {
        const ticket = await api.integrations.github.importIssue(issue.number);
        addTicket(ticket);
        addNotification({ type: "info", message: `Imported #${issue.number} → backlog` });
      } catch (err) {
        addNotification({ type: "error", message: (err as Error).message });
      } finally {
        setImportingId(null);
      }
    },
    [addTicket, addNotification],
  );

  return (
    <div className="flex flex-col gap-5">
      {/* Config */}
      <div className="flex flex-col gap-3">
        <div>
          <label className="forge-label mb-1.5 block">PERSONAL ACCESS TOKEN</label>
          <input
            type="password"
            className="forge-input"
            placeholder={hasPat ? "••••••••••••••••••••• (saved)" : "ghp_…"}
            value={pat}
            onChange={(e: ChangeEvent<HTMLInputElement>) => setPat(e.target.value)}
          />
          <p className="text-forge-text-muted text-[10px] mt-1">
            Needs <code>repo</code> scope to read issues.
          </p>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="forge-label mb-1.5 block">OWNER</label>
            <input
              className="forge-input"
              placeholder="org-or-username"
              value={owner}
              onChange={(e: ChangeEvent<HTMLInputElement>) => setOwner(e.target.value)}
            />
          </div>
          <div>
            <label className="forge-label mb-1.5 block">REPO</label>
            <input
              className="forge-input"
              placeholder="repository-name"
              value={repo}
              onChange={(e: ChangeEvent<HTMLInputElement>) => setRepo(e.target.value)}
            />
          </div>
        </div>
        <div className="flex gap-2">
          <button
            className="forge-btn-primary py-1.5 px-4"
            onClick={handleSave}
            disabled={saving || (!pat && !hasPat) || !owner || !repo}
          >
            {saving ? "SAVING…" : hasPat ? "UPDATE" : "CONNECT"}
          </button>
          {hasPat && (
            <button className="forge-btn-danger py-1.5 px-4" onClick={handleDisconnect}>
              DISCONNECT
            </button>
          )}
        </div>
      </div>

      {/* Issues */}
      {hasPat && (
        <>
          <div className="h-px bg-forge-border" />
          <div className="flex items-center gap-3">
            <span className="forge-label">ISSUES</span>
            <select
              className="forge-input w-auto py-0.5 px-2 text-xs"
              value={issueState}
              onChange={(e: ChangeEvent<HTMLSelectElement>) =>
                setIssueState(e.target.value as typeof issueState)
              }
            >
              <option value="open">Open</option>
              <option value="closed">Closed</option>
              <option value="all">All</option>
            </select>
            <button
              className="forge-btn-ghost py-0.5 px-3"
              onClick={handleFetchIssues}
              disabled={loading}
            >
              {loading ? "LOADING…" : "FETCH"}
            </button>
          </div>
          {issues.length > 0 && (
            <div className="flex flex-col gap-1 max-h-64 overflow-y-auto">
              {issues.map((issue: GitHubIssue) => (
                <div key={issue.number}>
                  <IssueRow
                    label={`#${issue.number}`}
                    title={issue.title}
                    state={issue.state}
                    url={issue.url}
                    labels={issue.labels}
                    importing={importingId === issue.number}
                    onImport={() => { void handleImport(issue); }}
                  />
                </div>
              ))}
            </div>
          )}
          {issues.length === 0 && !loading && (
            <p className="text-forge-text-muted text-xs">Click FETCH to load issues.</p>
          )}
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
  const [teams, setTeams] = useState<LinearTeam[]>([]);
  const [selectedTeamId, setSelectedTeamId] = useState("");
  const [savedTeamId, setSavedTeamId] = useState("");
  const [issues, setIssues] = useState<LinearIssue[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [importingId, setImportingId] = useState<string | null>(null);

  useEffect(() => {
    api.integrations.getConfig("linear").then((cfg) => {
      setHasPat(cfg.hasPat);
      if (cfg.teamId) {
        setSelectedTeamId(cfg.teamId);
        setSavedTeamId(cfg.teamId);
      }
    }).catch(() => {});
  }, []);

  const handleFetchTeams = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.integrations.linear.listTeams();
      setTeams(data);
    } catch (err) {
      addNotification({ type: "error", message: (err as Error).message });
    } finally {
      setLoading(false);
    }
  }, [addNotification]);

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      const data: Record<string, string> = {};
      if (pat) data.pat = pat;
      if (selectedTeamId) data.teamId = selectedTeamId;
      await api.integrations.saveConfig("linear", data);
      setHasPat(true);
      setSavedTeamId(selectedTeamId);
      setPat("");
      addNotification({ type: "info", message: "Linear config saved" });
    } catch (err) {
      addNotification({ type: "error", message: (err as Error).message });
    } finally {
      setSaving(false);
    }
  }, [pat, selectedTeamId, addNotification]);

  const handleDisconnect = useCallback(async () => {
    await api.integrations.deleteConfig("linear").catch(() => {});
    setHasPat(false);
    setPat("");
    setTeams([]);
    setSelectedTeamId("");
    setSavedTeamId("");
    setIssues([]);
    addNotification({ type: "info", message: "Linear disconnected" });
  }, [addNotification]);

  const handleFetchIssues = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.integrations.linear.listIssues();
      setIssues(data);
    } catch (err) {
      addNotification({ type: "error", message: (err as Error).message });
    } finally {
      setLoading(false);
    }
  }, [addNotification]);

  const handleImport = useCallback(
    async (issue: LinearIssue) => {
      setImportingId(issue.id);
      try {
        const ticket = await api.integrations.linear.importIssue(issue.id);
        addTicket(ticket);
        addNotification({ type: "info", message: `Imported ${issue.identifier} → backlog` });
      } catch (err) {
        addNotification({ type: "error", message: (err as Error).message });
      } finally {
        setImportingId(null);
      }
    },
    [addTicket, addNotification],
  );

  const priorityLabel = (p: number) =>
    (["No priority", "Urgent", "High", "Medium", "Low"] as const)[p] ?? "Unknown";

  return (
    <div className="flex flex-col gap-5">
      {/* Config */}
      <div className="flex flex-col gap-3">
        <div>
          <label className="forge-label mb-1.5 block">API KEY</label>
          <input
            type="password"
            className="forge-input"
            placeholder={hasPat ? "••••••••••••••••••••• (saved)" : "lin_api_…"}
            value={pat}
            onChange={(e: ChangeEvent<HTMLInputElement>) => setPat(e.target.value)}
          />
          <p className="text-forge-text-muted text-[10px] mt-1">
            Personal API key from Linear → Settings → API.
          </p>
        </div>

        {/* Team picker */}
        {hasPat && (
          <div>
            <div className="flex items-center gap-2 mb-1.5">
              <label className="forge-label">TEAM (OPTIONAL)</label>
              <button
                className="forge-btn-ghost py-0 px-2 text-[10px]"
                onClick={handleFetchTeams}
                disabled={loading}
              >
                {loading ? "…" : "LOAD TEAMS"}
              </button>
            </div>
            {teams.length > 0 ? (
              <select
                className="forge-input"
                value={selectedTeamId}
                onChange={(e: ChangeEvent<HTMLSelectElement>) => setSelectedTeamId(e.target.value)}
              >
                <option value="">All teams</option>
                {teams.map((t: LinearTeam) => (
                  <option key={t.id} value={t.id}>
                    [{t.key}] {t.name}
                  </option>
                ))}
              </select>
            ) : (
              <p className="text-forge-text-muted text-xs">
                {savedTeamId
                  ? `Team ID: ${savedTeamId}`
                  : "No team selected — will load all issues."}
              </p>
            )}
          </div>
        )}

        <div className="flex gap-2">
          <button
            className="forge-btn-primary py-1.5 px-4"
            onClick={handleSave}
            disabled={saving || (!pat && !hasPat)}
          >
            {saving ? "SAVING…" : hasPat ? "UPDATE" : "CONNECT"}
          </button>
          {hasPat && (
            <button className="forge-btn-danger py-1.5 px-4" onClick={handleDisconnect}>
              DISCONNECT
            </button>
          )}
        </div>
      </div>

      {/* Issues */}
      {hasPat && (
        <>
          <div className="h-px bg-forge-border" />
          <div className="flex items-center gap-3">
            <span className="forge-label">ISSUES</span>
            <button
              className="forge-btn-ghost py-0.5 px-3"
              onClick={handleFetchIssues}
              disabled={loading}
            >
              {loading ? "LOADING…" : "FETCH"}
            </button>
          </div>
          {issues.length > 0 && (
            <div className="flex flex-col gap-1 max-h-64 overflow-y-auto">
              {issues.map((issue: LinearIssue) => (
                <div key={issue.id}>
                  <IssueRow
                    label={issue.identifier}
                    title={issue.title}
                    state={issue.state}
                    url={issue.url}
                    labels={[priorityLabel(issue.priority), ...issue.labels].filter(Boolean)}
                    importing={importingId === issue.id}
                    onImport={() => { void handleImport(issue); }}
                  />
                </div>
              ))}
            </div>
          )}
          {issues.length === 0 && !loading && (
            <p className="text-forge-text-muted text-xs">Click FETCH to load issues.</p>
          )}
        </>
      )}
    </div>
  );
}

// ─── Shared IssueRow ───────────────────────────────────────────────────────

function IssueRow({
  label,
  title,
  state,
  url,
  labels,
  importing,
  onImport,
}: {
  label: string;
  title: string;
  state: string;
  url: string;
  labels: string[];
  importing: boolean;
  onImport: () => void;
}) {
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
          onClick={onImport}
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

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 animate-fade-in"
      onClick={handleBackdrop}
      onKeyDown={handleKeyDown}
    >
      <div className="forge-panel w-[560px] max-h-[80vh] flex flex-col animate-fade-in">
        {/* Header */}
        <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-forge-border shrink-0">
          <span className="forge-label">INTEGRATIONS</span>
          <button className="text-forge-text-muted hover:text-forge-text" onClick={onClose}>
            <X size={13} />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-forge-border shrink-0">
          <TabButton active={tab === "github"} onClick={() => setTab("github")}>
            <SiGithub size={11} />
            GITHUB
          </TabButton>
          <TabButton active={tab === "linear"} onClick={() => setTab("linear")}>
            <SiLinear size={11} />
            LINEAR
          </TabButton>
        </div>

        {/* Content */}
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
