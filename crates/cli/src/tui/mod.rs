//! Reusable terminal-UI layer for interactive CLI subcommands.
//!
//! This module is the generic terminal layer: nothing here references
//! workspaces, flags, or any `markon`-specific type.
//!
//! - [`TerminalGuard`] — panic-safe RAII enter/leave of raw mode. It deliberately
//!   stays in the normal screen buffer so shell history remains visible.
//! - [`Frame`] — an inline viewport renderer that reserves rows below the
//!   invoking command and redraws only those rows.
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
use crossterm::terminal::{self, disable_raw_mode, enable_raw_mode, Clear, ClearType};
use crossterm::{cursor, queue};
use std::io::{self, Write};
use std::panic::PanicHookInfo;
use std::sync::Arc;
use unicode_width::{UnicodeWidthChar, UnicodeWidthStr};

type PanicHook = Box<dyn Fn(&PanicHookInfo<'_>) + Sync + Send + 'static>;

/// RAII guard that enters raw mode without changing screen buffers and always
/// restores the cursor, line position, raw mode, and panic hook on drop.
///
/// The construction order matters for the "always restored" guarantee: the guard
/// value is built before the first fallible terminal call and each state flag is
/// set only after its step succeeds.
pub struct TerminalGuard {
    raw_enabled: bool,
    cursor_hidden: bool,
    /// Rows currently owned by the inline viewport. The cursor rests on the
    /// final row after every render.
    rendered_lines: u16,
    /// The panic hook that was installed before us, wrapped so both our
    /// terminal-restoring hook and `Drop` can reach it. Restored on drop.
    prev_hook: Option<Arc<PanicHook>>,
}

impl TerminalGuard {
    /// Enter raw mode in the normal screen buffer, hide the cursor, and install
    /// a terminal-restoring panic hook.
    pub fn new() -> io::Result<Self> {
        // Install the panic hook first so a panic during setup or rendering still
        // restores a legible terminal before delegating to the previous hook.
        let prev = Arc::new(std::panic::take_hook());
        {
            let prev = prev.clone();
            std::panic::set_hook(Box::new(move |info| {
                let _ = disable_raw_mode();
                let mut out = io::stdout();
                let _ = queue!(
                    out,
                    ResetColor,
                    SetAttribute(crossterm::style::Attribute::Reset),
                    cursor::Show,
                    cursor::MoveToNextLine(1)
                );
                let _ = out.flush();
                prev(info);
            }));
        }

        // Construct the guard up front so any error below still drops it.
        let mut guard = TerminalGuard {
            raw_enabled: false,
            cursor_hidden: false,
            rendered_lines: 0,
            prev_hook: Some(prev),
        };

        enable_raw_mode()?;
        guard.raw_enabled = true;

        let mut out = io::stdout();
        queue!(out, cursor::Hide)?;
        // The hide command may already have reached a partially failing writer;
        // mark it active before flush so Drop always attempts to show the cursor.
        guard.cursor_hidden = true;
        out.flush()?;

        Ok(guard)
    }
}

impl Drop for TerminalGuard {
    fn drop(&mut self) {
        // Best-effort restore; ignore errors — there is nothing useful to do if
        // the terminal itself is gone.
        if self.cursor_hidden || self.rendered_lines > 0 {
            let mut out = io::stdout();
            let _ = queue!(
                out,
                ResetColor,
                SetAttribute(crossterm::style::Attribute::Reset),
                cursor::Show
            );
            if self.rendered_lines > 0 {
                // The cursor rests on the last viewport row. Leave the rendered
                // TUI in scrollback and put the next shell prompt immediately
                // below it.
                let _ = queue!(out, cursor::MoveToNextLine(1));
            }
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
    bold: bool,
}

/// An inline frame built up as plain-text lines, then painted into rows owned by
/// [`TerminalGuard`]. Lines past the terminal height are dropped so a large
/// workspace list remains navigable within one terminal-height viewport.
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
            // Leave the final column unused: printing exactly the terminal width
            // can trigger an implicit wrap, which would move an inline viewport
            // by an extra row and break relative redraw bookkeeping.
            width: cols.saturating_sub(1).max(1) as usize,
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
            bold: false,
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
            bold: false,
        });
    }

    /// Append a bold line in the given semantic foreground color.
    pub fn heading(&mut self, text: impl Into<String>, color: Color) {
        self.lines.push(FrameLine {
            text: text.into(),
            reverse: false,
            color: Some(color),
            bold: true,
        });
    }

    /// Widget: one row of a selectable list — reverse-video when `selected`.
    pub fn selectable(&mut self, text: impl Into<String>, selected: bool) {
        self.lines.push(FrameLine {
            text: text.into(),
            reverse: selected,
            color: None,
            bold: false,
        });
    }

    /// Widget: a colored selectable row.
    pub fn selectable_colored(&mut self, text: impl Into<String>, selected: bool, color: Color) {
        self.lines.push(FrameLine {
            text: text.into(),
            reverse: selected,
            color: Some(color),
            bold: false,
        });
    }

    /// Widget: a colored checkbox row.
    pub fn checkbox_colored(
        &mut self,
        checked: bool,
        label: impl AsRef<str>,
        selected: bool,
        color: Color,
    ) {
        let text = format!("[{}] {}", if checked { 'x' } else { ' ' }, label.as_ref());
        self.selectable_colored(text, selected, color);
    }

    /// Paint this frame into the inline viewport and flush.
    ///
    /// The first render reserves enough rows below the invoking command. Later
    /// renders rewind only over the previously-owned rows, clear those rows one
    /// by one, and repaint them. No alternate screen or full-screen clear is
    /// emitted, so everything above the command remains in normal scrollback.
    pub fn render(&self, terminal: &mut TerminalGuard) -> io::Result<()> {
        let mut out = io::stdout();
        let current_lines = self.lines.len().min(self.height as usize).max(1) as u16;
        let (growth, extent) = inline_redraw_geometry(terminal.rendered_lines, current_lines);

        // Extend the viewport at its bottom before rewinding. Newlines may
        // naturally scroll older shell output upward, but never discard it.
        for _ in 0..growth {
            queue!(out, Print("\r\n"))?;
        }
        if extent > 1 {
            queue!(out, cursor::MoveUp(extent - 1))?;
        }
        queue!(out, cursor::MoveToColumn(0))?;

        // Clear exactly the rows this viewport owns, not the terminal screen.
        for row in 0..extent {
            queue!(out, Clear(ClearType::CurrentLine))?;
            if row + 1 < extent {
                queue!(out, cursor::MoveToNextLine(1))?;
            }
        }
        if extent > 1 {
            queue!(out, cursor::MoveUp(extent - 1))?;
        }

        for (i, line) in self.lines.iter().take(current_lines as usize).enumerate() {
            if i > 0 {
                queue!(out, Print("\r\n"))?;
            }
            let text = truncate_to_width(&line.text, self.width);
            if line.bold {
                queue!(out, SetAttribute(crossterm::style::Attribute::Bold))?;
            }
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
            if line.reverse || line.bold {
                queue!(out, SetAttribute(crossterm::style::Attribute::Reset))?;
            }
        }
        // Update before flush: if the writer partially fails, Drop still knows
        // the furthest row it may need to step past before returning to the shell.
        terminal.rendered_lines = current_lines;
        out.flush()
    }
}

/// Number of new rows to append at the viewport bottom and total rows to rewind
/// and clear before a redraw.
fn inline_redraw_geometry(previous: u16, current: u16) -> (u16, u16) {
    let growth = if previous == 0 {
        current.saturating_sub(1)
    } else {
        current.saturating_sub(previous)
    };
    (growth, previous.max(current))
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

/// Semantic terminal colors shared by every TUI screen.
pub const HEADING_COLOR: Color = Color::Cyan;
pub const ACTION_COLOR: Color = Color::Cyan;
pub const LINK_COLOR: Color = Color::Cyan;
pub const ENABLED_COLOR: Color = Color::Green;
pub const MUTED_COLOR: Color = Color::DarkGrey;
pub const INFO_COLOR: Color = Color::Green;
pub const WARNING_COLOR: Color = Color::Yellow;
pub const ERROR_COLOR: Color = Color::Red;

#[cfg(test)]
mod tests {
    use super::{inline_redraw_geometry, truncate_to_width};

    #[test]
    fn inline_viewport_grows_and_shrinks_without_touching_other_rows() {
        assert_eq!(inline_redraw_geometry(0, 8), (7, 8));
        assert_eq!(inline_redraw_geometry(8, 10), (2, 10));
        assert_eq!(inline_redraw_geometry(10, 6), (0, 10));
        assert_eq!(inline_redraw_geometry(6, 6), (0, 6));
    }

    #[test]
    fn truncates_by_terminal_columns() {
        assert_eq!(truncate_to_width("abcdef", 4), "abc…");
        assert_eq!(truncate_to_width("你好", 4), "你好");
        assert_eq!(truncate_to_width("你好", 3), "你…");
        assert_eq!(truncate_to_width("你好", 1), "…");
        assert_eq!(truncate_to_width("abc", 0), "");
    }
}
