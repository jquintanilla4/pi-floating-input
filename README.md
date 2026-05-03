# Floating Input

Experimental Pi extension that keeps the input editor and a small status strip fixed at the bottom while the chat/feed scrolls above it.

This is inspired by `pi-powerline-footer`'s fixed-editor architecture, but intentionally smaller and image-safe by default.

## Usage

The extension is opt-in by default.

```text
/floating-input on
/floating-input off
/floating-input toggle
/floating-input status
/floating-input reset
```

These also appear as separate slash-menu entries so they are easier to discover:

```text
/floating-input-on
/floating-input-off
/floating-input-toggle
/floating-input-status
/floating-input-reset
```

`on` persists this setting to `~/.pi/agent/settings.json`:

```json
{
  "floatingInput": {
    "enabled": true,
    "mouseScroll": true,
    "imageMode": "placeholder"
  }
}
```

## Controls

- Mouse wheel: scroll chat/feed region when `mouseScroll` is enabled.
- PageUp / PageDown: scroll chat/feed region.
- Ctrl+Shift+Up / Ctrl+Shift+Down: scroll chat/feed region in many terminals.
- Ctrl+G / Ctrl+Shift+G-ish encodings: jump to bottom. Terminal support varies.

## Image behavior

Terminal graphics are not rendered in fixed mode. Kitty/iTerm image escape lines are replaced with:

```text
[image omitted in floating-input mode]
```

This avoids images overlapping the fixed editor or leaving artifacts while scrolling.

## Caveats

This extension patches Pi/TUI internals:

- `tui.render`
- `tui.doRender`
- `tui.terminal.write`
- `tui.terminal.rows`

So it may break on Pi updates or in unusual terminal setups. Use `/floating-input off` or `/floating-input reset` if rendering gets weird.

## Emergency terminal reset

If the terminal is left in a bad state:

```bash
printf '\033[?2026l\033[r\033[?1006l\033[?1002l\033[?1000l\033[?1007h\033[?1049l\033[<999u\033[>4;0m'
```
