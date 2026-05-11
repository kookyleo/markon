use rust_embed::RustEmbed;

#[derive(RustEmbed)]
#[folder = "assets/css/"]
pub(crate) struct CssAssets;

#[derive(RustEmbed)]
#[folder = "assets/dist/"]
pub(crate) struct JsAssets;

#[derive(RustEmbed)]
#[folder = "assets/templates/"]
pub(crate) struct Templates;

#[derive(RustEmbed)]
#[folder = "assets/icons/"]
pub(crate) struct IconAssets;
