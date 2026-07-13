fn main() {
    println!("cargo:rerun-if-changed=icons");
    println!("cargo:rerun-if-changed=tauri.conf.json");
    println!("cargo:rerun-if-changed=Info.plist");
    println!("cargo:rerun-if-changed=ui");
    tauri_build::build();
}
