use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, MutexGuard},
};
use tantivy::{
    collector::TopDocs,
    query::QueryParser,
    schema::*,
    snippet::SnippetGenerator,
    tokenizer::{LowerCaser, TextAnalyzer},
    Index, IndexReader, IndexWriter, TantivyDocument, TantivyError,
};
use tantivy_jieba::JiebaTokenizer;
use walkdir::WalkDir;

/// Query string for `GET /_/{workspace_id}/search?q=…`.
#[derive(Deserialize)]
pub struct SearchQuery {
    pub q: String,
}

/// One hit returned by the workspace search endpoint.
#[derive(Serialize, Debug)]
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
    field_path: Field,
    field_file_name: Field,
    field_title: Field,
    field_content: Field,
    start_dir: PathBuf,
}

impl SearchIndex {
    /// Build an empty index whose schema/tokenizer/reader/writer are wired up
    /// but which holds no documents yet. `start_dir` is the prefix that
    /// `rel_path` strips, so stored `path` values stay relative and consistent
    /// across [`Self::new`], [`Self::new_single_file`], and `update_file`.
    fn empty(start_dir: &Path) -> tantivy::Result<Self> {
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
        let index = Index::create_in_ram(schema);

        // Register jieba + a LowerCaser so search is case-insensitive for Latin
        // text (CJK has no case, so jieba's output is unaffected). The same
        // analyzer runs at index and query time, so both sides lower-case
        // consistently — "Hello" matches "hello".
        let analyzer = TextAnalyzer::builder(JiebaTokenizer {})
            .filter(LowerCaser)
            .build();
        index.tokenizers().register("jieba", analyzer);

        // Create writer and reader
        let writer = index.writer(50_000_000)?;
        let reader = index.reader()?;

        Ok(Self {
            index,
            reader,
            writer: Arc::new(Mutex::new(writer)),
            field_path,
            field_file_name,
            field_title,
            field_content,
            start_dir: start_dir.to_path_buf(),
        })
    }

    pub fn new(start_dir: &Path) -> tantivy::Result<Self> {
        let search_index = Self::empty(start_dir)?;

        // Index all markdown files
        search_index.index_directory(start_dir)?;

        Ok(search_index)
    }

    /// Build an index scoped to a SINGLE file inside `start_dir`.
    ///
    /// Unlike [`Self::new`], this never walks `start_dir`: the resulting index
    /// contains exactly one document — `start_dir/file_name` — so a single-file
    /// workspace cannot leak sibling files through search. `start_dir` is still
    /// the parent directory so the stored `path` is just `file_name`, matching
    /// what the single-file watcher passes to `update_file` on later edits.
    pub fn new_single_file(start_dir: &Path, file_name: &str) -> tantivy::Result<Self> {
        let search_index = Self::empty(start_dir)?;
        search_index.index_single_file(file_name)?;
        Ok(search_index)
    }

    /// Index exactly the pinned file (`start_dir/file_name`). Non-markdown or
    /// unreadable targets leave the index empty rather than erroring, mirroring
    /// the silent-skip behaviour of `index_directory`.
    fn index_single_file(&self, file_name: &str) -> tantivy::Result<()> {
        let path = self.start_dir.join(file_name);
        tracing::info!("indexing single file {path:?}");

        if path.extension().is_some_and(|ext| ext == "md") {
            if let Ok(content) = fs::read_to_string(&path) {
                let doc = self.build_document(&path, &content);
                let mut writer = self.writer()?;
                writer.add_document(doc)?;
                writer.commit()?;
            }
        }

        self.reader.reload()?;
        tracing::info!("single-file indexing complete");
        Ok(())
    }

    /// Acquire the writer lock, mapping poisoning to a tantivy error
    /// instead of panicking. All writer access in this module goes
    /// through this helper so that a panic in one indexing path cannot
    /// take down later writes.
    fn writer(&self) -> tantivy::Result<MutexGuard<'_, IndexWriter>> {
        self.writer.lock().map_err(|err| {
            TantivyError::SystemError(format!("search index writer mutex poisoned: {err}"))
        })
    }

    fn index_directory(&self, dir: &Path) -> tantivy::Result<()> {
        use rayon::prelude::*;

        tracing::info!("indexing markdown files in {dir:?}");

        let paths: Vec<PathBuf> = WalkDir::new(dir)
            .into_iter()
            .filter_map(Result::ok)
            .filter(|e| e.path().extension().is_some_and(|ext| ext == "md"))
            .map(|e| e.into_path())
            .collect();

        // Stage 1: parallel CPU-bound work. Each worker reads its file
        // and builds the TantivyDocument without ever touching the
        // writer lock, so rayon's parallelism is no longer serialised
        // on a single mutex. Unreadable files are silently skipped, as
        // before.
        let docs: Vec<TantivyDocument> = paths
            .par_iter()
            .filter_map(|path| {
                let content = fs::read_to_string(path).ok()?;
                Some(self.build_document(path, &content))
            })
            .collect();

        // Stage 2: serial write phase. Acquire the writer lock exactly
        // once, batch every add_document, then commit. The guard is
        // dropped at the end of the block, before reload(), so
        // concurrent readers are not blocked any longer than needed.
        {
            let mut writer = self.writer()?;
            for doc in docs {
                writer.add_document(doc)?;
            }
            writer.commit()?;
        }

        self.reader.reload()?;
        tracing::info!("indexing complete");

        Ok(())
    }

    /// Path relative to `start_dir`, as stored in the `path` field and
    /// used as the delete term for updates and removals.
    fn rel_path(&self, path: &Path) -> String {
        path.strip_prefix(&self.start_dir)
            .unwrap_or(path)
            .to_string_lossy()
            .to_string()
    }

    /// Build a TantivyDocument for `path` with `content`. Pure CPU
    /// work — does not touch the writer. Safe to call from rayon
    /// workers in parallel.
    fn build_document(&self, path: &Path, content: &str) -> TantivyDocument {
        let relative_path = self.rel_path(path);

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
        doc
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
        let doc = self.build_document(path, &content);
        let relative_path = self.rel_path(path);

        // Delete and re-add in same transaction
        {
            let mut writer = self.writer()?;
            let term = Term::from_field_text(self.field_path, &relative_path);
            writer.delete_term(term);
            writer.add_document(doc)?;
            writer.commit()?;
        }

        // Reload reader to see the changes
        self.reader.reload()?;

        tracing::debug!("updated index: {}", relative_path);
        Ok(())
    }

    pub fn delete_file(&self, path: &Path) -> tantivy::Result<()> {
        let relative_path = self.rel_path(path);

        {
            let mut writer = self.writer()?;
            let term = Term::from_field_text(self.field_path, &relative_path);
            writer.delete_term(term);
            writer.commit()?;
        }

        // Reload reader to see the changes
        self.reader.reload()?;

        tracing::debug!("removed from index: {}", relative_path);
        Ok(())
    }
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

        create_test_file(
            dir_path,
            "rust.md",
            "# Rust Programming\nRust is a systems programming language.",
        )
        .unwrap();
        create_test_file(
            dir_path,
            "python.md",
            "# Python Guide\nPython is easy to learn.",
        )
        .unwrap();

        let index = SearchIndex::new(dir_path).unwrap();

        let results = index.search("Rust", 10).unwrap();
        assert_eq!(results.len(), 1);
        assert!(results[0].title.contains("Rust"));
    }

    #[test]
    fn test_search_chinese() {
        let temp_dir = TempDir::new().unwrap();
        let dir_path = temp_dir.path();

        create_test_file(
            dir_path,
            "chinese.md",
            "# 中文测试\n这是一个中文搜索测试文档。",
        )
        .unwrap();
        create_test_file(
            dir_path,
            "english.md",
            "# English Test\nThis is an English document.",
        )
        .unwrap();

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

        create_test_file(
            dir_path,
            "hello.md",
            "# Hello World\nContent about greetings.",
        )
        .unwrap();
        create_test_file(dir_path, "world.md", "# Universe\nThe world is vast.").unwrap();
        create_test_file(dir_path, "test.md", "# Testing\nAnother document.").unwrap();

        let index = SearchIndex::new(dir_path).unwrap();

        // Search should find "greetings" in content only
        let results = index.search("greetings", 10).unwrap();
        assert_eq!(results.len(), 1);

        // Search for "Hello" should find in title
        let results = index.search("Hello", 10).unwrap();
        assert!(!results.is_empty());
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
                "# Document\nCommon content",
            )
            .unwrap();
        }

        let index = SearchIndex::new(dir_path).unwrap();

        // Test limit works
        let results = index.search("Common", 5).unwrap();
        assert_eq!(results.len(), 5);

        let results = index.search("Common", 20).unwrap();
        assert_eq!(results.len(), 10);
    }

    #[test]
    fn test_subdirectory_relative_paths() {
        let temp_dir = TempDir::new().unwrap();
        let sub = temp_dir.path().join("notes").join("deep");
        fs::create_dir_all(&sub).unwrap();
        create_test_file(&sub, "nested.md", "# Nested\nDeep content here").unwrap();

        let index = SearchIndex::new(temp_dir.path()).unwrap();
        let results = index.search("Deep", 10).unwrap();
        assert_eq!(results.len(), 1);
        // Path should be relative, using forward slashes
        let path = &results[0].file_path;
        assert!(
            path.starts_with("notes"),
            "expected relative path, got: {path}"
        );
        assert!(
            path.contains("nested"),
            "expected file name in path, got: {path}"
        );
        assert!(
            !path.starts_with('/'),
            "path should be relative, got: {path}"
        );
    }

    #[test]
    fn test_update_file_ignores_non_markdown() {
        let temp_dir = TempDir::new().unwrap();
        create_test_file(temp_dir.path(), "test.md", "# Original\nMarkdown").unwrap();
        let index = SearchIndex::new(temp_dir.path()).unwrap();

        // Write a .txt file and try to update — should be no-op
        let txt_path = temp_dir.path().join("notes.txt");
        fs::write(&txt_path, "Some text content").unwrap();
        // Should not error
        index.update_file(&txt_path).unwrap();

        // Searching for the txt content should yield nothing
        let results = index.search("Some text content", 10).unwrap();
        assert!(results.is_empty());
    }

    #[test]
    fn test_update_file_no_extension() {
        let temp_dir = TempDir::new().unwrap();
        create_test_file(temp_dir.path(), "test.md", "# Doc\nContent").unwrap();
        let index = SearchIndex::new(temp_dir.path()).unwrap();

        let no_ext = temp_dir.path().join("README");
        fs::write(&no_ext, "Plain text").unwrap();
        index.update_file(&no_ext).unwrap();

        let results = index.search("Plain text", 10).unwrap();
        assert!(results.is_empty());
    }

    /// Stress the parallel parse -> serial write pipeline with enough
    /// files that rayon will fan out across multiple workers. Verifies
    /// every doc lands in the index and that content from arbitrary
    /// files is searchable.
    #[test]
    fn test_index_directory_parallel_completeness() {
        let temp_dir = TempDir::new().unwrap();
        let dir_path = temp_dir.path();

        const N: usize = 50;
        for i in 0..N {
            // Vary body size so workers spend different amounts of
            // CPU per file. Each file embeds its own unique marker
            // token so we can probe individual docs after indexing.
            let body_repeat = (i % 7) + 1;
            let body = "lorem ipsum dolor sit amet ".repeat(body_repeat * 4);
            let content =
                format!("# Doc {i}\nmarker_token_{i} is unique to this file.\n\n{body}\n");
            create_test_file(dir_path, &format!("file_{i:02}.md", i = i), &content).unwrap();
        }

        let index = SearchIndex::new(dir_path).unwrap();

        // Every file must be present after the parallel pipeline.
        assert_eq!(
            index.reader.searcher().num_docs(),
            N as u64,
            "parallel indexing dropped documents"
        );

        // Probe a handful of unique markers to prove the content of
        // individual docs survived the parse -> write split, not just
        // the document count.
        for i in [0usize, 7, 23, 49] {
            let needle = format!("marker_token_{i}");
            let results = index.search(&needle, 10).unwrap();
            assert_eq!(
                results.len(),
                1,
                "expected exactly one hit for `{needle}`, got {}",
                results.len()
            );
        }

        // Title-based search still works across the parallel pipeline.
        let results = index.search("Doc", 100).unwrap();
        assert_eq!(results.len(), N);
    }

    /// Poison the writer mutex from a panicking thread and verify
    /// that subsequent public write calls surface a TantivyError
    /// instead of panicking. This proves the writer() helper turned
    /// the historical .lock().unwrap() panic path into a recoverable
    /// error.
    #[test]
    fn test_writer_poison_returns_error_not_panic() {
        let temp_dir = TempDir::new().unwrap();
        create_test_file(temp_dir.path(), "seed.md", "# Seed\nseed content").unwrap();

        let index = SearchIndex::new(temp_dir.path()).unwrap();

        // Poison the writer mutex: grab the lock on another thread
        // and panic while holding it. std::sync::Mutex marks the
        // mutex poisoned when the panicking thread unwinds.
        let writer_handle = Arc::clone(&index.writer);
        let poisoner = std::thread::spawn(move || {
            let _guard = writer_handle.lock().unwrap();
            panic!("intentional poison for test");
        });
        // We expect the thread to panic. join() returns Err in that
        // case; the panic must not propagate into this test thread.
        let join_result = poisoner.join();
        assert!(
            join_result.is_err(),
            "poisoner thread was supposed to panic"
        );

        // The lock is now poisoned. Any subsequent public write path
        // (update_file / delete_file) must return an error, not panic.
        let new_file = temp_dir.path().join("new.md");
        fs::write(&new_file, "# After Poison\nshould not panic").unwrap();
        let result = index.update_file(&new_file);
        assert!(
            result.is_err(),
            "update_file should report poisoned writer as an error"
        );

        let delete_result = index.delete_file(&new_file);
        assert!(
            delete_result.is_err(),
            "delete_file should report poisoned writer as an error"
        );
    }

    /// Search is case-insensitive: the analyzer lower-cases both the indexed
    /// text and the query, so case never affects whether a term matches.
    #[test]
    fn test_search_is_case_insensitive() {
        let temp_dir = TempDir::new().unwrap();
        let dir_path = temp_dir.path();
        create_test_file(dir_path, "doc.md", "# Heading\nThe Quick BrownFox jumps.").unwrap();
        let index = SearchIndex::new(dir_path).unwrap();

        assert_eq!(
            index.search("quick", 10).unwrap().len(),
            1,
            "lower-case query must match mixed-case text"
        );
        assert_eq!(
            index.search("QUICK", 10).unwrap().len(),
            1,
            "upper-case query must match too"
        );
        assert_eq!(index.search("brownfox", 10).unwrap().len(), 1);
    }

    /// A single-file index must hold exactly ONE document — the pinned file —
    /// regardless of how many other markdown files share its parent directory.
    #[test]
    fn test_single_file_index_contains_exactly_one_doc() {
        let temp_dir = TempDir::new().unwrap();
        let dir_path = temp_dir.path();

        create_test_file(dir_path, "pinned.md", "# Pinned\nPinned content.").unwrap();
        create_test_file(dir_path, "sibling1.md", "# Sibling One\nFirst sibling.").unwrap();
        create_test_file(dir_path, "sibling2.md", "# Sibling Two\nSecond sibling.").unwrap();

        let index = SearchIndex::new_single_file(dir_path, "pinned.md").unwrap();

        assert_eq!(
            index.reader.searcher().num_docs(),
            1,
            "single-file index must contain exactly one document"
        );
    }

    /// SECURITY: a single-file index must NOT leak siblings. Build the index
    /// over a directory that also holds a sibling `.md` carrying a unique term;
    /// searching for that term must return nothing (proving the parent dir was
    /// never walked), while a term from the pinned file still resolves to it.
    #[test]
    fn test_single_file_index_no_sibling_leakage() {
        let temp_dir = TempDir::new().unwrap();
        let dir_path = temp_dir.path();

        create_test_file(
            dir_path,
            "pinned.md",
            "# Pinned Document\nuniquepinnedtoken lives here.",
        )
        .unwrap();
        // Sibling carries a term that must never surface through the index.
        create_test_file(
            dir_path,
            "secret-sibling.md",
            "# Secret Sibling\nuniquesiblingtoken must stay private.",
        )
        .unwrap();

        let index = SearchIndex::new_single_file(dir_path, "pinned.md").unwrap();

        // The sibling's unique term must NOT be findable — the parent dir was
        // not indexed.
        let leaked = index.search("uniquesiblingtoken", 10).unwrap();
        assert!(
            leaked.is_empty(),
            "single-file index leaked a sibling file: {leaked:?}"
        );

        // The pinned file's own term still resolves to the pinned file.
        let hits = index.search("uniquepinnedtoken", 10).unwrap();
        assert_eq!(hits.len(), 1, "pinned file should be searchable");
        assert_eq!(hits[0].file_path, "pinned.md");
    }

    /// The single-file index stores the relative path as the bare file name,
    /// matching what the single-file watcher passes to `update_file` so later
    /// edits delete-and-replace the same document instead of duplicating it.
    #[test]
    fn test_single_file_index_relative_path_is_file_name() {
        let temp_dir = TempDir::new().unwrap();
        let dir_path = temp_dir.path();
        let file_path = dir_path.join("note.md");

        create_test_file(dir_path, "note.md", "# Note\noriginaltoken here.").unwrap();

        let index = SearchIndex::new_single_file(dir_path, "note.md").unwrap();
        let hits = index.search("originaltoken", 10).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].file_path, "note.md");

        // An external edit routed through update_file must replace, not append.
        fs::write(&file_path, "# Note\nupdatedtoken here.").unwrap();
        index.update_file(&file_path).unwrap();

        assert_eq!(
            index.reader.searcher().num_docs(),
            1,
            "update_file should keep the single-file index at one document"
        );
        assert!(index.search("originaltoken", 10).unwrap().is_empty());
        assert_eq!(index.search("updatedtoken", 10).unwrap().len(), 1);
    }
}
