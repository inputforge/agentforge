import { SiBitbucket, SiGit, SiGithub, SiGitlab } from "@icons-pack/react-simple-icons";
import { GitBranch, RefreshCw, Upload } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { api } from "../lib/api";
import { useStore } from "../store";

function repoIcon(url: string) {
  const props = { className: "flex-shrink-0", size: 12 };
  if (/github\.com/i.test(url)) {
    return <SiGithub {...props} />;
  }
  if (/gitlab\.com/i.test(url)) {
    return <SiGitlab {...props} />;
  }
  if (/bitbucket\.(org|com)/i.test(url)) {
    return <SiBitbucket {...props} />;
  }
  return <SiGit {...props} />;
}

function parseRepo(url: string): { label: string; href?: string } {
  try {
    // SSH: git@github.com:org/repo.git
    const ssh = url.match(/^git@([\w.-]+):([\w./-]+?)(?:\.git)?$/);
    if (ssh) {
      const [, host, path] = ssh;
      const isKnown = /github\.com|gitlab\.com|bitbucket\.(org|com)/i.test(host);
      return {
        href: isKnown ? `https://${host}/${path}` : undefined,
        label: path,
      };
    }
    const parsed = new URL(url);
    const label = parsed.pathname.replace(/^\//, "").replace(/\.git$/, "");
    const isKnown = /github\.com|gitlab\.com|bitbucket\.(org|com)/i.test(parsed.hostname);
    const href = isKnown ? `https://${parsed.host}/${label}` : undefined;
    return { href, label };
  } catch {
    return { label: url };
  }
}

export function RemoteBar() {
  const { remoteConfig, setRemoteConfig, currentBranch, setCurrentBranch, addNotification } =
    useStore();
  const [isPushing, setIsPushing] = useState(false);

  const handlePush = useCallback(async () => {
    if (!remoteConfig || !currentBranch) {
      return;
    }
    setIsPushing(true);
    try {
      await api.remote.push(currentBranch, remoteConfig.localPath);
      // Push has no other visible effect in this UI — nothing on screen changes the way
      // a merge (ticket moves to done) or commit (diff shrinks) does — so unlike those,
      // silence here would look identical to nothing having happened at all.
      addNotification({ message: `Pushed ${currentBranch} to origin`, type: "info" });
    } catch (error) {
      addNotification({ message: `Push failed: ${(error as Error).message}`, type: "error" });
    } finally {
      setIsPushing(false);
    }
  }, [remoteConfig, currentBranch, addNotification]);

  useEffect(() => {
    api.remote
      .getConfig()
      .then((cfg) => {
        if (cfg) {
          setRemoteConfig(cfg);
        }
      })
      .catch(() => {
        /* empty */
      });
  }, [setRemoteConfig]);

  // Fetch initial branch once; subsequent updates come via WS push
  useEffect(() => {
    if (!remoteConfig) {
      return;
    }
    api.remote
      .getBranch()
      .then(({ branch }) => setCurrentBranch(branch))
      .catch(() => {
        /* empty */
      });
  }, [remoteConfig, setCurrentBranch]);

  if (!remoteConfig) {
    return (
      <span className="text-forge-text-muted text-xs uppercase tracking-widest">NO REMOTE</span>
    );
  }

  const { label, href } = parseRepo(remoteConfig.repoUrl);

  return (
    <div className="flex items-center gap-2 text-forge-text-dim">
      {repoIcon(remoteConfig.repoUrl)}
      {href ? (
        <a
          href={href}
          target="_blank"
          rel="noreferrer"
          className="text-forge-accent text-xs truncate max-w-[220px] hover:underline"
        >
          {label}
        </a>
      ) : (
        <span className="text-forge-accent text-xs truncate max-w-[220px]">{label}</span>
      )}
      {currentBranch && (
        <>
          <span className="text-forge-border">·</span>
          <GitBranch size={11} className="flex-shrink-0" />
          <span className="text-forge-text-dim text-xs">HEAD {currentBranch}</span>
          <button
            className="forge-btn-ghost py-0.5 px-1.5 flex items-center gap-1 disabled:opacity-50"
            onClick={handlePush}
            disabled={isPushing}
            title={`Push ${currentBranch} to origin`}
          >
            {isPushing ? <RefreshCw size={11} className="animate-spin" /> : <Upload size={11} />}
            <span className="text-xs">{isPushing ? "PUSHING…" : "PUSH"}</span>
          </button>
        </>
      )}
    </div>
  );
}
