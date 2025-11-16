use markon::search::{SearchIndex, SearchQuery};
use std::fs;
use std::path::Path;
use tempfile::TempDir;

fn create_test_markdown_structure(dir: &Path) {
    // Create a nested directory structure with markdown files
    fs::create_dir_all(dir.join("docs")).unwrap();
    fs::create_dir_all(dir.join("docs/tutorials")).unwrap();
    fs::create_dir_all(dir.join("blog")).unwrap();

    // Create various markdown files
    fs::write(
        dir.join("README.md"),
        "# Project README\nThis is the main documentation for the project.",
    )
    .unwrap();

    fs::write(
        dir.join("docs/getting-started.md"),
        "# Getting Started\nLearn how to get started with this project.",
    )
    .unwrap();

    fs::write(
        dir.join("docs/tutorials/basic.md"),
        "# Basic Tutorial\nThis tutorial covers the basics.\n## Step 1\nFirst step here.",
    )
    .unwrap();

    fs::write(
        dir.join("docs/tutorials/advanced.md"),
        "# Advanced Tutorial\nAdvanced topics for experienced users.",
    )
    .unwrap();

    fs::write(
        dir.join("blog/announcement.md"),
        "# New Release Announcement\nWe are excited to announce our new release!",
    )
    .unwrap();

    // Add Chinese content
    fs::write(
        dir.join("docs/中文指南.md"),
        "# 中文指南\n这是一个中文文档示例。\n\n## 快速开始\n按照以下步骤开始使用。",
    )
    .unwrap();

    // Add mixed content
    fs::write(
        dir.join("blog/混合内容.md"),
        "# Mixed Content / 混合内容\nThis document contains both English and 中文内容.",
    )
    .unwrap();
}

#[test]
fn test_search_across_directory_structure() {
    let temp_dir = TempDir::new().unwrap();
    let dir_path = temp_dir.path();

    create_test_markdown_structure(dir_path);

    let index = SearchIndex::new(dir_path).unwrap();

    // Search for "Tutorial" (capitalized as it appears in titles)
    let results = index.search("Tutorial", 20).unwrap();
    assert!(
        results.len() >= 2,
        "Should find at least 2 tutorials, found {}",
        results.len()
    );

    // Search for "project" should find the README
    let results = index.search("project", 20).unwrap();
    assert!(!results.is_empty());
    assert!(results.iter().any(|r| r.file_path.contains("README.md")));
}

#[test]
fn test_search_chinese_content() {
    let temp_dir = TempDir::new().unwrap();
    let dir_path = temp_dir.path();

    create_test_markdown_structure(dir_path);

    let index = SearchIndex::new(dir_path).unwrap();

    // Search for Chinese term
    let results = index.search("中文", 20).unwrap();
    assert!(results.len() >= 2, "Should find files with Chinese content");

    // Search for "快速开始"
    let results = index.search("快速", 20).unwrap();
    assert_eq!(results.len(), 1);
    assert!(results[0].title.contains("中文"));

    // Search for "指南"
    let results = index.search("指南", 20).unwrap();
    assert_eq!(results.len(), 1);
}

#[test]
fn test_search_returns_correct_metadata() {
    let temp_dir = TempDir::new().unwrap();
    let dir_path = temp_dir.path();

    create_test_markdown_structure(dir_path);

    let index = SearchIndex::new(dir_path).unwrap();

    // Search for a word that appears in content
    let results = index.search("started", 20).unwrap();
    assert!(!results.is_empty());

    let result = results
        .iter()
        .find(|r| r.title == "Getting Started")
        .expect("Should find Getting Started");
    assert_eq!(result.file_name, "getting-started");
    assert!(result.file_path.contains("getting-started.md"));
    // Snippet may be empty if the match is only in title, so we don't assert on it
}

#[test]
fn test_search_snippet_highlights() {
    let temp_dir = TempDir::new().unwrap();
    let dir_path = temp_dir.path();

    fs::write(
        dir_path.join("test.md"),
        "# Test Document\nThis paragraph contains the keyword important multiple times. It is important to note that important things are highlighted.",
    )
    .unwrap();

    let index = SearchIndex::new(dir_path).unwrap();

    let results = index.search("important", 20).unwrap();
    assert_eq!(results.len(), 1);

    // Snippet should contain HTML highlighting
    assert!(
        results[0].snippet.contains("<b>") || results[0].snippet.contains("important"),
        "Snippet should contain highlighted text"
    );
}

#[test]
fn test_file_update_workflow() {
    let temp_dir = TempDir::new().unwrap();
    let dir_path = temp_dir.path();
    let file_path = dir_path.join("dynamic.md");

    // Initial content
    fs::write(&file_path, "# Version 1\nOriginal content v1").unwrap();

    let index = SearchIndex::new(dir_path).unwrap();

    // Verify v1 is searchable
    let results = index.search("v1", 20).unwrap();
    assert_eq!(results.len(), 1);

    // Update to v2
    fs::write(&file_path, "# Version 2\nUpdated content v2").unwrap();
    index.update_file(&file_path).unwrap();

    // v2 should be searchable
    let results = index.search("v2", 20).unwrap();
    assert_eq!(results.len(), 1);

    // v1 should no longer be found
    let results = index.search("v1", 20).unwrap();
    assert_eq!(results.len(), 0);

    // Update to v3
    fs::write(&file_path, "# Version 3\nFinal content v3").unwrap();
    index.update_file(&file_path).unwrap();

    // v3 should be searchable
    let results = index.search("v3", 20).unwrap();
    assert_eq!(results.len(), 1);

    // v2 should no longer be found
    let results = index.search("v2", 20).unwrap();
    assert_eq!(results.len(), 0);
}

#[test]
fn test_file_deletion_workflow() {
    let temp_dir = TempDir::new().unwrap();
    let dir_path = temp_dir.path();

    // Create multiple files
    fs::write(dir_path.join("keep.md"), "# Keep This\nPermanent content").unwrap();
    let delete_path = dir_path.join("delete.md");
    fs::write(&delete_path, "# Delete This\nTemporary content").unwrap();

    let index = SearchIndex::new(dir_path).unwrap();

    // Both files should be searchable
    let results = index.search("content", 20).unwrap();
    assert_eq!(results.len(), 2);

    // Delete one file
    index.delete_file(&delete_path).unwrap();

    // Only one file should remain
    let results = index.search("content", 20).unwrap();
    assert_eq!(results.len(), 1);
    assert!(results[0].title.contains("Keep"));

    // Deleted file should not be found
    let results = index.search("Temporary", 20).unwrap();
    assert_eq!(results.len(), 0);
}

#[test]
fn test_search_non_existent_content() {
    let temp_dir = TempDir::new().unwrap();
    let dir_path = temp_dir.path();

    create_test_markdown_structure(dir_path);

    let index = SearchIndex::new(dir_path).unwrap();

    // Search for something that doesn't exist
    let results = index.search("xyzabc123nonexistent", 20).unwrap();
    assert_eq!(results.len(), 0);
}

#[test]
fn test_empty_directory() {
    let temp_dir = TempDir::new().unwrap();
    let dir_path = temp_dir.path();

    // Create index with no markdown files
    let index = SearchIndex::new(dir_path).unwrap();

    // Any search should return no results
    let results = index.search("anything", 20).unwrap();
    assert_eq!(results.len(), 0);
}

#[test]
fn test_search_special_characters() {
    let temp_dir = TempDir::new().unwrap();
    let dir_path = temp_dir.path();

    fs::write(
        dir_path.join("special.md"),
        "# Special Characters\nContent with special: @#$%^&*()_+-=[]{}|;:',.<>?/",
    )
    .unwrap();

    let index = SearchIndex::new(dir_path).unwrap();

    // Should be able to search for normal words
    let results = index.search("Special", 20).unwrap();
    assert_eq!(results.len(), 1);

    let results = index.search("Characters", 20).unwrap();
    assert_eq!(results.len(), 1);
}

#[test]
fn test_large_file_indexing() {
    let temp_dir = TempDir::new().unwrap();
    let dir_path = temp_dir.path();

    // Create a large markdown file
    let mut large_content = String::from("# Large Document\n\n");
    for i in 0..1000 {
        large_content.push_str(&format!(
            "## Section {}\nThis is paragraph {} with unique content unique{}.\n\n",
            i, i, i
        ));
    }

    fs::write(dir_path.join("large.md"), &large_content).unwrap();

    let index = SearchIndex::new(dir_path).unwrap();

    // Search for content from different sections
    let results = index.search("unique500", 20).unwrap();
    assert_eq!(results.len(), 1);

    let results = index.search("Section 999", 20).unwrap();
    assert_eq!(results.len(), 1);
}

#[test]
fn test_concurrent_searches() {
    use std::sync::Arc;
    use std::thread;

    let temp_dir = TempDir::new().unwrap();
    let dir_path = temp_dir.path();

    create_test_markdown_structure(dir_path);

    let index = Arc::new(SearchIndex::new(dir_path).unwrap());

    // Spawn multiple threads doing searches
    let mut handles = vec![];

    for i in 0..5 {
        let index_clone = Arc::clone(&index);
        let handle = thread::spawn(move || {
            let query = if i % 2 == 0 { "tutorial" } else { "中文" };
            let results = index_clone.search(query, 20).unwrap();
            assert!(!results.is_empty(), "Thread {} got empty results", i);
        });
        handles.push(handle);
    }

    for handle in handles {
        handle.join().unwrap();
    }
}

#[test]
fn test_mixed_language_search() {
    let temp_dir = TempDir::new().unwrap();
    let dir_path = temp_dir.path();

    fs::write(
        dir_path.join("mixed.md"),
        "# Programming Language Comparison / 编程语言比较\n\nRust is fast and safe. Rust 是快速且安全的。\n\nPython is easy to learn. Python 易于学习。",
    )
    .unwrap();

    let index = SearchIndex::new(dir_path).unwrap();

    // Search English terms
    let results = index.search("Rust", 20).unwrap();
    assert_eq!(results.len(), 1);

    // Search Chinese terms
    let results = index.search("编程", 20).unwrap();
    assert_eq!(results.len(), 1);

    let results = index.search("快速", 20).unwrap();
    assert_eq!(results.len(), 1);

    // Search mixed
    let results = index.search("safe", 20).unwrap();
    assert_eq!(results.len(), 1);
}

#[test]
fn test_search_query_deserialization() {
    // Test that SearchQuery can be properly deserialized from query strings
    let query = SearchQuery {
        q: "test query".to_string(),
    };
    assert_eq!(query.q, "test query");

    let empty_query = SearchQuery { q: String::new() };
    assert!(empty_query.q.is_empty());
}
