//! The interactive `markon ls` screen — the pilot that exercises the generic
//! [`crate::tui`] layer. Everything workspace-specific (rows, feature summary,
//! flag editing, detach) lives here; the terminal guard, frame/widget helpers,
//! and key decoder come from the parent module.

use super::{read_action, Action, Frame, TerminalGuard, ERROR_COLOR};
use markon_core::control::RunningServer;
use markon_core::server;
use markon_core::workspace::{WorkspaceFlags, WorkspaceInfo};
use std::error::Error;
use std::io;
use std::path::Path;
use tokio::runtime::{Handle, RuntimeFlavor};

/// Which screen currently owns the keyboard.
enum Screen {
    List,
    Edit,
    ConfirmDetach,
}

/// Entry point for the interactive browser. Runs on a blocking-pool thread (see
/// the `spawn_blocking` in `main`), where [`Handle::block_on`] is legal for the
/// async control calls.
///
/// # Runtime requirement
/// The bridge is correct **only** on a multi-thread tokio runtime: while this
/// blocking thread parks in `block_on`, the runtime's core workers must keep
/// driving the IO reactor the async control transport needs. On a
/// `current_thread` runtime the single thread would be blocked awaiting this
/// task and nothing would drive the reactor — a silent deadlock. `main` uses the
/// default multi-thread `#[tokio::main]`; the debug assertion below pins that
/// invariant.
///
/// The initial fetch runs before any terminal state is touched, so its failure
/// propagates as an error (mapping to a non-zero exit, consistent with the other
/// management subcommands) without ever entering raw mode. Mid-session mutation
/// failures (edit / detach) are surfaced on an in-UI status line instead and do
/// not affect the exit status.
pub fn run(
    server: RunningServer,
    handle: Handle,
    bind_host: String,
    advertised_host: String,
    port: u16,
    entry: Option<String>,
) -> Result<(), Box<dyn Error + Send + Sync>> {
    debug_assert_ne!(
        handle.runtime_flavor(),
        RuntimeFlavor::CurrentThread,
        "the ls TUI bridge requires a multi-thread runtime: block_on here would \
         deadlock the reactor on a current_thread runtime",
    );

    let (url_base, _use_entry_url) =
        crate::resolve_workspace_list_base(&bind_host, &advertised_host, port, entry.as_deref());

    // Initial fetch before touching the terminal: an error here propagates
    // cleanly (non-zero exit) with no raw-mode side effects.
    let workspaces = handle.block_on(server.list_workspaces())?;

    let mut app = App {
        server,
        handle,
        url_base,
        workspaces,
        selected: 0,
        screen: Screen::List,
        edit_flags: WorkspaceFlags::default(),
        edit_cursor: 0,
        status: None,
        show_help: false,
    };

    // From here on the guard owns terminal restoration on every exit path.
    let _guard = TerminalGuard::new()?;
    app.event_loop()?;
    Ok(())
}

struct App {
    server: RunningServer,
    handle: Handle,
    /// Base URL (featured or `--entry` prefix) for building per-workspace URLs.
    url_base: String,
    workspaces: Vec<WorkspaceInfo>,
    selected: usize,
    screen: Screen,
    /// Working copy of the selected workspace's flags while on the Edit screen;
    /// nothing is sent until save.
    edit_flags: WorkspaceFlags,
    edit_cursor: usize,
    /// Transient message shown as a colored status line (control errors, etc.).
    status: Option<String>,
    show_help: bool,
}

impl App {
    fn event_loop(&mut self) -> io::Result<()> {
        loop {
            self.draw()?;
            let action = read_action();
            // Ctrl-C and a read error are global, screen-independent exits so we
            // always unwind through the terminal guard.
            if matches!(action, Action::CtrlC | Action::Quit) {
                return Ok(());
            }
            let keep_running = match self.screen {
                Screen::List => self.handle_list(action),
                Screen::Edit => self.handle_edit(action),
                Screen::ConfirmDetach => self.handle_confirm(action),
            };
            if !keep_running {
                return Ok(());
            }
        }
    }

    // --- state helpers ---------------------------------------------------

    fn selected_ws(&self) -> Option<&WorkspaceInfo> {
        self.workspaces.get(self.selected)
    }

    /// Re-fetch the workspace list after a mutation and re-clamp the selection.
    fn refresh(&mut self) -> Result<(), String> {
        match self.handle.block_on(self.server.list_workspaces()) {
            Ok(list) => {
                self.workspaces = list;
                self.clamp_selection();
                Ok(())
            }
            Err(e) => Err(e.to_string()),
        }
    }

    fn clamp_selection(&mut self) {
        if self.workspaces.is_empty() {
            self.selected = 0;
        } else if self.selected >= self.workspaces.len() {
            self.selected = self.workspaces.len() - 1;
        }
    }

    /// Full URL of the currently selected workspace, if any.
    fn selected_url(&self) -> Option<String> {
        self.selected_ws().map(|ws| {
            server::build_workspace_url(&self.url_base, &server::workspace_url_path(&ws.id, None))
        })
    }

    // --- List screen -----------------------------------------------------

    fn handle_list(&mut self, action: Action) -> bool {
        match action {
            Action::Up | Action::Char('k') => {
                self.selected = self.selected.saturating_sub(1);
            }
            Action::Down | Action::Char('j') => {
                if !self.workspaces.is_empty() {
                    self.selected = (self.selected + 1).min(self.workspaces.len() - 1);
                }
            }
            Action::Char('e') | Action::Enter => {
                if let Some(ws) = self.selected_ws() {
                    self.edit_flags = ws.flags;
                    self.edit_cursor = 0;
                    self.status = None;
                    self.screen = Screen::Edit;
                }
            }
            Action::Char('d') => {
                if self.selected_ws().is_some() {
                    self.status = None;
                    self.screen = Screen::ConfirmDetach;
                }
            }
            Action::Char('o') => {
                if let Some(url) = self.selected_url() {
                    match open::that(&url) {
                        Ok(()) => self.status = Some(format!("opened {url}")),
                        Err(e) => self.status = Some(format!("failed to open browser: {e}")),
                    }
                }
            }
            Action::Char('?') => self.show_help = !self.show_help,
            Action::Char('q') | Action::Esc => return false,
            _ => {}
        }
        true
    }

    // --- Edit screen -----------------------------------------------------

    fn handle_edit(&mut self, action: Action) -> bool {
        match action {
            Action::Up | Action::Char('k') => {
                self.edit_cursor = self.edit_cursor.saturating_sub(1);
            }
            Action::Down | Action::Char('j') => {
                self.edit_cursor = (self.edit_cursor + 1).min(FLAG_COUNT - 1);
            }
            Action::Space => {
                let field = crate::workspace_flag_mut(&mut self.edit_flags, self.edit_cursor);
                *field = !*field;
            }
            // Enter / s submit the working copy (AskUserQuestion-style: Enter is
            // "confirm", Space toggles a row).
            Action::Enter | Action::Char('s') => return self.save_edit(),
            Action::Char('?') => self.show_help = !self.show_help,
            // Esc backs out; q is reserved as "quit app" on List only, so it is
            // inert here (the footer directs the user to Esc).
            Action::Esc => {
                self.status = None;
                self.screen = Screen::List;
            }
            _ => {}
        }
        true
    }

    fn save_edit(&mut self) -> bool {
        let Some(ws) = self.selected_ws() else {
            self.screen = Screen::List;
            return true;
        };
        let id = ws.id.clone();
        let name = display_name(ws);
        let flags = self.edit_flags;
        match self.handle.block_on(self.server.update_flags(&id, flags)) {
            Ok(()) => {
                self.screen = Screen::List;
                if let Err(e) = self.refresh() {
                    self.status = Some(e);
                } else {
                    self.status = Some(format!("saved {name}"));
                }
            }
            // Stay on Edit and surface the error; the working copy is preserved.
            Err(e) => self.status = Some(e.to_string()),
        }
        true
    }

    // --- ConfirmDetach screen -------------------------------------------

    fn handle_confirm(&mut self, action: Action) -> bool {
        match action {
            Action::Char('y') => {
                if let Some(ws) = self.selected_ws() {
                    let id = ws.id.clone();
                    let name = display_name(ws);
                    match self.handle.block_on(self.server.remove_workspace(&id)) {
                        Ok(()) => match self.refresh() {
                            Ok(()) => self.status = Some(format!("detached {name}")),
                            Err(e) => self.status = Some(e),
                        },
                        Err(e) => self.status = Some(e.to_string()),
                    }
                }
                self.screen = Screen::List;
            }
            Action::Char('n') | Action::Esc => {
                self.screen = Screen::List;
            }
            _ => {}
        }
        true
    }

    // --- rendering -------------------------------------------------------

    fn draw(&self) -> io::Result<()> {
        match self.screen {
            Screen::List => self.draw_list(),
            Screen::Edit => self.draw_edit(),
            Screen::ConfirmDetach => self.draw_confirm(),
        }
    }

    fn draw_list(&self) -> io::Result<()> {
        let mut frame = Frame::new()?;
        frame.line(format!("Workspaces ({})", self.workspaces.len()));
        frame.blank();

        if self.workspaces.is_empty() {
            frame.line("No active workspaces.");
            frame.blank();
            frame.line("q quit · ? help");
            self.push_status(&mut frame);
            return frame.render();
        }

        for (i, ws) in self.workspaces.iter().enumerate() {
            let marker = if i == self.selected { "> " } else { "  " };
            let features = crate::format_workspace_feature_tags(ws.flags, ws.search_ready);
            let row = format!(
                "{marker}{}. {}   {}   {}",
                i + 1,
                display_name(ws),
                features,
                ws.id
            );
            frame.selectable(row, i == self.selected);
        }

        frame.blank();
        if let Some(url) = self.selected_url() {
            frame.line(format!("URL: {url}"));
        }
        frame.blank();
        frame.line("↑/↓ move · e edit · d detach · o open · q quit · ? help");
        if self.show_help {
            frame.line("aliases: k/j move · enter edit · ctrl-c quit");
        }
        self.push_status(&mut frame);
        frame.render()
    }

    fn draw_edit(&self) -> io::Result<()> {
        let mut frame = Frame::new()?;
        let (name, path) = match self.selected_ws() {
            Some(ws) => (
                display_name(ws),
                crate::display_workspace_path(Path::new(&ws.path)),
            ),
            None => (String::from("(none)"), String::new()),
        };
        frame.line(format!("Edit: {name}"));
        if !path.is_empty() {
            frame.line(path);
        }
        frame.blank();

        // Rows, labels, and order all come from the single source of truth so
        // the display and the toggle can never disagree.
        for (i, (enabled, _, _, form_label)) in
            crate::workspace_flag_entries(self.edit_flags, false)
                .into_iter()
                .enumerate()
        {
            frame.checkbox(enabled, form_label, i == self.edit_cursor);
        }

        frame.blank();
        frame.line("↑/↓ move · space toggle · enter save · esc cancel · ? help");
        if self.show_help {
            frame.line("aliases: k/j move · s save · ctrl-c quit");
        }
        self.push_status(&mut frame);
        frame.render()
    }

    fn draw_confirm(&self) -> io::Result<()> {
        let mut frame = Frame::new()?;
        let name = self
            .selected_ws()
            .map(display_name)
            .unwrap_or_else(|| String::from("(none)"));
        frame.line(format!("Detach \"{name}\"?"));
        frame.blank();
        frame.line("y = yes    n = no");
        frame.blank();
        frame.line("y detach · n cancel");
        self.push_status(&mut frame);
        frame.render()
    }

    fn push_status(&self, frame: &mut Frame) {
        if let Some(status) = self.status.as_deref() {
            frame.blank();
            frame.line_colored(status, ERROR_COLOR);
        }
    }
}

/// Number of editable feature flags — the row count of the Edit form and the
/// clamp bound for its cursor. Matches [`crate::workspace_flag_entries`].
const FLAG_COUNT: usize = 6;

/// User-visible name for a workspace row: the alias when set, else the shortened
/// path. Ephemeral single-file workspaces join their serving root with the file
/// name so the displayed path points at the actual file, not just its directory.
fn display_name(ws: &WorkspaceInfo) -> String {
    let alias = ws.alias.trim();
    if !alias.is_empty() {
        return alias.to_string();
    }
    let base = Path::new(&ws.path);
    let path = match &ws.single_file {
        Some(file) if ws.ephemeral => base.join(file),
        _ => base.to_path_buf(),
    };
    crate::display_workspace_path(&path)
}
