mod assets;
mod markdown;
mod server;

use clap::Parser;
use std::path::Path;

/// Preview Markdown files locally with GitHub styling.
#[derive(Parser, Debug)]
#[command(author, version, about, long_about = None)]
struct Cli {
    /// The markdown file to render.
    file: Option<String>,

    /// The port to use for the server.
    #[arg(short, long, default_value_t = 6419)]
    port: u16,

    /// Theme selection (light, dark, auto).
    #[arg(short = 't', long, default_value = "auto")]
    theme: String,
}

#[tokio::main]
async fn main() {
    let cli = Cli::parse();

    // Validate theme parameter
    let theme = match cli.theme.as_str() {
        "light" | "dark" | "auto" => cli.theme.clone(),
        _ => {
            eprintln!("Invalid theme '{}'. Use: light, dark, or auto", cli.theme);
            return;
        }
    };

    let file_to_render = if let Some(file) = cli.file {
        if !Path::new(&file).exists() {
            eprintln!("Error: File '{file}' not found.");
            return;
        }
        Some(file)
    } else {
        None
    };

    server::start(cli.port, file_to_render, theme).await;
}
