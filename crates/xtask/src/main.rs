//! Workspace helper tasks. See `assets/brand/variants.toml` for the icon
//! manifest. Run with `cargo xtask <command>`.

use anyhow::{bail, Context, Result};
use serde::Deserialize;
use std::collections::BTreeMap;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};

// ── Manifest schema ─────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct Manifest {
    #[serde(default)]
    wrap: BTreeMap<String, WrapDef>,
    variant: Vec<Variant>,
}

#[derive(Deserialize)]
struct WrapDef {
    canvas: u32,
    margin: u32,
    radius: u32,
    #[serde(default = "default_inner_pad")]
    inner_pad: u32,
}

fn default_inner_pad() -> u32 {
    48
}

#[derive(Deserialize)]
struct Variant {
    name: String,
    wrap: String, // "none" or a key into Manifest.wrap
    fg: String,
    #[serde(default)]
    bg: Option<String>,
    #[serde(default, rename = "viewBox")]
    view_box: Option<String>,
    outputs: Vec<Output>,
}

#[derive(Deserialize)]
struct Output {
    path: String,
    #[serde(default)]
    size: Option<u32>,
    #[serde(default)]
    sizes: Option<Vec<u32>>,
}

// ── Entry point ─────────────────────────────────────────────────────────────

fn main() -> Result<()> {
    let mut args = env::args().skip(1);
    let cmd = args.next().unwrap_or_default();
    let mut check = false;
    for a in args {
        match a.as_str() {
            "--check" => check = true,
            other => bail!("unknown argument: {other}"),
        }
    }
    match cmd.as_str() {
        "icons" => run_icons(check),
        "" | "help" | "--help" | "-h" => {
            println!("usage: cargo xtask <command>");
            println!();
            println!("commands:");
            println!("  icons [--check]   Regenerate brand icons (or fail if they are stale).");
            Ok(())
        }
        other => bail!("unknown command: {other}"),
    }
}

// ── Icon generation ─────────────────────────────────────────────────────────

fn workspace_root() -> Result<PathBuf> {
    // crates/xtask/Cargo.toml → crates/xtask → crates → workspace root.
    let here = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    Ok(here
        .parent()
        .and_then(|p| p.parent())
        .context("locate workspace root")?
        .to_path_buf())
}

fn run_icons(check: bool) -> Result<()> {
    let root = workspace_root()?;
    let glyph_svg = fs::read_to_string(root.join("assets/brand/glyph.svg"))
        .context("read assets/brand/glyph.svg")?;
    let inner = extract_inner(&glyph_svg)?;

    let manifest: Manifest = toml::from_str(
        &fs::read_to_string(root.join("assets/brand/variants.toml"))
            .context("read assets/brand/variants.toml")?,
    )
    .context("parse variants.toml")?;

    let mut drift = Vec::<PathBuf>::new();

    for v in &manifest.variant {
        let svg = compose_svg(&inner, v, &manifest)?;
        for out in &v.outputs {
            let abs = root.join(&out.path);
            let bytes = render_output(&svg, out)?;
            if check {
                let current = fs::read(&abs).ok();
                if current.as_deref() != Some(bytes.as_slice()) {
                    drift.push(abs);
                }
            } else {
                if let Some(parent) = abs.parent() {
                    fs::create_dir_all(parent).ok();
                }
                fs::write(&abs, &bytes).with_context(|| format!("write {}", abs.display()))?;
                println!("  wrote {}", out.path);
            }
        }
    }

    if check {
        if drift.is_empty() {
            println!("icons up to date");
            Ok(())
        } else {
            for p in &drift {
                eprintln!("stale: {}", p.display());
            }
            bail!(
                "{} icon file(s) out of date — run `cargo xtask icons`",
                drift.len()
            );
        }
    } else {
        Ok(())
    }
}

/// Pull everything between `<svg …>` and `</svg>` out of the master.
fn extract_inner(svg: &str) -> Result<String> {
    let start = svg.find('>').context("missing <svg …>")? + 1;
    let end = svg.rfind("</svg>").context("missing </svg>")?;
    Ok(svg[start..end].trim().to_string())
}

/// The master uses `fill="currentColor"` so the parent `<g fill="…">` can recolour
/// it. Drop the attribute so inheritance kicks in.
fn strip_currentcolor_fill(inner: &str) -> String {
    inner
        .replace(r#"fill="currentColor""#, "")
        .replace("  ", " ")
}

/// Build the SVG for a given variant (with or without a wrapper rect).
fn compose_svg(inner: &str, v: &Variant, m: &Manifest) -> Result<String> {
    let body = strip_currentcolor_fill(inner);
    if v.wrap == "none" {
        let vb = v.view_box.as_deref().unwrap_or("0 0 32 32");
        Ok(format!(
            r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="{vb}"><g fill="{fg}">{body}</g></svg>"#,
            vb = vb,
            fg = v.fg,
            body = body,
        ))
    } else {
        let w = m.wrap.get(&v.wrap).with_context(|| {
            format!("variant `{}` references unknown wrap `{}`", v.name, v.wrap)
        })?;
        let bg =
            v.bg.as_deref()
                .with_context(|| format!("variant `{}` is wrapped but has no `bg`", v.name))?;
        let rect_size = w.canvas - 2 * w.margin;
        let glyph_origin = w.margin + w.inner_pad;
        let glyph_box = w.canvas - 2 * (w.margin + w.inner_pad);
        let scale = glyph_box as f32 / 32.0;
        Ok(format!(
            r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {c} {c}"><rect x="{i}" y="{i}" width="{rs}" height="{rs}" rx="{r}" fill="{bg}"/><g transform="translate({t},{t}) scale({s})" fill="{fg}">{body}</g></svg>"#,
            c = w.canvas,
            i = w.margin,
            rs = rect_size,
            r = w.radius,
            bg = bg,
            t = glyph_origin,
            s = scale,
            fg = v.fg,
            body = body,
        ))
    }
}

/// Dispatch on file extension: SVG passthrough, PNG raster, ICO/ICNS multi-pack.
fn render_output(svg: &str, out: &Output) -> Result<Vec<u8>> {
    let ext = Path::new(&out.path)
        .extension()
        .and_then(|s| s.to_str())
        .map(|s| s.to_ascii_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "svg" => Ok(format!("{svg}\n").into_bytes()),
        "png" => {
            let size = out.size.context("png output requires `size`")?;
            rasterize(svg, size)
        }
        "ico" => {
            let sizes = out
                .sizes
                .as_deref()
                .context("ico output requires `sizes`")?;
            pack_ico(svg, sizes)
        }
        "icns" => {
            let sizes = out
                .sizes
                .as_deref()
                .context("icns output requires `sizes`")?;
            pack_icns(svg, sizes)
        }
        other => bail!("unsupported output extension: {other}"),
    }
}

fn rasterize(svg: &str, size: u32) -> Result<Vec<u8>> {
    let opts = usvg::Options::default();
    let tree = usvg::Tree::from_str(svg, &opts).context("parse composed svg")?;
    let mut pixmap = tiny_skia::Pixmap::new(size, size).context("alloc pixmap")?;
    let scale = size as f32 / tree.size().width();
    let transform = tiny_skia::Transform::from_scale(scale, scale);
    resvg::render(&tree, transform, &mut pixmap.as_mut());
    pixmap.encode_png().context("encode png")
}

fn pack_ico(svg: &str, sizes: &[u32]) -> Result<Vec<u8>> {
    let mut dir = ico::IconDir::new(ico::ResourceType::Icon);
    for &size in sizes {
        let png = rasterize(svg, size)?;
        let img = ico::IconImage::read_png(&png[..]).context("decode png for ico")?;
        // Windows Shell (taskbar, Explorer) reliably renders BMP entries at
        // every size but has historical bugs rendering PNG-encoded entries
        // below 256x256 — the taskbar icon can come out blank or corrupted.
        // Keep PNG only for the 256 slot, BMP for everything smaller.
        let entry = if size >= 256 {
            ico::IconDirEntry::encode_as_png(&img)
        } else {
            ico::IconDirEntry::encode_as_bmp(&img)
        }
        .context("encode ico entry")?;
        dir.add_entry(entry);
    }
    let mut buf = Vec::new();
    dir.write(&mut buf).context("write ico")?;
    Ok(buf)
}

fn pack_icns(svg: &str, sizes: &[u32]) -> Result<Vec<u8>> {
    let mut family = icns::IconFamily::new();
    for &size in sizes {
        let png = rasterize(svg, size)?;
        let img = icns::Image::read_png(&png[..]).context("decode png for icns")?;
        family
            .add_icon(&img)
            .with_context(|| format!("add icns icon {size}px"))?;
    }
    let mut buf = Vec::new();
    family.write(&mut buf).context("write icns")?;
    Ok(buf)
}
