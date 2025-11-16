use crate::server::AppState;
use axum::{
    extract::{Query, State},
    response::IntoResponse,
    Json,
};
use notify::{EventKind, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::Path,
    sync::{Arc, Mutex},
};
use tantivy::{
    collector::TopDocs, query::QueryParser, schema::*, snippet::SnippetGenerator, Index,
    IndexReader, IndexWriter, TantivyDocument,
};
use tantivy_jieba::JiebaTokenizer;
use walkdir::WalkDir;

#[derive(Deserialize)]
pub struct SearchQuery {
    pub q: String,
}

#[derive(Serialize)]
pub struct SearchResult {
    file_path: String,
    file_name: String,
    title: String,
    snippet: String,
}

pub struct SearchIndex {
    index: Index,
    reader: IndexReader,
    writer: Arc<Mutex<IndexWriter>>,
    #[allow(dead_code)]
    schema: Schema,
    field_path: Field,
    field_file_name: Field,
    field_title: Field,
    field_content: Field,
}

impl SearchIndex {
    pub fn new(start_dir: &Path) -> tantivy::Result<Self> {
        // Build schema
        let mut schema_builder = Schema::builder();

        let text_options = TextOptions::default()
            .set_indexing_options(
                TextFieldIndexing::default()
                    .set_tokenizer("jieba")
                    .set_index_option(IndexRecordOption::WithFreqsAndPositions),
            )
            .set_stored();

        let field_path = schema_builder.add_text_field("path", STORED);
        let field_file_name = schema_builder.add_text_field("file_name", text_options.clone());
        let field_title = schema_builder.add_text_field("title", text_options.clone());
        let field_content = schema_builder.add_text_field("content", text_options);

        let schema = schema_builder.build();

        // Create index in RAM
        let index = Index::create_in_ram(schema.clone());

        // Register jieba tokenizer
        index.tokenizers().register("jieba", JiebaTokenizer {});

        // Create writer and reader
        let writer = index.writer(50_000_000)?;
        let reader = index.reader()?;

        let search_index = Self {
            index,
            reader,
            writer: Arc::new(Mutex::new(writer)),
            schema,
            field_path,
            field_file_name,
            field_title,
            field_content,
        };

        // Index all markdown files
        search_index.index_directory(start_dir)?;

        Ok(search_index)
    }

    fn index_directory(&self, dir: &Path) -> tantivy::Result<()> {
        println!("Indexing markdown files in {:?}...", dir);

        for entry in WalkDir::new(dir)
            .into_iter()
            .filter_map(Result::ok)
            .filter(|e| e.path().extension().is_some_and(|ext| ext == "md"))
        {
            let path = entry.path();
            if let Ok(content) = fs::read_to_string(path) {
                self.index_file(path, &content)?;
            }
        }

        let mut writer = self.writer.lock().unwrap();
        writer.commit()?;
        println!("Indexing complete!");

        Ok(())
    }

    fn index_file(&self, path: &Path, content: &str) -> tantivy::Result<()> {
        let relative_path = path.to_string_lossy().to_string();
        let file_name = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();

        // Extract title from first heading or filename
        let title = content
            .lines()
            .find(|line| line.starts_with('#'))
            .map(|line| line.trim_start_matches('#').trim().to_string())
            .unwrap_or_else(|| file_name.clone());

        let mut doc = TantivyDocument::default();
        doc.add_text(self.field_path, &relative_path);
        doc.add_text(self.field_file_name, &file_name);
        doc.add_text(self.field_title, &title);
        doc.add_text(self.field_content, content);

        let writer = self.writer.lock().unwrap();
        writer.add_document(doc)?;

        Ok(())
    }

    pub fn search(&self, query_str: &str, limit: usize) -> tantivy::Result<Vec<SearchResult>> {
        let searcher = self.reader.searcher();

        // Search across file_name, title, and content
        let query_parser = QueryParser::for_index(
            &self.index,
            vec![self.field_file_name, self.field_title, self.field_content],
        );

        let query = query_parser.parse_query(query_str)?;
        let top_docs = searcher.search(&query, &TopDocs::with_limit(limit))?;

        let mut results = Vec::new();
        let snippet_generator = SnippetGenerator::create(&searcher, &query, self.field_content)?;

        for (_score, doc_address) in top_docs {
            let retrieved_doc: TantivyDocument = searcher.doc(doc_address)?;

            let file_path = retrieved_doc
                .get_first(self.field_path)
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();

            let file_name = retrieved_doc
                .get_first(self.field_file_name)
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();

            let title = retrieved_doc
                .get_first(self.field_title)
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();

            let snippet = snippet_generator.snippet_from_doc(&retrieved_doc);
            let snippet_html = snippet.to_html();

            results.push(SearchResult {
                file_path,
                file_name,
                title,
                snippet: snippet_html,
            });
        }

        Ok(results)
    }

    pub fn update_file(&self, path: &Path) -> tantivy::Result<()> {
        if path.extension().is_none_or(|ext| ext != "md") {
            return Ok(());
        }

        let content = fs::read_to_string(path)?;
        let relative_path = path.to_string_lossy().to_string();

        // Delete old document
        let writer = self.writer.lock().unwrap();
        let term = Term::from_field_text(self.field_path, &relative_path);
        writer.delete_term(term);

        // Re-add document
        drop(writer);
        self.index_file(path, &content)?;

        let mut writer = self.writer.lock().unwrap();
        writer.commit()?;

        println!("Updated index: {}", relative_path);
        Ok(())
    }

    pub fn delete_file(&self, path: &Path) -> tantivy::Result<()> {
        let relative_path = path.to_string_lossy().to_string();
        let mut writer = self.writer.lock().unwrap();
        let term = Term::from_field_text(self.field_path, &relative_path);
        writer.delete_term(term);
        writer.commit()?;

        println!("Removed from index: {}", relative_path);
        Ok(())
    }
}

pub async fn search_handler(
    State(state): State<AppState>,
    Query(query): Query<SearchQuery>,
) -> impl IntoResponse {
    if !state.enable_search || query.q.is_empty() {
        return Json(Vec::<SearchResult>::new());
    }

    let search_index = match state.search_index {
        Some(ref index) => index.clone(),
        None => return Json(Vec::new()),
    };

    let results = search_index.search(&query.q, 20).unwrap_or_else(|e| {
        eprintln!("Search error: {}", e);
        Vec::new()
    });

    Json(results)
}

pub fn start_file_watcher(state: AppState) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let search_index = match state.search_index {
        Some(index) => index,
        None => return Ok(()),
    };

    let start_dir = state.start_dir.as_ref().clone();

    std::thread::spawn(move || {
        let (tx, rx) = std::sync::mpsc::channel();

        let mut watcher = notify::recommended_watcher(move |res: Result<notify::Event, _>| {
            if let Ok(event) = res {
                let _ = tx.send(event);
            }
        })
        .unwrap();

        watcher.watch(&start_dir, RecursiveMode::Recursive).unwrap();

        println!("Watching for file changes in {:?}", start_dir);

        while let Ok(event) = rx.recv() {
            for path in event.paths {
                match event.kind {
                    EventKind::Create(_) | EventKind::Modify(_) => {
                        if let Err(e) = search_index.update_file(&path) {
                            eprintln!("Error updating index: {}", e);
                        }
                    }
                    EventKind::Remove(_) => {
                        if let Err(e) = search_index.delete_file(&path) {
                            eprintln!("Error removing from index: {}", e);
                        }
                    }
                    _ => {}
                }
            }
        }
    });

    Ok(())
}
