use axum::{extract::{Query, State}, response::{IntoResponse, Json}};
use notify::Watcher;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::fs;
use std::sync::{Arc, Mutex};
use tokio::sync::mpsc;
use walkdir::WalkDir;
use crate::server::AppState;

#[derive(Deserialize)]
pub struct SearchQuery {
    q: String,
}

#[derive(Serialize)]
pub struct SearchResult {
    file_path: String,
    snippet: String,
}

pub async fn search_handler(
    State(state): State<AppState>,
    Query(query): Query<SearchQuery>,
) -> impl IntoResponse {
    if !state.enable_search || query.q.is_empty() {
        return Json(Vec::<SearchResult>::new());
    }

    let search_db = match state.search_db {
        Some(ref db) => db.clone(),
        None => return Json(Vec::new()),
    };

    let db = search_db.lock().unwrap();
    let mut stmt = db
        .prepare("SELECT file_path, snippet(search_index, 1, '<b>', '</b>', '...', 20) FROM search_index WHERE content MATCH ?1 ORDER BY rank")
        .unwrap();

    let results = stmt
        .query_map([&query.q], |row| {
            Ok(SearchResult {
                file_path: row.get(0)?,
                snippet: row.get(1)?,
            })
        })
        .unwrap()
        .filter_map(Result::ok)
        .collect::<Vec<_>>();

    Json(results)
}

pub async fn initialize_search_db(state: &mut AppState) {
    if !state.enable_search {
        return;
    }

    let conn = Connection::open_in_memory().expect("Failed to open in-memory database");
    conn.execute(
        "CREATE VIRTUAL TABLE search_index USING fts5(file_path, content)",
        [],
    )
    .expect("Failed to create FTS5 table");

    let start_dir = state.start_dir.as_ref().clone();
    let search_db = Arc::new(Mutex::new(conn));
    state.search_db = Some(search_db.clone());

    tokio::spawn(async move {
        println!("Start indexing Markdown files...");
        for entry in WalkDir::new(start_dir)
            .into_iter()
            .filter_map(Result::ok)
            .filter(|e| e.path().extension().map_or(false, |ext| ext == "md"))
        {
            let path = entry.path().to_path_buf();
            if let Ok(content) = fs::read_to_string(&path) {
                let relative_path = path.to_str().unwrap_or_default().to_string();
                let db = search_db.lock().unwrap();
                db.execute(
                    "INSERT INTO search_index (file_path, content) VALUES (?1, ?2)",
                    [&relative_path, &content],
                )
                .ok();
            }
        }
        println!("Indexing complete.");
    });
}

pub async fn init_and_watch(state: &mut AppState) {
    initialize_search_db(state).await;
    let watch_state = state.clone();
    tokio::spawn(async move {
        watch_files_for_changes(watch_state).await;
    });
}

pub async fn watch_files_for_changes(state: AppState) {
    let (tx, mut rx) = mpsc::channel(10);

    let mut watcher = notify::recommended_watcher(move |res| {
        if let Ok(event) = res {
            tx.blocking_send(event).unwrap();
        }
    })
    .unwrap();

    watcher
        .watch(state.start_dir.as_ref(), notify::RecursiveMode::Recursive)
        .unwrap();

    while let Some(event) = rx.recv().await {
        // Debounce
        tokio::time::sleep(tokio::time::Duration::from_millis(200)).await;

        for path in event.paths {
            if path.extension().map_or(false, |ext| ext == "md") {
                let db = state.search_db.as_ref().unwrap().lock().unwrap();
                let relative_path = path.to_str().unwrap_or_default().to_string();

                match event.kind {
                    notify::EventKind::Create(_) | notify::EventKind::Modify(_) => {
                        if let Ok(content) = fs::read_to_string(&path) {
                            db.execute(
                                "INSERT OR REPLACE INTO search_index (file_path, content) VALUES (?1, ?2)",
                                &[&relative_path, &content],
                            )
                            .ok();
                            println!("Indexed: {}", relative_path);
                        }
                    }
                    notify::EventKind::Remove(_) => {
                        db.execute(
                            "DELETE FROM search_index WHERE file_path = ?1",
                            &[&relative_path],
                        )
                        .ok();
                        println!("Removed: {}", relative_path);
                    }
                    _ => {}
                }
            }
        }
    }
}
