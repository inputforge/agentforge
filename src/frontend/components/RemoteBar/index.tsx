import { Download, GitBranch, Settings, Upload, Wifi } from 'lucide-react'
import { useEffect, useState } from 'react'
import { api } from '../../lib/api'
import { useStore } from '../../store'

export function RemoteBar() {
  const { remoteConfig, setRemoteConfig, addNotification } = useStore()
  const [isExpanded, setIsExpanded] = useState(false)
  const [repoUrl, setRepoUrl] = useState(remoteConfig?.repoUrl ?? '')
  const [baseBranch, setBaseBranch] = useState(remoteConfig?.baseBranch ?? 'main')
  const [localPath, setLocalPath] = useState(remoteConfig?.localPath ?? '')
  const [isCloning, setIsCloning] = useState(false)
  const [isPulling, setIsPulling] = useState(false)
  const [isPushing, setIsPushing] = useState(false)
  const [isDetecting, setIsDetecting] = useState(false)

  // Load persisted config from backend on mount
  useEffect(() => {
    api.remote.getConfig().then((cfg) => {
      if (cfg) {
        setRemoteConfig(cfg)
        setRepoUrl(cfg.repoUrl)
        setBaseBranch(cfg.baseBranch)
        setLocalPath(cfg.localPath)
      }
    }).catch(() => {})
  }, [])

  async function handleDetectAt(path?: string) {
    setIsDetecting(true)
    try {
      const detected = await api.remote.detect(path)
      setRemoteConfig(detected)
      setRepoUrl(detected.repoUrl)
      setBaseBranch(detected.baseBranch)
      setLocalPath(detected.localPath)
      addNotification({
        type: 'info',
        message: `Detected: ${detected.localPath} on branch "${detected.baseBranch}"`,
      })
      setIsExpanded(false)
    } catch (err) {
      addNotification({ type: 'error', message: (err as Error).message })
    } finally {
      setIsDetecting(false)
    }
  }

  async function handleClone() {
    if (!repoUrl || !localPath) return
    setIsCloning(true)
    try {
      const config = { repoUrl, baseBranch, localPath }
      await api.remote.clone(config)
      setRemoteConfig(config)
      addNotification({ type: 'info', message: `Cloned ${repoUrl} → ${localPath}` })
      setIsExpanded(false)
    } catch (err) {
      addNotification({ type: 'error', message: (err as Error).message })
    } finally {
      setIsCloning(false)
    }
  }

  async function handlePull() {
    if (!remoteConfig) return
    setIsPulling(true)
    try {
      await api.remote.pull(remoteConfig.localPath)
      addNotification({ type: 'info', message: `Pulled latest from ${remoteConfig.baseBranch}` })
    } catch (err) {
      addNotification({ type: 'error', message: (err as Error).message })
    } finally {
      setIsPulling(false)
    }
  }

  async function handlePush() {
    if (!remoteConfig) return
    setIsPushing(true)
    try {
      await api.remote.push(remoteConfig.baseBranch, remoteConfig.localPath)
      addNotification({ type: 'info', message: `Pushed ${remoteConfig.baseBranch}` })
    } catch (err) {
      addNotification({ type: 'error', message: (err as Error).message })
    } finally {
      setIsPushing(false)
    }
  }

  return (
    <div className="relative">
      {/* Toolbar row */}
      <div className="flex items-center gap-2">
        {remoteConfig ? (
          <>
            <GitBranch size={11} className="text-forge-text-dim" />
            <span className="text-forge-amber text-xs truncate max-w-[200px]">
              {remoteConfig.repoUrl.replace(/^https?:\/\//, '')}
            </span>
            <span className="text-forge-text-muted text-xs">/</span>
            <span className="text-forge-text text-xs">{remoteConfig.baseBranch}</span>
            <button
              className="forge-btn-ghost py-0.5 px-2 flex items-center gap-1"
              onClick={handlePull}
              disabled={isPulling}
            >
              <Download size={11} />
              {isPulling ? '...' : 'PULL'}
            </button>
            <button
              className="forge-btn-ghost py-0.5 px-2 flex items-center gap-1"
              onClick={handlePush}
              disabled={isPushing}
            >
              <Upload size={11} />
              {isPushing ? '...' : 'PUSH'}
            </button>
          </>
        ) : (
          <span className="text-forge-text-muted text-xs uppercase tracking-widest">
            NO REMOTE
          </span>
        )}
        <button
          className="forge-btn-ghost py-0.5 px-2 flex items-center gap-1"
          onClick={() => handleDetectAt()}
          disabled={isDetecting}
          title="Auto-detect git repo from backend CWD or REPO_PATH"
        >
          <Wifi size={11} />
          {isDetecting ? '...' : 'DETECT'}
        </button>

        <button
          className="forge-btn-ghost py-0.5 px-2 flex items-center gap-1"
          onClick={() => setIsExpanded((v) => !v)}
        >
          <Settings size={11} />
          {isExpanded ? 'CLOSE' : 'CONFIG'}
        </button>
      </div>

      {/* Expanded config panel */}
      {isExpanded && (
        <div className="absolute top-full right-0 mt-1 w-[480px] forge-panel p-4 z-30 animate-fade-in">
          <p className="forge-label mb-3">REMOTE CONFIGURATION</p>
          <div className="flex flex-col gap-2">
            {/* Auto-detect shortcut */}
            <div className="flex gap-2 items-end">
              <div className="flex-1">
                <label className="forge-label mb-1 block">DETECT FROM PATH</label>
                <input
                  className="forge-input"
                  placeholder="leave empty to use backend CWD"
                  value={localPath}
                  onChange={(e) => setLocalPath(e.target.value)}
                />
              </div>
              <button
                className="forge-btn-ghost py-2 px-3 flex-shrink-0"
                onClick={() => handleDetectAt(localPath || undefined)}
                disabled={isDetecting}
              >
                {isDetecting ? '...' : 'DETECT'}
              </button>
            </div>

            <div className="border-t border-forge-border pt-2">
              <p className="forge-label mb-2">OR CLONE A REMOTE</p>
              <div className="flex flex-col gap-2">
                <div>
                  <label className="forge-label mb-1 block">REPO URL</label>
                  <input
                    className="forge-input"
                    placeholder="https://github.com/user/repo.git"
                    value={repoUrl}
                    onChange={(e) => setRepoUrl(e.target.value)}
                  />
                </div>
                <div className="flex gap-2">
                  <div className="flex-1">
                    <label className="forge-label mb-1 block">BASE BRANCH</label>
                    <input
                      className="forge-input"
                      placeholder="main"
                      value={baseBranch}
                      onChange={(e) => setBaseBranch(e.target.value)}
                    />
                  </div>
                  <div className="flex-1">
                    <label className="forge-label mb-1 block">LOCAL PATH</label>
                    <input
                      className="forge-input"
                      placeholder="/path/to/clone"
                      value={localPath}
                      onChange={(e) => setLocalPath(e.target.value)}
                    />
                  </div>
                </div>
                <button
                  className="forge-btn-primary py-1.5"
                  onClick={handleClone}
                  disabled={isCloning || !repoUrl || !localPath}
                >
                  {isCloning ? 'CLONING...' : 'CLONE REPOSITORY'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
