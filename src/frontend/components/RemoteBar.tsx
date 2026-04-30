import { SiBitbucket, SiGit, SiGithub, SiGitlab } from "@icons-pack/react-simple-icons";
import { GitBranch } from "lucide-react";
import { useEffect } from "react";
import { api } from "../lib/api";
import { useStore } from "../store";

function repoIcon(url: string) {
  const props = { size: 12, className: "flex-shrink-0" };
  if (/github\.com/i.test(url)) return <SiGithub {...props} />;
  if (/gitlab\.com/i.test(url)) return <SiGitlab {...props} />;
  if (/bitbucket\.(org|com)/i.test(url)) return <SiBitbucket {...props} />;
  return <SiGit {...props} />;
}

function parseRepo(url: string): { label: string; href?: string } {
  try {
    // SSH: git@github.com:org/repo.git
    const ssh = url.match(/^git@([\w.-]+):([\w./-]+?)(?:\.git)?$/);
    if (ssh) {
      const [, host, path] = ssh;
      const isKnown = /github\.com|gitlab\.com|bitbucket\.(org|com)/i.test(host);
      return { label: path, href: isKnown ? `https://${host}/${path}` : undefined };
    }
    const parsed = new URL(url);
    const label = parsed.pathname.replace(/^\//, "").replace(/\.git$/, "");
    const isKnown = /github\.com|gitlab\.com|bitbucket\.(org|com)/i.test(parsed.hostname);
    const href = isKnown ? `https://${parsed.host}/${label}` : undefined;
    return { label, href };
  } catch {
    return { label: url };
  }
}

export function RemoteBar() {
  const { remoteConfig, setRemoteConfig, currentBranch, setCurrentBranch } = useStore();

  useEffect(() => {
    api.remote
      .getConfig()
      .then((cfg) => {
        if (cfg) setRemoteConfig(cfg);
      })
      .catch(() => {});
  }, [setRemoteConfig]);

  // Fetch initial branch once; subsequent updates come via WS push
  useEffect(() => {
    if (!remoteConfig) return;
    api.remote
      .getBranch()
      .then(({ branch }) => setCurrentBranch(branch))
      .catch(() => {});
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
        </>
      )}
    </div>
  );
}
