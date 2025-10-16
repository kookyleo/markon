use axum::{
    extract::State,
    response::{Html, IntoResponse},
    routing::get,
    Router,
};
use std::fs;
use std::net::SocketAddr;
use std::sync::Arc;
use tokio::net::TcpListener;

use crate::markdown;

#[derive(Clone)]
struct AppState {
    file_path: Arc<String>,
}

pub async fn start(port: u16, file_path: String) {
    let state = AppState {
        file_path: Arc::new(file_path),
    };

    let app = Router::new().route("/", get(root)).with_state(state);

    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let listener = TcpListener::bind(&addr).await.unwrap();
    println!("listening on http://{}", addr);

    axum::serve(listener, app.into_make_service())
        .await
        .unwrap();
}

async fn root(State(state): State<AppState>) -> impl IntoResponse {
    match fs::read_to_string(state.file_path.as_str()) {
        Ok(markdown_input) => {
            let html_output = markdown::to_html(&markdown_input);
            let full_html = format!(
                r#"
<!DOCTYPE html>
<html>
<head>
    <title>markon</title>
</head>
<body>
    {}
</body>
</html>
"#,
                html_output,
            );
            Html(full_html)
        }
        Err(e) => {
            let error_html = format!("<p>Error reading file: {}</p>", e);
            Html(error_html)
        }
    }
}
