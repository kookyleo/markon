use std::path::Path;

/// Render a path with forward slashes regardless of platform.
pub(crate) fn path_to_forward_slash(rel: &Path) -> String {
    rel.components()
        .map(|c| c.as_os_str().to_string_lossy().into_owned())
        .collect::<Vec<_>>()
        .join("/")
}

/// Default ignore-rule walker that respects `.gitignore`, `.ignore`, and
/// hidden-file conventions. This is the shared baseline for workspace reads
/// that should behave like the chat tools and ripgrep.
pub(crate) fn default_walker(root: &Path) -> ignore::WalkBuilder {
    let mut b = ignore::WalkBuilder::new(root);
    b.standard_filters(true);
    b
}
