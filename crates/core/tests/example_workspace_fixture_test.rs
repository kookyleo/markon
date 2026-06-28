use std::fs;
use std::path::{Path, PathBuf};

const WORKSPACE: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../example");

#[test]
fn e2e_workspace_manifest_paths_exist() {
    let root = Path::new(WORKSPACE);
    let manifest_path = root.join("e2e-manifest.json");
    let manifest_text = fs::read_to_string(&manifest_path).expect("read e2e manifest");
    let manifest: serde_json::Value =
        serde_json::from_str(&manifest_text).expect("parse e2e manifest");

    assert_relative_file(root, manifest["entry"].as_str().expect("entry path"));

    let pages = manifest["pages"].as_object().expect("pages object");
    for (name, value) in pages {
        assert_relative_file(
            root,
            value
                .as_str()
                .unwrap_or_else(|| panic!("page path for {name}")),
        );
    }

    let assets = manifest["assets"].as_array().expect("assets array");
    for value in assets {
        assert_relative_file(root, value.as_str().expect("asset path"));
    }
}

#[test]
fn e2e_workspace_content_is_ascii_and_contains_required_markers() {
    let root = Path::new(WORKSPACE);
    for file in collect_files(root) {
        let bytes = fs::read(&file).unwrap_or_else(|e| panic!("read {}: {e}", file.display()));
        assert!(
            bytes.iter().all(u8::is_ascii),
            "non-ASCII byte found in {}",
            file.display()
        );
    }

    let diagrams = fs::read_to_string(root.join("docs/diagrams.md")).expect("read diagrams");
    assert!(diagrams.matches("```mermaid").count() >= 10);
    assert!(diagrams.contains("```dot"));
    assert!(diagrams.contains("```graphviz"));
    assert!(diagrams.contains("```plantuml"));
    assert!(diagrams.contains("```d2"));
    assert!(diagrams.contains("Graphviz DOT target"));
    assert!(diagrams.contains("Graphviz alias target"));
    assert!(diagrams.contains("PlantUML sequence target"));
    assert!(diagrams.contains("D2 diagram target"));
    assert!(diagrams.contains("Vega-Lite chart target"));
    assert!(diagrams.contains("Vega alias line chart target"));
    assert!(diagrams.contains("Chart alias scatter target"));
    assert!(diagrams.contains("ECharts chart target"));
    assert!(diagrams.contains("ECharts pie chart target"));
    assert!(diagrams.contains("Chart.js doughnut chart target"));
    assert!(diagrams.contains("Chart.js alias line chart target"));
    assert!(diagrams.contains("```vega-lite"));
    assert!(diagrams.contains("```vega"));
    assert!(diagrams.contains("```chart\n"));
    assert!(diagrams.contains("```echarts"));
    assert!(diagrams.contains("```chartjs"));
    assert!(diagrams.contains("```chart.js"));
    assert!(diagrams.contains("```plotly"));
    assert!(diagrams.contains("MARKON_E2E_DIAGRAM_SEARCH_TOKEN"));

    let kitchen =
        fs::read_to_string(root.join("docs/markdown-kitchen-sink.md")).expect("read kitchen sink");
    assert!(kitchen.contains("Setext Heading Target"));
    assert!(kitchen.contains("Reference link target"));
    assert!(kitchen.contains("Autolink target"));
    assert!(kitchen.contains("Hard break target"));
    assert!(kitchen.contains("Thematic break target"));
    assert!(kitchen.contains("![Kitchen sink local image target]"));

    let math = fs::read_to_string(root.join("docs/math-and-extensions.md")).expect("read math");
    assert!(math.contains("KaTeX display math target"));
    assert!(math.contains(":::map"));
    assert!(math.contains("%%%form review"));

    let search = fs::read_to_string(root.join("docs/search-targets.md")).expect("read search");
    assert!(search.contains("MARKON_E2E_UNIQUE_SEARCH_TOKEN_ALPHA"));
    assert!(search.contains("MARKON_E2E_UNIQUE_SEARCH_TOKEN_BRAVO"));

    let edit = fs::read_to_string(root.join("docs/edit-save-target.md")).expect("read edit");
    assert!(edit.contains("E2E_EDIT_VALUE=alpha"));

    let diff = fs::read_to_string(root.join("docs/git-diff-target.md")).expect("read diff");
    assert!(diff.contains("Release readiness: 72%"));
    assert!(diff.contains("Current phase: Draft"));
    assert!(diff.contains("A[Draft] --> B[Review]"));
}

fn assert_relative_file(root: &Path, relative: &str) {
    assert!(
        !relative.starts_with('/') && !relative.split('/').any(|part| part == ".."),
        "path must stay inside fixture: {relative}"
    );
    let path = root.join(relative);
    assert!(path.is_file(), "missing fixture file: {}", path.display());
}

fn collect_files(root: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    collect_files_inner(root, &mut out);
    out.sort();
    out
}

fn collect_files_inner(dir: &Path, out: &mut Vec<PathBuf>) {
    for entry in fs::read_dir(dir).unwrap_or_else(|e| panic!("read dir {}: {e}", dir.display())) {
        let entry = entry.expect("read dir entry");
        let path = entry.path();
        if path.is_dir() {
            collect_files_inner(&path, out);
        } else {
            out.push(path);
        }
    }
}
