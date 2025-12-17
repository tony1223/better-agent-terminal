interface AboutPanelProps {
  onClose: () => void
}

export function AboutPanel({ onClose }: AboutPanelProps) {
  const handleLinkClick = (url: string) => {
    window.electronAPI.shell.openExternal(url)
  }

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-panel about-panel" onClick={e => e.stopPropagation()}>
        <div className="settings-header">
          <h2>About</h2>
          <button className="close-btn" onClick={onClose}>×</button>
        </div>

        <div className="settings-content about-content">
          <div className="about-logo">
            <span className="about-icon">⬛</span>
            <h1>Better Agent Terminal</h1>
          </div>

          <p className="about-description">
            A Windows terminal aggregator with multi-workspace support and Claude Code integration.
          </p>

          <div className="about-info">
            <div className="about-row">
              <span className="about-label">Author</span>
              <span className="about-value">TonyQ</span>
            </div>
            <div className="about-row">
              <span className="about-label">GitHub</span>
              <a
                href="#"
                className="about-link"
                onClick={(e) => {
                  e.preventDefault()
                  handleLinkClick('https://github.com/tony1223/better-agent-terminal')
                }}
              >
                github.com/tony1223/better-agent-terminal
              </a>
            </div>
          </div>

          <div className="about-credits">
            <p>Built with Electron, React, and xterm.js</p>
          </div>
        </div>
      </div>
    </div>
  )
}
