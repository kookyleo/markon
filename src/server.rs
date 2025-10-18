use axum::{
    extract::{Path as AxumPath, State},
    http::{header, StatusCode},
    response::{Html, IntoResponse, Response},
    routing::get,
    Router,
};
use qrcode::render::unicode::Dense1x2;
use qrcode::{EcLevel, QrCode};
use std::fs;
use std::net::SocketAddr;
use std::sync::Arc;
use tera::Tera;
use tokio::net::TcpListener;

use crate::assets::{CssAssets, JsAssets, Templates};
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
}

pub async fn start(
    port: u16,
    file_path: Option<String>,
    theme: String,
    qr: Option<String>,
    open_browser: Option<String>,
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

    let state = AppState {
        file_path: Arc::new(file_path),
        theme: Arc::new(theme),
        tera: Arc::new(tera),
        start_dir: Arc::new(start_dir),
    };

    let app = Router::new()
        .route("/", get(root))
        .route("/static/css/:filename", get(serve_css))
        .route("/static/js/:filename", get(serve_js))
        .route("/*path", get(handle_path))
        .with_state(state);

    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let listener = match TcpListener::bind(&addr).await {
        Ok(listener) => listener,
        Err(e) => {
            eprintln!("Failed to bind to {addr}: {e}");
            std::process::exit(1);
        }
    };
    println!("listening on http://{addr}");

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
