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
    path::{Path, PathBuf},
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
    pub file_path: String,
    pub file_name: String,
    pub title: String,
    pub snippet: String,
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
    start_dir: PathBuf,
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

        // Use STRING for path field - indexed but not tokenized, so we can delete by exact match
        let field_path = schema_builder.add_text_field("path", STRING | STORED);
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
            start_dir: start_dir.to_path_buf(),
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
        drop(writer);

        // Reload reader to see the committed changes
        self.reader.reload()?;
        println!("Indexing complete!");

        Ok(())
    }

    fn index_file(&self, path: &Path, content: &str) -> tantivy::Result<()> {
        // Calculate relative path from start_dir
        let relative_path = path
            .strip_prefix(&self.start_dir)
            .unwrap_or(path)
            .to_string_lossy()
            .to_string();

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
        // Calculate relative path from start_dir
        let relative_path = path
            .strip_prefix(&self.start_dir)
            .unwrap_or(path)
            .to_string_lossy()
            .to_string();

        let file_name = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();

        let title = content
            .lines()
            .find(|line| line.starts_with('#'))
            .map(|line| line.trim_start_matches('#').trim().to_string())
            .unwrap_or_else(|| file_name.clone());

        let mut doc = TantivyDocument::default();
        doc.add_text(self.field_path, &relative_path);
        doc.add_text(self.field_file_name, &file_name);
        doc.add_text(self.field_title, &title);
        doc.add_text(self.field_content, &content);

        // Delete and re-add in same transaction
        let mut writer = self.writer.lock().unwrap();
        let term = Term::from_field_text(self.field_path, &relative_path);
        writer.delete_term(term);
        writer.add_document(doc)?;
        writer.commit()?;
        drop(writer);

        // Reload reader to see the changes
        self.reader.reload()?;

        println!("Updated index: {}", relative_path);
        Ok(())
    }

    pub fn delete_file(&self, path: &Path) -> tantivy::Result<()> {
        // Calculate relative path from start_dir
        let relative_path = path
            .strip_prefix(&self.start_dir)
            .unwrap_or(path)
            .to_string_lossy()
            .to_string();

        let mut writer = self.writer.lock().unwrap();
        let term = Term::from_field_text(self.field_path, &relative_path);
        writer.delete_term(term);
        writer.commit()?;
        drop(writer);

        // Reload reader to see the changes
        self.reader.reload()?;

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

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn create_test_file(dir: &Path, name: &str, content: &str) -> std::io::Result<()> {
        let file_path = dir.join(name);
        fs::write(file_path, content)
    }

    #[test]
    fn test_search_index_creation() {
        let temp_dir = TempDir::new().unwrap();
        let dir_path = temp_dir.path();

        // Create test markdown files
        create_test_file(dir_path, "test1.md", "# Test Title\nThis is test content.").unwrap();
        create_test_file(dir_path, "test2.md", "# Another Title\nMore content here.").unwrap();

        let index = SearchIndex::new(dir_path).unwrap();

        // Verify index was created
        assert!(index.reader.searcher().num_docs() >= 2);
    }

    #[test]
    fn test_search_basic() {
        let temp_dir = TempDir::new().unwrap();
        let dir_path = temp_dir.path();

        create_test_file(dir_path, "rust.md", "# Rust Programming\nRust is a systems programming language.").unwrap();
        create_test_file(dir_path, "python.md", "# Python Guide\nPython is easy to learn.").unwrap();

        let index = SearchIndex::new(dir_path).unwrap();

        let results = index.search("Rust", 10).unwrap();
        assert_eq!(results.len(), 1);
        assert!(results[0].title.contains("Rust"));
    }

    #[test]
    fn test_search_chinese() {
        let temp_dir = TempDir::new().unwrap();
        let dir_path = temp_dir.path();

        create_test_file(dir_path, "chinese.md", "# 中文测试\n这是一个中文搜索测试文档。").unwrap();
        create_test_file(dir_path, "english.md", "# English Test\nThis is an English document.").unwrap();

        let index = SearchIndex::new(dir_path).unwrap();

        // Test Chinese search
        let results = index.search("中文", 10).unwrap();
        assert_eq!(results.len(), 1);
        assert!(results[0].title.contains("中文"));

        // Test mixed search
        let results = index.search("测试", 10).unwrap();
        assert_eq!(results.len(), 1);
    }

    #[test]
    fn test_search_multi_field() {
        let temp_dir = TempDir::new().unwrap();
        let dir_path = temp_dir.path();

        create_test_file(dir_path, "hello.md", "# Hello World\nContent about greetings.").unwrap();
        create_test_file(dir_path, "world.md", "# Universe\nThe world is vast.").unwrap();
        create_test_file(dir_path, "test.md", "# Testing\nAnother document.").unwrap();

        let index = SearchIndex::new(dir_path).unwrap();

        // Search should find "greetings" in content only
        let results = index.search("greetings", 10).unwrap();
        assert_eq!(results.len(), 1);

        // Search for "Hello" should find in title
        let results = index.search("Hello", 10).unwrap();
        assert!(results.len() >= 1);
    }

    #[test]
    fn test_update_file() {
        let temp_dir = TempDir::new().unwrap();
        let dir_path = temp_dir.path();
        let file_path = dir_path.join("update.md");

        // Create initial file
        create_test_file(dir_path, "update.md", "# Original Title\nOriginal content.").unwrap();

        let index = SearchIndex::new(dir_path).unwrap();

        // Verify original content
        let results = index.search("Original", 10).unwrap();
        assert_eq!(results.len(), 1);

        // Update file
        fs::write(&file_path, "# Updated Title\nUpdated content.").unwrap();
        index.update_file(&file_path).unwrap();

        // Search for new content
        let results = index.search("Updated", 10).unwrap();
        assert_eq!(results.len(), 1);

        // Old content should not be found
        let results = index.search("Original", 10).unwrap();
        assert_eq!(results.len(), 0);
    }

    #[test]
    fn test_delete_file() {
        let temp_dir = TempDir::new().unwrap();
        let dir_path = temp_dir.path();
        let file_path = dir_path.join("delete.md");

        create_test_file(dir_path, "delete.md", "# Delete Me\nThis will be deleted.").unwrap();

        let index = SearchIndex::new(dir_path).unwrap();

        // Verify file is indexed
        let results = index.search("Delete", 10).unwrap();
        assert_eq!(results.len(), 1);

        // Delete file
        index.delete_file(&file_path).unwrap();

        // Verify file is removed from index
        let results = index.search("Delete", 10).unwrap();
        assert_eq!(results.len(), 0);
    }

    #[test]
    fn test_search_snippet_generation() {
        let temp_dir = TempDir::new().unwrap();
        let dir_path = temp_dir.path();

        create_test_file(
            dir_path,
            "snippet.md",
            "# Snippet Test\nThis document contains important information about snippets. Snippets are useful."
        ).unwrap();

        let index = SearchIndex::new(dir_path).unwrap();

        let results = index.search("snippets", 10).unwrap();
        assert_eq!(results.len(), 1);
        assert!(!results[0].snippet.is_empty());
        // Snippet should contain highlighted text (HTML tags)
        assert!(results[0].snippet.contains("<b>") || results[0].snippet.contains("snippet"));
    }

    #[test]
    fn test_ignore_non_markdown_files() {
        let temp_dir = TempDir::new().unwrap();
        let dir_path = temp_dir.path();

        create_test_file(dir_path, "test.md", "# Markdown\nThis is markdown.").unwrap();
        create_test_file(dir_path, "test.txt", "# Not Markdown\nThis is text.").unwrap();

        let index = SearchIndex::new(dir_path).unwrap();

        // Should find markdown file
        let results = index.search("Markdown", 10).unwrap();
        assert_eq!(results.len(), 1);

        // Should not find text file
        let results = index.search("text", 10).unwrap();
        assert_eq!(results.len(), 0);
    }

    #[test]
    fn test_empty_query() {
        let temp_dir = TempDir::new().unwrap();
        let dir_path = temp_dir.path();

        create_test_file(dir_path, "test.md", "# Test\nContent").unwrap();

        let index = SearchIndex::new(dir_path).unwrap();

        // Empty query should return error or empty results
        let results = index.search("", 10);
        assert!(results.is_err() || results.unwrap().is_empty());
    }

    #[test]
    fn test_title_extraction() {
        let temp_dir = TempDir::new().unwrap();
        let dir_path = temp_dir.path();

        // File with heading
        create_test_file(dir_path, "with-title.md", "# Main Title\nContent").unwrap();

        // File without heading (should use filename)
        create_test_file(dir_path, "no-title.md", "Just content without heading").unwrap();

        let index = SearchIndex::new(dir_path).unwrap();

        let results = index.search("Main", 10).unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].title, "Main Title");

        let results = index.search("no-title", 10).unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].title, "no-title");
    }

    #[test]
    fn test_search_limit() {
        let temp_dir = TempDir::new().unwrap();
        let dir_path = temp_dir.path();

        // Create multiple files with common content
        for i in 0..10 {
            create_test_file(
                dir_path,
                &format!("file{}.md", i),
                "# Document\nCommon content"
            ).unwrap();
        }

        let index = SearchIndex::new(dir_path).unwrap();

        // Test limit works
        let results = index.search("Common", 5).unwrap();
        assert_eq!(results.len(), 5);

        let results = index.search("Common", 20).unwrap();
        assert_eq!(results.len(), 10);
    }
}
