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

    /// Do not open the browser automatically.
    #[arg(short = 'b', long, action = clap::ArgAction::SetTrue)]
    no_browser: bool,

    /// Render a file tree of the current directory.
    #[arg(short = 'r', long, action = clap::ArgAction::SetTrue, conflicts_with = "file")]
    file_tree: bool,

    /// Use dark mode.
    #[arg(short = 'd', long, action = clap::ArgAction::SetTrue)]
    dark: bool,

    /// Disable live reload.
    #[arg(long, action = clap::ArgAction::SetTrue)]
    no_reload: bool,
}

#[tokio::main]
async fn main() {
    let cli = Cli::parse();

    if cli.file_tree {
        println!("File tree mode for current directory");
        return;
    }

    let file_to_render = cli.file.as_deref().unwrap_or("README.md").to_string();
    if !Path::new(&file_to_render).exists() {
        eprintln!("Error: File '{}' not found.", file_to_render);
        return;
    }

    server::start(cli.port, file_to_render).await;
}
