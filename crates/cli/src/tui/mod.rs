//! Reusable terminal-UI layer for interactive CLI subcommands.
//!
//! This module is the **generic** half of the pilot: nothing here references
//! workspaces, flags, or any `markon`-specific type. A future `tui/set.rs` (or
//! any other interactive screen) reuses exactly this surface:
//!
//! - [`TerminalGuard`] — panic-safe RAII enter/leave of raw mode + the alternate
//!   screen, plus a panic hook so a crash prints a legible backtrace on the
//!   normal screen instead of a staircased mess wiped by teardown.
//! - [`Frame`] — a full-redraw frame helper (Clear + MoveTo + flush) with a
//!   width-aware, escape-free truncating line writer.
//! - selectable-list, checkbox, and confirm helpers on [`Frame`] — the reusable
//!   widgets the screens compose.
//! - [`read_action`] — the shared key→action decoder, filtering key-release /
//!   repeat events and intercepting Ctrl-C.
//!
//! Everything that knows about `WorkspaceInfo` / `WorkspaceFlags` lives in
//! [`crate::tui::ls`].

pub mod ls;

use crossterm::event::{self, Event, KeyCode, KeyEventKind, KeyModifiers};
use crossterm::style::{Color, Print, ResetColor, SetAttribute, SetForegroundColor};
use crossterm::terminal::{
    self, disable_raw_mode, enable_raw_mode, Clear, ClearType, EnterAlternateScreen,
    LeaveAlternateScreen,
};
use crossterm::{cursor, queue, QueueableCommand};
use std::io::{self, Write};
use std::panic::PanicHookInfo;
use std::sync::Arc;
use unicode_width::{UnicodeWidthChar, UnicodeWidthStr};

type PanicHook = Box<dyn Fn(&PanicHookInfo<'_>) + Sync + Send + 'static>;

/// RAII guard that puts the terminal into full-screen raw mode on construction
/// and *always* restores it on drop — normal return, `?`-early-return, and panic
/// unwind alike.
///
/// The construction order matters for the "always restored" guarantee: the guard
/// value is built (with both state flags cleared) **before** the first fallible
/// terminal call, and each flag is set only after its step succeeds. So if
/// `enable_raw_mode` succeeds but entering the alternate screen fails, the
/// already-constructed guard still drops and disables raw mode — there is no
/// partial-init window where raw mode is on but no guard exists.
pub struct TerminalGuard {
    raw_enabled: bool,
    alt_active: bool,
    /// The panic hook that was installed before us, wrapped so both our
    /// terminal-restoring hook and `Drop` can reach it. Restored on drop.
    prev_hook: Option<Arc<PanicHook>>,
}

impl TerminalGuard {
    /// Enter raw mode + the alternate screen, hiding the cursor, and install a
    /// terminal-restoring panic hook. Returns an error (having already restored)
    /// if any step fails.
    pub fn new() -> io::Result<Self> {
        // Install the panic hook first so a panic during setup still restores the
        // terminal before printing. The hook best-effort leaves raw mode / the
        // alternate screen, then delegates to the previous hook on the normal
        // screen where the backtrace renders legibly (raw mode suppresses the
        // CR translation that otherwise staircases each line).
        let prev = Arc::new(std::panic::take_hook());
        {
            let prev = prev.clone();
            std::panic::set_hook(Box::new(move |info| {
                let _ = disable_raw_mode();
                let mut out = io::stdout();
                let _ = queue!(out, LeaveAlternateScreen, cursor::Show);
                let _ = out.flush();
                prev(info);
            }));
        }

        // Construct the guard up front so any error below still drops it.
        let mut guard = TerminalGuard {
            raw_enabled: false,
            alt_active: false,
            prev_hook: Some(prev),
        };

        enable_raw_mode()?;
        guard.raw_enabled = true;

        let mut out = io::stdout();
        out.queue(EnterAlternateScreen)?;
        // EnterAlternateScreen is now queued and may already have reached a
        // partially failing writer. Mark it active before any later fallible
        // cursor/flush step so Drop always queues LeaveAlternateScreen.
        guard.alt_active = true;
        out.queue(cursor::Hide)?;
        out.flush()?;

        Ok(guard)
    }
}

impl Drop for TerminalGuard {
    fn drop(&mut self) {
        // Best-effort restore; ignore errors — there is nothing useful to do if
        // the terminal itself is gone.
        if self.alt_active {
            let mut out = io::stdout();
            let _ = queue!(out, cursor::Show, LeaveAlternateScreen);
            let _ = out.flush();
        }
        if self.raw_enabled {
            let _ = disable_raw_mode();
        }
        if let Some(prev) = self.prev_hook.take() {
            // Drop our wrapper hook, then reinstate the original. When unwinding
            // is not in flight our wrapper is the only other Arc holder, so
            // `try_unwrap` recovers the original box verbatim.
            let _ = std::panic::take_hook();
            match Arc::try_unwrap(prev) {
                Ok(hook) => std::panic::set_hook(hook),
                Err(shared) => std::panic::set_hook(Box::new(move |info| shared(info))),
            }
        }
    }
}

/// A semantic key/terminal event, decoded once so every screen matches the same
/// vocabulary. Key-release and key-repeat events are filtered out before this is
/// produced (crossterm delivers Press/Release/Repeat on Windows; matching all of
/// them would double every keystroke).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    Up,
    Down,
    Left,
    Right,
    Enter,
    Space,
    Esc,
    Char(char),
    /// Ctrl-C — a global "quit now" that every screen honors, since raw mode
    /// suppresses SIGINT so this arrives only as a key event.
    CtrlC,
    /// The terminal was resized; the caller should just redraw.
    Resize,
    /// `event::read()` returned an error (or an interrupted read). Treated as a
    /// graceful quit so the guard restores the terminal rather than panicking
    /// with an opaque, backtrace-garbling unwrap.
    Quit,
}

/// Block until the next meaningful [`Action`]. Non-key events other than resize
/// (mouse / focus / paste) and key-release / key-repeat events are looped past.
pub fn read_action() -> Action {
    loop {
        match event::read() {
            Ok(Event::Key(key)) => {
                if key.kind != KeyEventKind::Press {
                    // Ignore Release / Repeat: on Windows every keystroke would
                    // otherwise fire twice.
                    continue;
                }
                if key.modifiers.contains(KeyModifiers::CONTROL)
                    && matches!(key.code, KeyCode::Char('c') | KeyCode::Char('C'))
                {
                    return Action::CtrlC;
                }
                return match key.code {
                    KeyCode::Up => Action::Up,
                    KeyCode::Down => Action::Down,
                    KeyCode::Left => Action::Left,
                    KeyCode::Right => Action::Right,
                    KeyCode::Enter => Action::Enter,
                    KeyCode::Char(' ') => Action::Space,
                    KeyCode::Esc => Action::Esc,
                    KeyCode::Char(c) => Action::Char(c),
                    // Unmapped key: keep waiting rather than surfacing a no-op.
                    _ => continue,
                };
            }
            Ok(Event::Resize(_, _)) => return Action::Resize,
            // Mouse / focus / paste: ignore.
            Ok(_) => continue,
            // A read error (including EINTR-style interruption) is a graceful
            // quit, not a panic.
            Err(_) => return Action::Quit,
        }
    }
}

/// One rendered line in a [`Frame`]. Text is always escape-free plain text;
/// attributes (reverse video, foreground color) are applied by the renderer via
/// separate crossterm commands, never embedded as raw `\x1b[..m` bytes — so
/// width-based truncation can never miscount columns or cut through an escape.
struct FrameLine {
    text: String,
    reverse: bool,
    color: Option<Color>,
}

/// A full-screen frame built up as plain-text lines, then painted in one pass
/// (Clear + per-line MoveTo + flush). Lines past the terminal height are dropped
/// so tiny terminals truncate instead of panicking or scrolling.
pub struct Frame {
    width: usize,
    height: u16,
    lines: Vec<FrameLine>,
}

impl Frame {
    /// Snapshot the current terminal size and start an empty frame.
    pub fn new() -> io::Result<Self> {
        let (cols, rows) = terminal::size().unwrap_or((80, 24));
        Ok(Frame {
            width: cols.max(1) as usize,
            height: rows.max(1),
            lines: Vec::new(),
        })
    }

    /// Append a plain line.
    pub fn line(&mut self, text: impl Into<String>) {
        self.lines.push(FrameLine {
            text: text.into(),
            reverse: false,
            color: None,
        });
    }

    /// Append a blank line.
    pub fn blank(&mut self) {
        self.line(String::new());
    }

    /// Number of terminal rows available to this frame. Screens use this to
    /// keep the current selection and status/footer inside the viewport.
    pub fn height(&self) -> usize {
        self.height as usize
    }

    /// Append a line in the given foreground color (e.g. a red status line).
    pub fn line_colored(&mut self, text: impl Into<String>, color: Color) {
        self.lines.push(FrameLine {
            text: text.into(),
            reverse: false,
            color: Some(color),
        });
    }

    /// Widget: one row of a selectable list — reverse-video when `selected`.
    pub fn selectable(&mut self, text: impl Into<String>, selected: bool) {
        self.lines.push(FrameLine {
            text: text.into(),
            reverse: selected,
            color: None,
        });
    }

    /// Widget: a checkbox row — `[x] label` / `[ ] label`, reverse-video when
    /// `selected`. The label is plain text; the box glyph is composed here.
    pub fn checkbox(&mut self, checked: bool, label: impl AsRef<str>, selected: bool) {
        let text = format!("[{}] {}", if checked { 'x' } else { ' ' }, label.as_ref());
        self.selectable(text, selected);
    }

    /// Paint the whole frame in one pass and flush.
    pub fn render(&self) -> io::Result<()> {
        let mut out = io::stdout();
        queue!(out, Clear(ClearType::All), cursor::MoveTo(0, 0))?;
        for (i, line) in self.lines.iter().enumerate() {
            if i as u16 >= self.height {
                break;
            }
            queue!(out, cursor::MoveTo(0, i as u16))?;
            let text = truncate_to_width(&line.text, self.width);
            if line.reverse {
                queue!(out, SetAttribute(crossterm::style::Attribute::Reverse))?;
            }
            if let Some(color) = line.color {
                queue!(out, SetForegroundColor(color))?;
            }
            queue!(out, Print(text))?;
            if line.color.is_some() {
                queue!(out, ResetColor)?;
            }
            if line.reverse {
                queue!(out, SetAttribute(crossterm::style::Attribute::Reset))?;
            }
        }
        out.flush()
    }
}

/// Truncate `text` to at most `width` display columns. Workspace aliases and
/// paths may contain CJK or other wide Unicode characters, so byte/char counts
/// are insufficient: use terminal column widths and reserve one column for the
/// ellipsis. Text is escape-free, so no truncation can split an ANSI sequence.
fn truncate_to_width(text: &str, width: usize) -> String {
    if UnicodeWidthStr::width(text) <= width {
        text.to_string()
    } else if width == 0 {
        String::new()
    } else {
        let keep_width = width.saturating_sub(1);
        let mut used = 0;
        let mut out = String::new();
        for ch in text.chars() {
            let char_width = UnicodeWidthChar::width(ch).unwrap_or(0);
            if used + char_width > keep_width {
                break;
            }
            out.push(ch);
            used += char_width;
        }
        out.push('…');
        out
    }
}

/// Red — the status-line color for a surfaced control-socket error.
pub const ERROR_COLOR: Color = Color::Red;

#[cfg(test)]
mod tests {
    use super::truncate_to_width;

    #[test]
    fn truncates_by_terminal_columns() {
        assert_eq!(truncate_to_width("abcdef", 4), "abc…");
        assert_eq!(truncate_to_width("你好", 4), "你好");
        assert_eq!(truncate_to_width("你好", 3), "你…");
        assert_eq!(truncate_to_width("你好", 1), "…");
        assert_eq!(truncate_to_width("abc", 0), "");
    }
}
