use std::path::Path;

fn main() {
    check_js_bundle_present();
    generate_langs_registry();
}

/// Fail with an actionable message when the frontend bundle is missing.
///
/// `rust_embed::RustEmbed` on `crates/core/src/assets.rs` requires
/// `crates/core/assets/dist/` to exist at compile time. The directory is
/// produced by `scripts/build.mjs` (driven by `npm run build`), not by
/// cargo — so a fresh clone followed by `cargo build` would otherwise fail
/// with a cryptic `#[derive(RustEmbed)] folder '…/assets/dist/' does not
/// exist` error and no hint about the missing prerequisite.
fn check_js_bundle_present() {
    let manifest_dir = env!("CARGO_MANIFEST_DIR");
    let dist = Path::new(manifest_dir).join("assets/dist");
    println!("cargo:rerun-if-changed={}", dist.display());
    if !dist.is_dir() {
        panic!(
            "frontend bundle missing: {} does not exist.\n\
             Run `npm ci && npm run build` from the repo root before building \
             the Rust workspace. The bundle is produced by scripts/build.mjs \
             and is required by `rust_embed::RustEmbed` in crates/core/src/assets.rs.",
            dist.display()
        );
    }
}

/// Scan i18n/*.json5 at build time, generate LANGS array so no manual registration needed.
fn generate_langs_registry() {
    let i18n_dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("i18n");
    let out_dir = std::env::var("OUT_DIR").unwrap();
    let dest = Path::new(&out_dir).join("langs_generated.rs");

    let mut entries = Vec::new();
    if let Ok(dir) = std::fs::read_dir(&i18n_dir) {
        for entry in dir.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if let Some(value) = name.strip_suffix(".json5") {
                // value = "zh_CN", "en", etc.
                // key = first segment before '_', or the whole value if no '_'
                let key = value.split('_').next().unwrap_or(value);
                let abs_path = entry
                    .path()
                    .canonicalize()
                    .expect("i18n entry path must canonicalize during build");
                entries.push((value.to_string(), key.to_string(), abs_path));
            }
        }
    }
    // Sort for deterministic output
    entries.sort_by(|a, b| a.0.cmp(&b.0));

    let mut code = String::from(
        "struct LangEntry { value: &'static str, key: &'static str, data: &'static str }\n\n",
    );
    code.push_str("const LANGS: &[LangEntry] = &[\n");
    for (value, key, path) in &entries {
        // Use forward slashes so the path works in Rust string literals on Windows.
        let path_str = path.to_string_lossy().replace('\\', "/");
        code.push_str(&format!(
            "    LangEntry {{ value: \"{value}\", key: \"{key}\", data: include_str!(\"{path_str}\") }},\n",
        ));
    }
    code.push_str("];\n\n");
    code.push_str("const DEFAULT_LANG_KEY: &str = \"en\";\n");

    std::fs::write(&dest, code)
        .expect("must be able to write generated langs registry into OUT_DIR");

    // Re-run if i18n files change
    println!("cargo:rerun-if-changed={}", i18n_dir.display());
    for entry in entries {
        println!("cargo:rerun-if-changed={}", entry.2.display());
    }
}
