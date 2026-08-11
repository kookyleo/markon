# Themes and custom styles

Markon uses one theme system across desktop settings, Markdown pages, floating panels, and the source editor. Choose **System**, **Light**, or **Dark**. Language is a separate global setting shared by the desktop app, tray, reading pages, and editor.

## Configure appearance

Open **Global settings → Appearance**. Select the theme, adjust colors, fonts, UI size, and panel opacity, or reset individual/all overrides. The CLI reads the same `~/.markon/settings.json` and has no separate style flags.

## Custom tokens

| Key | Scope |
|---|---|
| `primary` | Links, buttons, selected TOC, accents |
| `muted` | Secondary text and dividers |
| `border` | Heading and panel borders |
| `subtle` | Code and card backgrounds |
| `canvas` | Page and editor canvas |
| `text` | Body and editor text |
| `ui-font` | TOC, toolbars, panels, editor UI |
| `ui-font-size` | Interface size |
| `panel-opacity` | TOC, Notes, dialogs, and Chat surfaces |

Colors store separate light and dark values. Font, size, and opacity are shared.

## Settings format

```json
{
  "theme": "auto",
  "language": "auto",
  "web_styles": {
    "primary.light": "#76520e",
    "primary.dark": "#d4a24c",
    "canvas.light": "#fffaf0",
    "canvas.dark": "#17130d",
    "ui-font": "Charter, serif",
    "ui-font-size": "0.90rem",
    "panel-opacity": "0.92"
  }
}
```

The service converts these values to shared `--markon-*` CSS tokens. Pages apply `data-theme` before first paint to avoid theme flashing.
