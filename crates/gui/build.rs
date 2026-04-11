use std::path::Path;

fn main() {
    generate_langs_registry();
    tauri_build::build();
}

/// Scan i18n/*.json5 at build time, generate LANGS array so no manual registration needed.
fn generate_langs_registry() {
    let i18n_dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../i18n");
    let out_dir = std::env::var("OUT_DIR").unwrap();
    let dest = Path::new(&out_dir).join("langs_generated.rs");

    let mut entries = Vec::new();
    if let Ok(dir) = std::fs::read_dir(&i18n_dir) {
        for entry in dir.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if let Some(value) = name.strip_suffix(".json5") {
                let key = value.split('_').next().unwrap_or(value);
                let abs_path = entry.path().canonicalize().unwrap();
                entries.push((value.to_string(), key.to_string(), abs_path));
            }
        }
    }
    entries.sort_by(|a, b| a.0.cmp(&b.0));

    let mut code = String::from(
        "struct LangEntry { value: &'static str, key: &'static str, data: &'static str }\n\n"
    );
    code.push_str("const LANGS: &[LangEntry] = &[\n");
    for (value, key, path) in &entries {
        code.push_str(&format!(
            "    LangEntry {{ value: \"{value}\", key: \"{key}\", data: include_str!(\"{}\") }},\n",
            path.display()
        ));
    }
    code.push_str("];\n\n");
    code.push_str("const DEFAULT_LANG_KEY: &str = \"en\";\n");

    std::fs::write(&dest, code).unwrap();

    println!("cargo:rerun-if-changed={}", i18n_dir.display());
    for entry in entries {
        println!("cargo:rerun-if-changed={}", entry.2.display());
    }
}
