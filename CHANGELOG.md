# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.6.3] - 2026-01-09

### Added
- **Markdown editing feature** with `--enable-edit` parameter
  - In-browser editor with line numbers and syntax highlighting
  - Press `e` to open editor or click "Edit" button in selection toolbar
  - Auto-jump to source when selecting text in view mode
  - Smart text matching with Markdown syntax awareness
  - `Ctrl/Cmd+S` to save, asterisk (*) in title indicates unsaved changes
  - GitHub-style syntax highlighting for both light and dark themes
  - Security: Only `.md` files within start directory can be edited
- **Smart `--host` parameter** for flexible network binding (#18)
  - No `--host`: Binds to `127.0.0.1` (localhost only, secure by default)
  - `--host`: Interactive selection from available network interfaces
  - `--host <IP>`: Binds to specific IP address (e.g., `--host 0.0.0.0` for LAN access)
- Interactive network interface selector with arrow key navigation
- Automatic detection of all local IP addresses and network interfaces

### Changed
- Server binding is now configurable instead of hardcoded to `127.0.0.1`
- Improved user experience for sharing Markon with team members on LAN

### Fixed
- Unable to access Markon via LAN IP address (#18)

### Dependencies
- Added `local-ip-address` 0.6 for network interface discovery
- Added `dialoguer` 0.11 for interactive selection

## [0.6.2] - 2026-01-08

### Added
- Mobile section printing functionality using new window + Blob URL approach
- Auto-fetching and inlining of CSS styles for print documents
- Friendly instruction banner for mobile users (auto-fades after 5 seconds)
- Desktop auto-print capability in print preview window
- Print button in root toolbar (alongside Collapse All | Expand All)

### Changed
- Mobile devices now open print content in new tab/window instead of showing disabled message
- Desktop browsers continue using iframe method for optimal UX
- Print functionality now works on both mobile and desktop platforms

### Technical Details
- Implemented hybrid printing strategy: iframe for desktop, new window for mobile
- Blob URL used for unlimited document size support (vs Data URL's 2-10MB limit)
- CSS files (`github-markdown-light.css`, `github-print.css`) fetched and inlined to avoid external resource loading issues
- Popup blocker handling with user-friendly alert message
- Automatic Blob URL cleanup after 2 seconds to prevent memory leaks

### Documentation
- Added comprehensive implementation documentation: `docs/print-new-window-solution.md`
- Documents architecture, code implementation, user experience flows, and testing guidelines

## [0.6.1] - 2026-01-08

### Added
- Print version information on startup (displays "Markon v0.6.1" when server starts)
- Comprehensive documentation for mobile print functionality issues and solutions
- Debug guide for mobile print troubleshooting (`docs/print-debug-guide.md`)

### Changed
- Mobile devices now show a friendly message when attempting to print sections, guiding users to use browser's built-in print feature
- Improved print functionality documentation (`docs/print-functionality-mobile-fix.md`)

### Fixed
- Mobile Safari print preview blank page issue by reverting experimental CSS-based print approach
- Preserved full-page printing functionality on all mobile browsers
- Desktop browsers continue to support section printing via iframe method

### Technical Details
- Mobile browsers have systemic limitations with `iframe.contentWindow.print()` and `beforeprint`/`afterprint` events
- Attempted CSS-based printing solution was rolled back due to conflicts with browser's native print functionality
- Implemented graceful degradation: desktop users get full section print capability, mobile users are guided to browser's print feature

### Documentation
- Added comprehensive technical documentation covering:
  - Root cause analysis of mobile print issues
  - Browser compatibility research (Print.js, Chromium/WebKit bugs)
  - Comparison of iframe vs CSS print approaches
  - Implementation details and code references
  - Testing guidelines for desktop and mobile platforms

## [0.6.0] - Previous Version

### Added
- Full-text search feature with directory-level support
- Keyboard shortcuts in directory mode
- Directory browsing improvements

---

**Note**: For detailed technical analysis of the mobile print functionality, see `docs/print-functionality-mobile-fix.md`
