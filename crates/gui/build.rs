fn main() {
    println!("cargo:rerun-if-changed=icons");
    println!("cargo:rerun-if-changed=tauri.conf.json");
    println!("cargo:rerun-if-changed=Info.plist");
    println!("cargo:rerun-if-changed=ui");
    // graphviz-anywhere ships libgraphviz_api.dylib with an @rpath install name.
    // In dev, cargo's DYLD_FALLBACK_LIBRARY_PATH resolves it; a bundled .app has
    // no such env and crashed with "no LC_RPATH's found". Bake an rpath pointing
    // at the app's Frameworks dir so a bundled copy resolves without any post
    // step beyond dropping the dylib into Contents/Frameworks.
    #[cfg(target_os = "macos")]
    println!("cargo:rustc-link-arg=-Wl,-rpath,@executable_path/../Frameworks");
    tauri_build::build();
}
