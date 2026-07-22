//! The interactive `markon ls` screen — the pilot that exercises the generic
//! [`crate::tui`] layer. Everything workspace-specific (rows, feature summary,
//! flag editing, detach) lives here; the terminal guard, frame/widget helpers,
//! and key decoder come from the parent module.

use super::{read_action, Action, Frame, TerminalGuard, ERROR_COLOR};
use markon_core::control::RunningServer;
use markon_core::data_maintenance::DataCleanupStats;
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
    DataCleanup,
    ConfirmCleanup,
}

enum Status {
    Info(String),
    Error(String),
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

    let (url_base, use_entry_url) =
        crate::resolve_workspace_list_base(&bind_host, &advertised_host, port, entry.as_deref());

    // Initial fetch before touching the terminal: an error here propagates
    // cleanly (non-zero exit) with no raw-mode side effects.
    let workspaces = handle.block_on(server.list_workspaces())?;

    let mut app = App {
        server,
        handle,
        url_base,
        use_entry_url,
        workspaces,
        selected: 0,
        screen: Screen::List,
        edit_flags: WorkspaceFlags::default(),
        edit_cursor: 0,
        status: None,
        show_help: false,
        cleanup_stats: None,
    };

    // From here on the guard owns terminal restoration on every exit path.
    let _guard = TerminalGuard::new()?;
    app.event_loop()?;
    Ok(())
}

struct App {
    server: RunningServer,
    handle: Handle,
    /// Stable local base URL, or an explicit `--entry` prefix, for workspace URLs.
    url_base: String,
    /// An explicit `--entry` remains authoritative even though local launches
    /// otherwise use the stable loopback origin.
    use_entry_url: bool,
    workspaces: Vec<WorkspaceInfo>,
    selected: usize,
    screen: Screen,
    /// Working copy of the selected workspace's flags while on the Edit screen;
    /// nothing is sent until save.
    edit_flags: WorkspaceFlags,
    edit_cursor: usize,
    /// Transient message shown below the current screen. Errors are red;
    /// successful operations remain neutral instead of looking like failures.
    status: Option<Status>,
    show_help: bool,
    cleanup_stats: Option<DataCleanupStats>,
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
                Screen::DataCleanup => self.handle_data_cleanup(action),
                Screen::ConfirmCleanup => self.handle_confirm_cleanup(action),
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
            Action::Down | Action::Char('j') if !self.workspaces.is_empty() => {
                self.selected = (self.selected + 1).min(self.workspaces.len() - 1);
            }
            Action::Char('e') | Action::Enter => {
                if let Some(ws) = self.selected_ws() {
                    self.edit_flags = ws.flags;
                    self.edit_cursor = 0;
                    self.status = None;
                    self.screen = Screen::Edit;
                }
            }
            Action::Char('d') if self.selected_ws().is_some() => {
                self.status = None;
                self.screen = Screen::ConfirmDetach;
            }
            Action::Char('c') => {
                self.status = None;
                self.refresh_cleanup_stats();
                self.screen = Screen::DataCleanup;
            }
            Action::Char('o') => {
                if let Some(ws) = self.selected_ws() {
                    let redirect = server::workspace_url_path(&ws.id, None);
                    match self.handle.block_on(self.server.admin_bootstrap(&redirect)) {
                        Ok(issued_url) => {
                            let url = if self.use_entry_url {
                                crate::rehome_admin_bootstrap_url(
                                    &self.url_base,
                                    &redirect,
                                    &issued_url,
                                )
                            } else {
                                issued_url
                            };
                            match open::that(&url) {
                                Ok(()) => self.status = Some(Status::Info(format!("opened {url}"))),
                                Err(e) => {
                                    self.status =
                                        Some(Status::Error(format!("failed to open browser: {e}")))
                                }
                            }
                        }
                        Err(e) => self.status = Some(Status::Error(e.to_string())),
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
                    self.status = Some(Status::Error(e));
                } else {
                    self.status = Some(Status::Info(format!("saved {name}")));
                }
            }
            // Stay on Edit and surface the error; the working copy is preserved.
            Err(e) => self.status = Some(Status::Error(e.to_string())),
        }
        true
    }

    // --- ConfirmDetach screen -------------------------------------------

    fn handle_confirm(&mut self, action: Action) -> bool {
        match action {
            Action::Char('y') | Action::Char('Y') => {
                if let Some(ws) = self.selected_ws() {
                    let id = ws.id.clone();
                    let name = display_name(ws);
                    match self.handle.block_on(self.server.remove_workspace(&id)) {
                        Ok(()) => match self.refresh() {
                            Ok(()) => self.status = Some(Status::Info(format!("detached {name}"))),
                            Err(e) => self.status = Some(Status::Error(e)),
                        },
                        Err(e) => self.status = Some(Status::Error(e.to_string())),
                    }
                }
                self.screen = Screen::List;
            }
            Action::Char('n') | Action::Char('N') | Action::Esc => {
                self.screen = Screen::List;
            }
            _ => {}
        }
        true
    }

    fn refresh_cleanup_stats(&mut self) {
        match self.handle.block_on(self.server.data_cleanup_stats()) {
            Ok(stats) => self.cleanup_stats = Some(stats),
            Err(error) => self.status = Some(Status::Error(error.to_string())),
        }
    }

    fn handle_data_cleanup(&mut self, action: Action) -> bool {
        match action {
            Action::Char('r') => self.refresh_cleanup_stats(),
            Action::Char('c')
                if self
                    .cleanup_stats
                    .as_ref()
                    .is_some_and(|stats| stats.orphaned_items() > 0) =>
            {
                self.screen = Screen::ConfirmCleanup;
            }
            Action::Esc => {
                self.status = None;
                self.screen = Screen::List;
            }
            _ => {}
        }
        true
    }

    fn handle_confirm_cleanup(&mut self, action: Action) -> bool {
        match action {
            Action::Char('y') | Action::Char('Y') => {
                match self.handle.block_on(self.server.cleanup_orphaned_data()) {
                    Ok(result) => {
                        self.status = Some(Status::Info(format!(
                            "deleted {} annotations, {} viewed records, {} chat threads and {} messages",
                            result.deleted_annotations,
                            result.deleted_viewed_files,
                            result.deleted_chat_threads,
                            result.deleted_chat_messages,
                        )));
                        self.refresh_cleanup_stats();
                    }
                    Err(error) => self.status = Some(Status::Error(error.to_string())),
                }
                self.screen = Screen::DataCleanup;
            }
            Action::Char('n') | Action::Char('N') | Action::Esc => {
                self.screen = Screen::DataCleanup;
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
            Screen::DataCleanup => self.draw_data_cleanup(),
            Screen::ConfirmCleanup => self.draw_confirm_cleanup(),
        }
    }

    fn draw_list(&self) -> io::Result<()> {
        let mut frame = Frame::new()?;
        frame.line(format!("Workspaces ({})", self.workspaces.len()));
        frame.blank();

        if self.workspaces.is_empty() {
            frame.line("No active workspaces.");
            frame.blank();
            frame.line("c data · q quit · ? help");
            self.push_status(&mut frame);
            return frame.render();
        }

        // Keep the selected row visible while reserving terminal rows for the
        // URL, help, and status. Without a viewport, moving below the physical
        // screen made the cursor and mutation feedback disappear.
        let fixed_rows = 6 + usize::from(self.show_help) + usize::from(self.status.is_some()) * 2;
        let visible_rows = frame
            .height()
            .saturating_sub(fixed_rows)
            .min(self.workspaces.len());
        let start = viewport_start(self.selected, self.workspaces.len(), visible_rows);
        for (i, ws) in self
            .workspaces
            .iter()
            .enumerate()
            .skip(start)
            .take(visible_rows)
        {
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
        frame.line("↑/↓ move · e edit · d detach · o open · c data · q quit · ? help");
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

    fn draw_data_cleanup(&self) -> io::Result<()> {
        let mut frame = Frame::new()?;
        frame.line("Closed-workspace data");
        frame.blank();
        if let Some(stats) = &self.cleanup_stats {
            frame.line(format!(
                "Database: {}",
                crate::format_data_bytes(stats.database_bytes)
            ));
            frame.line(format!(
                "Annotation files: {} · annotations: {} · viewed records: {}",
                stats.orphaned_annotation_files,
                stats.orphaned_annotations,
                stats.orphaned_viewed_files,
            ));
            frame.line(format!(
                "Chat threads: {} · messages: {} · payload: {}",
                stats.orphaned_chat_threads,
                stats.orphaned_chat_messages,
                crate::format_data_bytes(stats.orphaned_payload_bytes),
            ));
            if stats.orphaned_items() == 0 {
                frame.blank();
                frame.line("No obsolete data.");
            }
        } else {
            frame.line("Statistics unavailable.");
        }
        frame.blank();
        frame.line("r refresh · c clean up · esc back");
        self.push_status(&mut frame);
        frame.render()
    }

    fn draw_confirm_cleanup(&self) -> io::Result<()> {
        let mut frame = Frame::new()?;
        frame.line("Permanently delete all data outside active workspaces?");
        frame.line("This cannot be undone.");
        frame.blank();
        frame.line("y delete · n/esc cancel");
        frame.render()
    }

    fn push_status(&self, frame: &mut Frame) {
        match &self.status {
            Some(Status::Info(message)) => {
                frame.blank();
                frame.line(message);
            }
            Some(Status::Error(message)) => {
                frame.blank();
                frame.line_colored(message, ERROR_COLOR);
            }
            None => {}
        }
    }
}

/// Number of editable feature flags — the row count of the Edit form and the
/// clamp bound for its cursor. Matches [`crate::workspace_flag_entries`].
const FLAG_COUNT: usize = 6;

fn viewport_start(selected: usize, total: usize, visible: usize) -> usize {
    if visible == 0 || total <= visible {
        0
    } else {
        selected
            .saturating_add(1)
            .saturating_sub(visible)
            .min(total - visible)
    }
}

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

#[cfg(test)]
mod tests {
    use super::viewport_start;

    #[test]
    fn viewport_keeps_selection_visible() {
        assert_eq!(viewport_start(0, 10, 4), 0);
        assert_eq!(viewport_start(3, 10, 4), 0);
        assert_eq!(viewport_start(4, 10, 4), 1);
        assert_eq!(viewport_start(9, 10, 4), 6);
        assert_eq!(viewport_start(9, 10, 0), 0);
        assert_eq!(viewport_start(2, 3, 4), 0);
    }
}
