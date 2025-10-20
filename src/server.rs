use axum::{
    extract::{
        ws::{Message, WebSocket},
        Path as AxumPath, State, WebSocketUpgrade,
    },
    http::{header, StatusCode},
    response::{Html, IntoResponse, Response},
    routing::get,
    Router,
};
use futures_util::{stream::StreamExt, SinkExt};
use qrcode::render::unicode::Dense1x2;
use qrcode::{EcLevel, QrCode};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::fs;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use tera::Tera;
use tokio::net::TcpListener;
use tokio::sync::broadcast;

use crate::assets::{CssAssets, IconAssets, JsAssets, Templates};
use crate::markdown::MarkdownRenderer;

/// Print a compact QR code using Unicode half-blocks
fn print_compact_qr(data: &str) -> Result<(), Box<dyn std::error::Error>> {
    // Use low error correction level for smaller QR codes
    let code = QrCode::with_error_correction_level(data.as_bytes(), EcLevel::L)?;

    // Render using Dense1x2 (Unicode half-blocks: ▀▄█) for compact display
    // Dense1x2 uses 2 vertical pixels per character (half-block characters)
    // This naturally compensates for terminal fonts where character height > width
    // Note: The aspect ratio depends on the terminal font - it won't be perfect square
    // on all terminals, but Dense1x2 provides the best balance between size and readability
    let string = code
        .render::<Dense1x2>()
        .quiet_zone(false) // No quiet zone to save space
        .build();

    // Add spacing: 4 spaces on the left, blank line below
    for line in string.lines() {
        println!("    {line}"); // 4 spaces on the left
    }
    println!(); // Blank line below

    Ok(())
}

#[derive(Clone)]
struct AppState {
    file_path: Arc<Option<String>>,
    theme: Arc<String>,
    tera: Arc<Tera>,
    start_dir: Arc<std::path::PathBuf>,
    shared_annotation: bool,
    enable_viewed: bool,
    db: Option<Arc<Mutex<Connection>>>,
    tx: Option<broadcast::Sender<String>>,
}

#[derive(Serialize, Deserialize, Debug)]
#[serde(tag = "type")]
enum WebSocketMessage {
    #[serde(rename = "all_annotations")]
    AllAnnotations { annotations: Vec<serde_json::Value> },
    #[serde(rename = "new_annotation")]
    NewAnnotation { annotation: serde_json::Value },
    #[serde(rename = "delete_annotation")]
    DeleteAnnotation { id: String },
    #[serde(rename = "clear_annotations")]
    ClearAnnotations,
    #[serde(rename = "viewed_state")]
    ViewedState { state: serde_json::Value },
    #[serde(rename = "update_viewed_state")]
    UpdateViewedState { state: serde_json::Value },
}

pub async fn start(
    port: u16,
    file_path: Option<String>,
    theme: String,
    qr: Option<String>,
    open_browser: Option<String>,
    shared_annotation: bool,
    enable_viewed: bool,
) {
    // Initialize Tera template engine
    let mut tera = Tera::default();

    // Load templates from embedded resources
    for file_name in Templates::iter() {
        if let Some(file) = Templates::get(&file_name) {
            match std::str::from_utf8(&file.data) {
                Ok(content) => {
                    if let Err(e) = tera.add_raw_template(&file_name, content) {
                        eprintln!("Failed to add template '{file_name}': {e}");
                        std::process::exit(1);
                    }
                }
                Err(e) => {
                    eprintln!("Failed to read template '{file_name}': {e}");
                    std::process::exit(1);
                }
            }
        }
    }

    let start_dir = std::env::current_dir().unwrap_or_else(|_| ".".into());

    let (db, tx) = if shared_annotation {
        let db_path = std::env::var("MARKON_SQLITE_PATH").unwrap_or_else(|_| {
            let home = dirs::home_dir().expect("Cannot find home directory");
            home.join(".markon/annotation.sqlite")
                .to_string_lossy()
                .to_string()
        });

        let parent_dir = std::path::Path::new(&db_path).parent().unwrap();
        if !parent_dir.exists() {
            fs::create_dir_all(parent_dir).expect("Failed to create database directory");
        }

        let conn = Connection::open(&db_path).expect("Failed to open database");
        conn.execute(
            "CREATE TABLE IF NOT EXISTS annotations (
                id TEXT PRIMARY KEY,
                file_path TEXT NOT NULL,
                data TEXT NOT NULL
            )",
            [],
        )
        .expect("Failed to create annotations table");

        // Create viewed state table for section viewed feature
        conn.execute(
            "CREATE TABLE IF NOT EXISTS viewed_state (
                file_path TEXT PRIMARY KEY,
                state TEXT NOT NULL,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )",
            [],
        )
        .expect("Failed to create viewed_state table");

        let db = Arc::new(Mutex::new(conn));
        let tx = broadcast::channel(100).0;
        (Some(db), Some(tx))
    } else {
        (None, None)
    };

    // Clone file_path for later use in URL display
    let file_path_for_display = file_path.clone();

    let state = AppState {
        file_path: Arc::new(file_path),
        theme: Arc::new(theme),
        tera: Arc::new(tera),
        start_dir: Arc::new(start_dir),
        shared_annotation,
        enable_viewed,
        db,
        tx,
    };

    let mut app = Router::new()
        .route("/", get(root))
        .route("/_/favicon.ico", get(serve_favicon))
        .route("/_/favicon.svg", get(serve_favicon_svg))
        .route("/_/css/{filename}", get(serve_css))
        .route("/_/js/{filename}", get(serve_js))
        .route("/{*path}", get(handle_path));

    if shared_annotation {
        app = app.route("/_/ws", get(ws_handler));
    }

    let app = app.with_state(state);

    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let listener = match TcpListener::bind(&addr).await {
        Ok(listener) => listener,
        Err(e) => {
            eprintln!("Failed to bind to {addr}: {e}");
            std::process::exit(1);
        }
    };
    println!("listening on http://{addr}");

    // Display custom base URL if provided (via --qr or --open-browser)
    let custom_base_url = qr
        .as_ref()
        .filter(|url| url.as_str() != "missing")
        .or_else(|| open_browser.as_ref().filter(|url| url.as_str() != "local"));

    if let Some(base_url) = custom_base_url {
        // Append file path or directory indicator to the base URL
        let full_url = if let Some(file) = &file_path_for_display {
            // If a file is specified, append the file path
            format!("{}/{}", base_url.trim_end_matches('/'), file)
        } else {
            // If no file (directory browsing mode), append trailing slash
            if base_url.ends_with('/') {
                base_url.to_string()
            } else {
                format!("{base_url}/")
            }
        };
        println!("accessible at {full_url}");
    }

    // Generate QR code after successful bind
    if let Some(qr_option) = qr {
        println!(); // Blank line before QR code
        let qr_url = if qr_option == "missing" {
            format!("http://{addr}")
        } else {
            qr_option
        };
        if let Err(e) = print_compact_qr(&qr_url) {
            eprintln!("Failed to generate QR code: {e}");
        }
    }

    // Open browser if requested
    if let Some(base_url_option) = open_browser {
        let url = if base_url_option == "local" {
            format!("http://{addr}")
        } else {
            base_url_option
        };
        if let Err(e) = open::that(&url) {
            eprintln!("Failed to open browser: {e}");
        }
    }

    if let Err(e) = axum::serve(listener, app.into_make_service()).await {
        eprintln!("Server error: {e}");
        std::process::exit(1);
    }
}

async fn ws_handler(ws: WebSocketUpgrade, State(state): State<AppState>) -> impl IntoResponse {
    ws.on_upgrade(|socket| handle_socket(socket, state))
}

async fn handle_socket(socket: WebSocket, state: AppState) {
    let (mut sender, mut receiver) = socket.split();

    // Subscribe to the broadcast channel
    let mut rx = state.tx.as_ref().unwrap().subscribe();

    // Wait for the first message from client to get the file path
    let file_path = match receiver.next().await {
        Some(Ok(Message::Text(text))) => {
            // Expect first message to be file path
            // Convert Utf8Bytes to String
            text.to_string()
        }
        _ => {
            eprintln!("[WebSocket] Failed to receive file path from client");
            return;
        }
    };

    // Send all existing annotations to the new client
    let annotations = {
        let db = state.db.as_ref().unwrap().lock().unwrap();
        let mut stmt = db
            .prepare("SELECT data FROM annotations WHERE file_path = ?1")
            .unwrap();
        let rows = stmt
            .query_map([&file_path.as_str()], |row| row.get::<_, String>(0))
            .unwrap();
        let mut annotations = Vec::new();
        for row in rows {
            let data: serde_json::Value = serde_json::from_str(&row.unwrap()).unwrap();
            annotations.push(data);
        }
        eprintln!(
            "[WebSocket] Sending {} annotations for file_path: {}",
            annotations.len(),
            file_path
        );
        annotations
    };

    let initial_msg = WebSocketMessage::AllAnnotations { annotations };
    if sender
        .send(Message::Text(
            serde_json::to_string(&initial_msg).unwrap().into(),
        ))
        .await
        .is_err()
    {
        return;
    }

    // Send existing viewed state to the new client
    let viewed_state = {
        let db = state.db.as_ref().unwrap().lock().unwrap();
        let state_json = db
            .query_row(
                "SELECT state FROM viewed_state WHERE file_path = ?1",
                [&file_path.as_str()],
                |row| row.get::<_, String>(0),
            )
            .unwrap_or_else(|_| "{}".to_string());
        serde_json::from_str(&state_json).unwrap_or(serde_json::json!({}))
    };

    let viewed_msg = WebSocketMessage::ViewedState {
        state: viewed_state,
    };
    if sender
        .send(Message::Text(
            serde_json::to_string(&viewed_msg).unwrap().into(),
        ))
        .await
        .is_err()
    {
        return;
    }

    // Task to forward broadcast messages to the client
    let mut send_task = tokio::spawn(async move {
        while let Ok(msg) = rx.recv().await {
            if sender.send(Message::Text(msg.into())).await.is_err() {
                break;
            }
        }
    });

    // Task to handle incoming messages from the client
    let mut recv_task = {
        let state = state.clone();
        tokio::spawn(async move {
            while let Some(Ok(Message::Text(text))) = receiver.next().await {
                let msg: WebSocketMessage = match serde_json::from_str(&text) {
                    Ok(msg) => msg,
                    Err(_) => continue,
                };

                let db = state.db.as_ref().unwrap().lock().unwrap();
                match msg {
                    WebSocketMessage::NewAnnotation { annotation } => {
                        let id = annotation["id"].as_str().unwrap().to_string();
                        let data = serde_json::to_string(&annotation).unwrap();
                        db.execute(
                            "INSERT OR REPLACE INTO annotations (id, file_path, data) VALUES (?1, ?2, ?3)",
                            [&id.as_str(), &file_path.as_str(), &data.as_str()],
                        )
                        .unwrap();
                        let broadcast_msg = WebSocketMessage::NewAnnotation { annotation };
                        state
                            .tx
                            .as_ref()
                            .unwrap()
                            .send(serde_json::to_string(&broadcast_msg).unwrap())
                            .unwrap();
                    }
                    WebSocketMessage::DeleteAnnotation { id } => {
                        db.execute(
                            "DELETE FROM annotations WHERE id = ?1 AND file_path = ?2",
                            [&id.as_str(), &file_path.as_str()],
                        )
                        .unwrap();
                        let broadcast_msg = WebSocketMessage::DeleteAnnotation { id };
                        state
                            .tx
                            .as_ref()
                            .unwrap()
                            .send(serde_json::to_string(&broadcast_msg).unwrap())
                            .unwrap();
                    }
                    WebSocketMessage::ClearAnnotations => {
                        eprintln!(
                            "[WebSocket] Clearing annotations for file_path: {file_path}"
                        );
                        match db.execute(
                            "DELETE FROM annotations WHERE file_path = ?1",
                            [&file_path.as_str()],
                        ) {
                            Ok(affected_rows) => {
                                eprintln!(
                                    "[WebSocket] Deleted {affected_rows} annotation rows for file_path: {file_path}"
                                );
                                let broadcast_msg = WebSocketMessage::ClearAnnotations;
                                state
                                    .tx
                                    .as_ref()
                                    .unwrap()
                                    .send(serde_json::to_string(&broadcast_msg).unwrap())
                                    .unwrap();
                            }
                            Err(e) => {
                                eprintln!("[WebSocket] Failed to clear annotations: {e}");
                            }
                        }
                    }
                    WebSocketMessage::UpdateViewedState {
                        state: viewed_state,
                    } => {
                        let state_json = serde_json::to_string(&viewed_state).unwrap();
                        db.execute(
                            "INSERT OR REPLACE INTO viewed_state (file_path, state, updated_at) VALUES (?1, ?2, CURRENT_TIMESTAMP)",
                            [&file_path.as_str(), &state_json.as_str()],
                        )
                        .unwrap();

                        // Broadcast to other clients
                        let broadcast_msg = WebSocketMessage::ViewedState {
                            state: viewed_state,
                        };
                        state
                            .tx
                            .as_ref()
                            .unwrap()
                            .send(serde_json::to_string(&broadcast_msg).unwrap())
                            .unwrap();
                    }
                    _ => {}
                }
            }
        })
    };

    // Wait for either task to complete
    tokio::select! {
        _ = (&mut send_task) => recv_task.abort(),
        _ = (&mut recv_task) => send_task.abort(),
    };
}

async fn root(State(state): State<AppState>) -> impl IntoResponse {
    // If command-line file specified, render it
    if let Some(file_path) = state.file_path.as_ref().as_ref() {
        render_markdown_file(file_path, &state)
    } else {
        // Show directory listing for root
        render_directory_listing(&state, None)
    }
}

async fn handle_path(
    State(state): State<AppState>,
    AxumPath(path): AxumPath<String>,
) -> impl IntoResponse {
    use std::path::PathBuf;

    // Decode the path
    let decoded_path = urlencoding::decode(&path).unwrap_or_else(|_| path.clone().into());
    let requested_path = PathBuf::from(decoded_path.as_ref());
    let full_path = state.start_dir.join(&requested_path);

    // Canonicalize and check if path exists
    let canonical_path = match full_path.canonicalize() {
        Ok(p) => p,
        Err(_) => {
            return (
                StatusCode::NOT_FOUND,
                format!("Path not found: {decoded_path}"),
            )
                .into_response();
        }
    };

    // Security check: ensure the canonical path is under start_dir
    if !canonical_path.starts_with(&*state.start_dir) {
        return (
            StatusCode::FORBIDDEN,
            "Access denied: path outside allowed directory",
        )
            .into_response();
    }

    // Check if it's a file or directory
    if canonical_path.is_file() {
        // Check if it's a markdown file
        if canonical_path
            .extension()
            .is_some_and(|ext| ext.to_string_lossy().to_lowercase() == "md")
        {
            render_markdown_file(&decoded_path, &state)
        } else {
            // Serve other files (images, videos, etc.) as static content
            serve_file(&canonical_path)
        }
    } else if canonical_path.is_dir() {
        // Show directory listing
        render_directory_listing(&state, Some(&decoded_path))
    } else {
        (StatusCode::NOT_FOUND, "Path not found").into_response()
    }
}

fn render_markdown_file(file_path: &str, state: &AppState) -> Response {
    match fs::read_to_string(file_path) {
        Ok(markdown_input) => {
            let renderer = MarkdownRenderer::new(&state.theme);
            let (html_content, has_mermaid, toc) = renderer.render(&markdown_input);

            let mut context = tera::Context::new();
            context.insert("title", &format!("markon - {file_path}"));
            context.insert("file_path", file_path);
            context.insert("theme", state.theme.as_str());
            context.insert("content", &html_content);
            context.insert("show_back_link", &true);
            context.insert("has_mermaid", &has_mermaid);
            context.insert("toc", &toc);
            context.insert("shared_annotation", &state.shared_annotation);
            context.insert("enable_viewed", &state.enable_viewed);

            match state.tera.render("layout.html", &context) {
                Ok(html) => Html(html).into_response(),
                Err(e) => (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    format!("Template error: {e}"),
                )
                    .into_response(),
            }
        }
        Err(e) => {
            let mut context = tera::Context::new();
            context.insert("title", "Error");
            context.insert("theme", state.theme.as_str());
            context.insert(
                "content",
                &format!(
                    r#"<p style="color: red;">Error reading file '{file_path}': {e}</p>
                       <a href="/">← Back to file list</a>"#
                ),
            );
            context.insert("show_back_link", &false);
            context.insert("has_mermaid", &false);

            match state.tera.render("layout.html", &context) {
                Ok(html) => Html(html).into_response(),
                Err(e) => (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    format!("Template error: {e}"),
                )
                    .into_response(),
            }
        }
    }
}

fn render_directory_listing(state: &AppState, dir_param: Option<&str>) -> Response {
    use std::path::PathBuf;

    // Determine the directory to list
    let current_dir = if let Some(dir_str) = dir_param {
        let requested_path = PathBuf::from(dir_str);
        // Ensure the path is absolute or relative to start_dir
        if requested_path.is_absolute() {
            requested_path
        } else {
            state.start_dir.join(&requested_path)
        }
    } else {
        state.start_dir.as_ref().clone()
    };

    // Canonicalize to resolve .. and .
    let current_dir = match current_dir.canonicalize() {
        Ok(path) => path,
        Err(e) => {
            return (StatusCode::BAD_REQUEST, format!("Invalid directory: {e}")).into_response();
        }
    };

    #[derive(serde::Serialize)]
    struct Entry {
        name: String,
        is_dir: bool,
        link: String,
    }

    let mut entries: Vec<Entry> = match fs::read_dir(&current_dir) {
        Ok(dir_entries) => dir_entries
            .filter_map(|e| e.ok())
            .filter_map(|entry| {
                let path = entry.path();
                let name = entry.file_name().to_string_lossy().to_string();

                // Ignore hidden files
                if name.starts_with('.') {
                    return None;
                }

                let is_dir = path.is_dir();

                if is_dir {
                    // Calculate relative path from start_dir for the link
                    let relative_path = path
                        .strip_prefix(&*state.start_dir)
                        .unwrap_or(&path)
                        .to_string_lossy()
                        .to_string();
                    Some(Entry {
                        name,
                        is_dir: true,
                        link: format!("/{relative_path}"),
                    })
                } else {
                    // Only show Markdown files (case insensitive)
                    let is_markdown = path
                        .extension()
                        .is_some_and(|ext| ext.to_string_lossy().to_lowercase() == "md");

                    if is_markdown {
                        // Calculate relative path from start_dir for the link
                        let relative_path = path
                            .strip_prefix(&*state.start_dir)
                            .unwrap_or(&path)
                            .to_string_lossy()
                            .to_string();
                        Some(Entry {
                            name,
                            is_dir: false,
                            link: format!("/{relative_path}"),
                        })
                    } else {
                        None
                    }
                }
            })
            .collect(),
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("Error reading directory: {e}"),
            )
                .into_response();
        }
    };

    // Sort: directories first, then files, both alphabetically
    entries.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.cmp(&b.name),
    });

    // Check if we can show parent directory link
    let show_parent = current_dir != *state.start_dir;
    let parent_link = if show_parent {
        if let Some(parent) = current_dir.parent() {
            let relative_path = parent
                .strip_prefix(&*state.start_dir)
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_else(|_| String::new());

            if relative_path.is_empty() {
                Some("/".to_string())
            } else {
                Some(format!("/{relative_path}"))
            }
        } else {
            None
        }
    } else {
        None
    };

    let mut context = tera::Context::new();
    context.insert("theme", state.theme.as_str());
    context.insert("current_dir", &current_dir.display().to_string());
    context.insert("entries", &entries);
    context.insert("show_parent", &show_parent);
    context.insert("parent_link", &parent_link);

    match state.tera.render("directory.html", &context) {
        Ok(html) => Html(html).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Template error: {e}"),
        )
            .into_response(),
    }
}

async fn serve_favicon() -> impl IntoResponse {
    // Redirect /_/favicon.ico to /_/favicon.svg
    (
        StatusCode::MOVED_PERMANENTLY,
        [(header::LOCATION, "/_/favicon.svg")],
    )
        .into_response()
}

async fn serve_favicon_svg() -> impl IntoResponse {
    serve_static_file("favicon.svg", IconAssets::get, "image/svg+xml")
}

async fn serve_css(AxumPath(filename): AxumPath<String>) -> impl IntoResponse {
    serve_static_file(&filename, CssAssets::get, "text/css")
}

async fn serve_js(AxumPath(filename): AxumPath<String>) -> impl IntoResponse {
    serve_static_file(&filename, JsAssets::get, "application/javascript")
}

fn serve_static_file<F>(filename: &str, getter: F, content_type: &str) -> Response
where
    F: FnOnce(&str) -> Option<rust_embed::EmbeddedFile>,
{
    match getter(filename) {
        Some(file) => (
            StatusCode::OK,
            [(header::CONTENT_TYPE, content_type)],
            file.data.into_owned(),
        )
            .into_response(),
        None => (StatusCode::NOT_FOUND, "File not found").into_response(),
    }
}

fn serve_file(path: &std::path::Path) -> Response {
    match fs::read(path) {
        Ok(content) => {
            // Detect MIME type based on file extension
            let mime_type = path
                .extension()
                .and_then(|ext| ext.to_str())
                .and_then(get_mime_type)
                .unwrap_or("application/octet-stream");

            (StatusCode::OK, [(header::CONTENT_TYPE, mime_type)], content).into_response()
        }
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Error reading file: {e}"),
        )
            .into_response(),
    }
}

fn get_mime_type(ext: &str) -> Option<&'static str> {
    match ext.to_lowercase().as_str() {
        // Images
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        "svg" => Some("image/svg+xml"),
        "ico" => Some("image/x-icon"),
        "bmp" => Some("image/bmp"),

        // Audio
        "mp3" => Some("audio/mpeg"),
        "wav" => Some("audio/wav"),
        "ogg" => Some("audio/ogg"),
        "m4a" => Some("audio/mp4"),
        "flac" => Some("audio/flac"),

        // Video
        "mp4" => Some("video/mp4"),
        "webm" => Some("video/webm"),
        "ogv" => Some("video/ogg"),
        "avi" => Some("video/x-msvideo"),
        "mov" => Some("video/quicktime"),
        "mkv" => Some("video/x-matroska"),

        // Documents
        "pdf" => Some("application/pdf"),
        "txt" => Some("text/plain"),
        "json" => Some("application/json"),
        "xml" => Some("application/xml"),

        // Archives
        "zip" => Some("application/zip"),
        "tar" => Some("application/x-tar"),
        "gz" => Some("application/gzip"),
        "7z" => Some("application/x-7z-compressed"),

        _ => None,
    }
}
