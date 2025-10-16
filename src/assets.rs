use rust_embed::RustEmbed;

#[derive(RustEmbed)]
#[folder = "assets/css/"]
pub struct CssAssets;

#[derive(RustEmbed)]
#[folder = "assets/js/"]
pub struct JsAssets;

#[derive(RustEmbed)]
#[folder = "assets/templates/"]
pub struct Templates;
