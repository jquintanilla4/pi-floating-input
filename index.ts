import { CustomEditor, type ExtensionAPI, type Theme } from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { renderFixedCluster } from "./fixed-cluster.ts";
import { emergencyTerminalReset, SplitCompositor } from "./terminal-split.ts";

interface FloatingInputConfig {
  enabled: boolean;
  mouseScroll: boolean;
  imageMode: "placeholder" | "off" | "experimental";
}

const DEFAULT_CONFIG: FloatingInputConfig = {
  // Experimental: keep opt-in until the compositor has been tested in your terminal.
  enabled: false,
  mouseScroll: true,
  imageMode: "placeholder",
};

function settingsPath(): string {
  return join(homedir(), ".pi", "agent", "settings.json");
}

function readSettings(): any {
  try {
    const path = settingsPath();
    if (!existsSync(path)) return {};
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

function writeSettings(settings: any): void {
  writeFileSync(settingsPath(), JSON.stringify(settings, null, 2) + "\n");
}

function readConfig(): FloatingInputConfig {
  const raw = readSettings().floatingInput;
  if (!raw || typeof raw !== "object") return { ...DEFAULT_CONFIG };
  return {
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : DEFAULT_CONFIG.enabled,
    mouseScroll: typeof raw.mouseScroll === "boolean" ? raw.mouseScroll : DEFAULT_CONFIG.mouseScroll,
    imageMode: raw.imageMode === "off" || raw.imageMode === "experimental" ? raw.imageMode : "placeholder",
  };
}

function saveConfig(config: FloatingInputConfig): void {
  const settings = readSettings();
  settings.floatingInput = { ...(settings.floatingInput ?? {}), ...config };
  writeSettings(settings);
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "");
}

function basename(path: string): string {
  const normalized = path.replace(/\/$/, "");
  return normalized.split("/").pop() || normalized || "/";
}

function fit(text: string, width: number): string {
  return visibleWidth(text) > width ? truncateToWidth(text, width, "…", true) : text;
}

export default function floatingInput(pi: ExtensionAPI) {
  let config = readConfig();
  let currentCtx: any = null;
  let currentTui: any = null;
  let currentEditor: any = null;
  let editorContainer: any = null;
  let compositor: SplitCompositor | null = null;
  let installTimer: ReturnType<typeof setTimeout> | null = null;
  let enabled = config.enabled;

  function statusLines(ctx: any, width: number, theme: Theme): string[] {
    const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "no model";
    const thinking = typeof pi.getThinkingLevel === "function" ? `think:${pi.getThinkingLevel()}` : "think:?";
    const usage = ctx.getContextUsage?.();
    const usageText = usage?.percent == null ? "ctx: ?" : `ctx: ${Math.round(usage.percent)}%`;
    const mode = enabled ? "floating" : "off";
    const line = ` ${theme.fg("accent", "◉")} ${theme.fg("muted", basename(ctx.cwd ?? process.cwd()))}  ${theme.fg("dim", model)}  ${theme.fg("dim", thinking)}  ${theme.fg("dim", usageText)}  ${theme.fg("success", mode)} `;
    return [fit(line, width)];
  }

  function infoLines(ctx: any, width: number, theme: Theme): string[] {
    const help = config.mouseScroll ? " wheel/page scroll • ctrl+shift+g bottom • /floating-input off " : " page scroll • /floating-input off ";
    return [fit(theme.fg("dim", help), width)];
  }

  function findContainerWithChild(tui: any, child: any): any | null {
    const children = Array.isArray(tui?.children) ? tui.children : [];
    for (const candidate of children) {
      if (Array.isArray(candidate?.children) && candidate.children.includes(child)) return candidate;
    }
    return null;
  }

  function teardown() {
    if (installTimer) {
      clearTimeout(installTimer);
      installTimer = null;
    }
    compositor?.dispose();
    compositor = null;
    editorContainer = null;
  }

  function scheduleInstall(ctx: any, tui: any) {
    if (!enabled || !ctx.hasUI || compositor) return;
    if (installTimer) clearTimeout(installTimer);
    installTimer = setTimeout(() => {
      installTimer = null;
      try {
        installCompositor(ctx, tui);
      } catch (error) {
        ctx.ui.notify(`[floating-input] install failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
      }
    }, 0);
  }

  function installCompositor(ctx: any, tui: any) {
    if (!enabled || compositor) return;
    if (!tui?.terminal?.write) throw new Error("missing tui.terminal.write");
    if (!currentEditor) throw new Error("custom editor not ready");
    editorContainer = findContainerWithChild(tui, currentEditor);
    if (!editorContainer?.render) throw new Error("could not find editor container");

    let split: SplitCompositor;
    split = new SplitCompositor({
      tui,
      terminal: tui.terminal,
      mouseScroll: config.mouseScroll,
      getShowHardwareCursor: () => typeof tui.getShowHardwareCursor === "function" && tui.getShowHardwareCursor(),
      renderCluster: (width, terminalRows) => {
        const theme = currentCtx?.ui?.theme ?? ctx.ui.theme;
        const editorLines = editorContainer ? split.renderHidden(editorContainer, width) : [];
        return renderFixedCluster({
          width,
          terminalRows,
          statusLines: statusLines(currentCtx ?? ctx, width, theme),
          editorLines,
          infoLines: infoLines(currentCtx ?? ctx, width, theme),
        });
      },
    });
    compositor = split;
    split.hideRenderable(editorContainer);
    split.install();
    tui.requestRender?.(true);
  }

  function setupEditor(ctx: any) {
    if (!ctx.hasUI) return;
    currentCtx = ctx;
    teardown();
    if (!enabled) {
      ctx.ui.setEditorComponent(undefined);
      ctx.ui.setFooter(undefined);
      return;
    }

    ctx.ui.setEditorComponent((tui: any, theme: any, keybindings: any) => {
      currentTui = tui;
      const editor = new CustomEditor(tui, theme, keybindings);
      currentEditor = editor;

      const originalHandleInput = editor.handleInput.bind(editor);
      editor.handleInput = (data: string) => {
        if (matchesJumpBottom(data)) {
          compositor?.jumpBottom();
          return;
        }
        originalHandleInput(data);
        if (typeof tui.requestRender === "function") tui.requestRender();
      };

      scheduleInstall(ctx, tui);
      return editor;
    });

    // Empty footer gives us a stable TUI reference through the official API and hides native footer.
    ctx.ui.setFooter((tui: any) => {
      currentTui = tui;
      scheduleInstall(ctx, tui);
      return { render: () => [], invalidate: () => {}, dispose: () => {} };
    });
  }

  function matchesJumpBottom(data: string): boolean {
    // Keep this intentionally broad; terminals encode ctrl+shift+g differently.
    return data === "\x07" || /\x1b\[(?:1;6G|71;6u|103;6u)/.test(data);
  }

  function setEnabled(ctx: any, next: boolean) {
    enabled = next;
    config = { ...config, enabled };
    saveConfig(config);
    if (!enabled) {
      teardown();
      ctx.ui.setEditorComponent(undefined);
      ctx.ui.setFooter(undefined);
      ctx.ui.notify("Floating input disabled. Run /reload if the default editor does not return immediately.", "info");
      return;
    }
    setupEditor(ctx);
    ctx.ui.notify("Floating input enabled", "info");
  }

  function notifyStatus(ctx: any) {
    ctx.ui.notify(`floating-input: ${enabled ? "on" : "off"}, mouseScroll=${config.mouseScroll}, imageMode=${config.imageMode}`, "info");
  }

  function resetTerminal(ctx: any) {
    teardown();
    try { process.stdout.write(emergencyTerminalReset()); } catch {}
    ctx.ui.notify("Floating input terminal reset sent", "info");
  }

  pi.registerCommand("floating-input", {
    description: "Floating input: toggle fixed editor on/off. Args: on|off|toggle|status|reset",
    handler: async (args, ctx) => {
      const arg = args.trim().toLowerCase();
      if (arg === "on") return setEnabled(ctx, true);
      if (arg === "off") return setEnabled(ctx, false);
      if (arg === "toggle" || arg === "") return setEnabled(ctx, !enabled);
      if (arg === "status") return notifyStatus(ctx);
      if (arg === "reset") return resetTerminal(ctx);
      ctx.ui.notify("Usage: /floating-input on|off|toggle|status|reset", "warning");
    },
  });

  pi.registerCommand("floating-input-on", {
    description: "Enable floating input fixed-editor mode",
    handler: async (_args, ctx) => setEnabled(ctx, true),
  });

  pi.registerCommand("floating-input-off", {
    description: "Disable floating input and restore Pi's default editor layout",
    handler: async (_args, ctx) => setEnabled(ctx, false),
  });

  pi.registerCommand("floating-input-toggle", {
    description: "Toggle floating input fixed-editor mode",
    handler: async (_args, ctx) => setEnabled(ctx, !enabled),
  });

  pi.registerCommand("floating-input-status", {
    description: "Show floating input state and settings",
    handler: async (_args, ctx) => notifyStatus(ctx),
  });

  pi.registerCommand("floating-input-reset", {
    description: "Emergency reset terminal state used by floating input",
    handler: async (_args, ctx) => resetTerminal(ctx),
  });

  pi.on("session_start", (_event, ctx) => {
    currentCtx = ctx;
    config = readConfig();
    enabled = config.enabled;
    setupEditor(ctx);
  });

  pi.on("session_shutdown", () => {
    teardown();
  });

  pi.on("model_select", (_event, ctx) => {
    currentCtx = ctx;
    currentTui?.requestRender?.();
  });

  pi.on("thinking_level_select", (_event, ctx) => {
    currentCtx = ctx;
    currentTui?.requestRender?.();
  });

  pi.on("message_update", (_event, ctx) => {
    currentCtx = ctx;
  });

  pi.on("agent_end", (_event, ctx) => {
    currentCtx = ctx;
    compositor?.jumpBottom();
  });
}
