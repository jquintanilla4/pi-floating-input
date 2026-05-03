# Floating Input Extension Plan

Goal: keep Pi's prompt/editor and status info visible while reviewing chat history, using an internal fixed-editor layout rather than native terminal scrollback.

## Design decision

Use a single Pi extension with a powerline-style fixed editor compositor:

- Replace/wrap Pi's editor with `ctx.ui.setEditorComponent(...)`.
- Render extra status rows via widgets/footer hooks.
- Reserve bottom rows for the fixed editor cluster.
- Make the chat/feed above it scroll internally with mouse wheel and keyboard shortcuts.
- Use image-safe placeholders by default instead of rendering terminal graphics inside the scrollable region.

This avoids a separate external TUI process for v1.

## V1 scope

### Must have

- [x] Extension package at `~/.pi/agent/extensions/floating-input/`.
- [x] Slash command: `/floating-input on|off|toggle|status`.
- [x] Slash menu aliases: `/floating-input-on`, `/floating-input-off`, `/floating-input-toggle`, `/floating-input-status`, `/floating-input-reset`.
- [x] Settings loaded from `~/.pi/agent/settings.json` under `floatingInput`.
- [x] Fixed bottom editor cluster:
  - [ ] built-in editor remains usable (needs interactive testing)
  - [ ] submitted prompts still work normally (needs interactive testing)
  - [x] cursor placement is forwarded from rendered editor cluster
  - [x] model/status/info lines stay visible
- [x] Internal chat scrolling:
  - [x] mouse wheel scrolls chat region
  - [x] PageUp/PageDown scroll chat region
  - [x] shortcut to jump bottom (best-effort terminal encodings)
- [x] Safe teardown:
  - [x] restore terminal scroll region
  - [x] disable mouse reporting
  - [x] restore original TUI methods
  - [x] emergency terminal reset on shutdown
- [x] Image-safe behavior:
  - [x] default to placeholder mode for image/control-sequence lines
  - [x] never intentionally render terminal graphics into fixed-scroll mode

### Nice to have after MVP

- [ ] Configurable status rows.
- [ ] Configurable shortcuts.
- [ ] Copy/selection behavior inside internal scroll region.
- [ ] Last prompt preview row.
- [ ] Experimental image rendering mode.
- [ ] Compatibility checks for terminal/tmux.

## Proposed settings

```json
{
  "floatingInput": {
    "enabled": true,
    "mouseScroll": true,
    "imageMode": "placeholder",
    "jumpBottomShortcut": "ctrl+shift+g",
    "scrollUpShortcut": "pageup",
    "scrollDownShortcut": "pagedown"
  }
}
```

## Implementation phases

### Phase 1 — scaffold and safe toggle

- [x] Create `index.ts` extension.
- [x] Register `/floating-input` command.
- [x] Add config parser with safe defaults.
- [x] Add enable/disable lifecycle.
- [x] Verify `pi -p --extension ...` loads extension.

### Phase 2 — custom editor/status cluster

- [x] Wrap Pi's current/default editor.
- [x] Render minimal status lines:
  - cwd basename/full path
  - model/provider
  - context usage if available
  - mode indicator
- [ ] Ensure normal typing/submission still works in interactive TUI.

### Phase 3 — compositor MVP

- [x] Implement terminal split compositor inspired by `pi-powerline-footer`, but smaller.
- [x] Patch terminal rows and writes.
- [x] Reserve bottom cluster rows.
- [x] Paint fixed cluster after each render/write.
- [x] Restore terminal on disable/shutdown.

### Phase 4 — internal scroll

- [x] Slice root/chat lines by scroll offset.
- [x] Mouse wheel and PageUp/PageDown update scroll offset.
- [x] Auto-follow bottom after agent end.
- [x] Jump-to-bottom shortcut.

### Phase 5 — image safety

- [x] Detect terminal image/control lines at escape-sequence line level.
- [x] Replace image lines with placeholders in fixed mode.
- [x] Strip/avoid risky OSC/APC control sequences in scrollable root render.
- [x] Add setting `imageMode: "placeholder" | "off" | "experimental"` but only implement placeholder/off initially.

### Phase 6 — hardening

- [x] Test resize behavior. Passed manual interactive test.
- [x] Test quit/reload/disable recovery. Passed manual interactive test.
- [~] Test with overlays and commands. Slash menu works; `/settings` nested list has a crop/selection visibility bug while floating mode is enabled.
- [ ] Fix overlay suspension/cropping for nested `/settings` lists. Likely approach: fully suspend compositor row patching while overlays are active, then restore/repaint after overlay closes.
- [x] Add README with caveats and emergency reset command.

## Known risks

- This approach relies on Pi TUI internals like `tui.terminal.write`, `tui.render`, `tui.doRender`, and component structure.
- Pi updates may break the extension.
- Mouse reporting can affect native terminal selection.
- Terminal images are complex; placeholder mode is the safe default.
- Overlay caveat: slash command menu works, but `/settings` nested lists can let the selection move outside the visible crop. Workaround: temporarily run `/floating-input-off` before deep settings navigation.

## Emergency recovery

If terminal state gets weird, run:

```bash
printf '\033[?2026l\033[r\033[?1006l\033[?1002l\033[?1000l\033[?1007h\033[?1049l\033[<999u\033[>4;0m'
```
