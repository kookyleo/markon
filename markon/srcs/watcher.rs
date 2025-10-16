use notify::{RecursiveMode, Watcher};
use std::fs;
use std::path::Path;
use std::sync::{Arc, RwLock};
use std::time::Duration;
use tokio::sync::broadcast;
use notify_debouncer_full::{new_debouncer, DebounceEventResult};

use crate::markdown;

pub async fn watch<P: AsRef<Path>>(
    path: P,
    shared_html: Arc<RwLock<String>>,
    tx: broadcast::Sender<()>,
) {
    let path_buf = path.as_ref().to_path_buf();
    let shared_html_clone = shared_html.clone();

    let mut debouncer = new_debouncer(Duration::from_secs(1), None, move |result: DebounceEventResult| {
        match result {
            Ok(events) => {
                if !events.is_empty() {
                    if let Ok(markdown_input) = fs::read_to_string(&path_buf) {
                        let html_output = markdown::to_html(&markdown_input);
                        let mut guard = shared_html_clone.write().unwrap();
                        *guard = html_output;
                        let _ = tx.send(());
                    }
                }
            }
            Err(errors) => {
                for error in errors {
                    eprintln!("[Watcher] Error: {:?}", error);
                }
            }
        }
    }).unwrap();

    debouncer.watcher().watch(path.as_ref(), RecursiveMode::NonRecursive).unwrap();

    // Keep the debouncer alive
    std::future::pending::<()>().await;
}
