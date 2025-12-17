# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.26.1] - 2025-12-17

### Fixed
- **IME duplicate text issue**: Fixed Chinese/Japanese/Korean input causing duplicate characters
- **Theme contrast**: Improved background and text colors for better readability

### Changed
- Updated Novel theme with lighter background (`#282520`) for better contrast
- Updated terminal ANSI colors for improved visibility

## [1.26.0] - 2025-12-17

### Added
- **Collapsible Sidebar**: Click the `‹` button in the sidebar header to collapse the left panel for a wider workspace
- **Collapsible Terminal Bar**: Click the `▼` button in the terminal bar header to collapse the bottom panel
- Smooth CSS transitions for collapse/expand animations

### Changed
- Sidebar header now shows toggle button alongside "Workspaces" text
- Terminal bar header now shows toggle button alongside "Terminals" text

## [1.25.0] - 2025-12-17

### Added
- macOS and Linux support (cross-platform)
- Workspace roles with color-coded badges (Iris, PM, Dev, Test, Prod, custom roles)
- About panel with author and GitHub link
- Custom app icon (magical book design)

### Fixed
- IME candidate box positioning for CJK input
- Terminal resize issues when switching workspaces

## [1.24.0] - 2025-12-17

### Added
- Workspace rename functionality (double-click to rename)
- Settings panel for shell configuration
- Terminal restart button
- Copy/paste context menu support
- Activity indicators for terminals

## [1.0.0] - 2025-12-17

### Added
- Initial release
- Multi-workspace terminal management
- Claude Code integration with dedicated terminal
- Thumbnail bar for terminal preview
- Persistent workspace storage
- Novel theme (macOS Terminal.app inspired)
