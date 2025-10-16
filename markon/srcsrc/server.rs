use axum::{
    routing::get,
    Router,
    response::Html,
};
use std::net::SocketAddr;
use tokio::net::TcpListener;

pub async fn start(port: u16, content: String) {
    let app = Router::new().route("/", get(move || async { Html(content) }));

    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let listener = TcpListener::bind(&addr).await.unwrap();
    println!("listening on http://{}", addr);

    axum::serve(listener, app.into_make_service())
        .await
        .unwrap();
}
