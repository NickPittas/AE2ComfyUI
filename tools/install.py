#!/usr/bin/env python3
"""AE2ComfyUI installer.

Links the ComfyUI custom-node package and the AE CEP panel into place.
Conservative: symlinks by default, --copy to copy instead, --dry-run to
preview. Never touches anything outside the two target directories.
"""

from __future__ import annotations

import argparse
import os
import platform
import shutil
import sys

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
COMFY_PKG = os.path.join(REPO_ROOT, "comfyui", "ae_bridge")
PANEL_DIR = os.path.join(REPO_ROOT, "ae", "ComfyUIBridge")


def default_cep_extensions_dir() -> str:
    system = platform.system()
    if system == "Darwin":
        return os.path.expanduser(
            "~/Library/Application Support/Adobe/CEP/extensions")
    if system == "Windows":
        return os.path.join(os.environ.get("APPDATA", ""), "Adobe", "CEP", "extensions")
    return ""  # Linux: no AE; ComfyUI side only


def link_or_copy(src: str, dst: str, copy: bool, dry_run: bool) -> str:
    if os.path.islink(dst) or os.path.exists(dst):
        return f"SKIP (exists): {dst}"
    action = "copy" if copy else "symlink"
    if dry_run:
        return f"DRY-RUN {action}: {src} -> {dst}"
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    if copy:
        shutil.copytree(src, dst)
    else:
        os.symlink(src, dst)
    return f"OK {action}: {src} -> {dst}"


def enable_cep_debug(dry_run: bool) -> str:
    """macOS PlayerDebugMode for unsigned CEP panels (CSXS 10/11/12)."""
    if platform.system() != "Darwin":
        return "SKIP debug mode (not macOS): set PlayerDebugMode manually on Windows"
    if dry_run:
        return "DRY-RUN defaults write com.adobe.CSXS.{10,11,12} PlayerDebugMode 1"
    import subprocess
    for version in ("10", "11", "12"):
        subprocess.run(
            ["defaults", "write", f"com.adobe.CSXS.{version}", "PlayerDebugMode", "1"],
            check=False)
    return "OK PlayerDebugMode=1 for CSXS 10/11/12 (restart AE)"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--comfyui", default=os.environ.get("COMFYUI_ROOT", ""),
                        help="ComfyUI root dir (or set COMFYUI_ROOT)")
    parser.add_argument("--cep-dir", default=default_cep_extensions_dir(),
                        help="CEP extensions dir (default: per-OS user dir)")
    parser.add_argument("--copy", action="store_true",
                        help="copy instead of symlink")
    parser.add_argument("--enable-debug", action="store_true",
                        help="enable CEP PlayerDebugMode for unsigned panels")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--yes", action="store_true", help="no prompts")
    args = parser.parse_args()

    steps = []

    if args.comfyui:
        custom_nodes = os.path.join(args.comfyui, "custom_nodes")
        if not os.path.isdir(custom_nodes):
            print(f"ERROR: no custom_nodes under {args.comfyui}")
            return 1
        steps.append(link_or_copy(
            COMFY_PKG, os.path.join(custom_nodes, "ae_bridge"),
            args.copy, args.dry_run))
    else:
        steps.append("SKIP ComfyUI: pass --comfyui /path/to/ComfyUI")

    if args.cep_dir:
        steps.append(link_or_copy(
            PANEL_DIR, os.path.join(args.cep_dir, "ComfyUIBridge"),
            args.copy, args.dry_run))
    else:
        steps.append("SKIP CEP panel: no extensions dir for this OS")

    if args.enable_debug:
        steps.append(enable_cep_debug(args.dry_run))

    for step in steps:
        print(step)

    if not args.dry_run:
        print("\nNext: restart ComfyUI and After Effects.")
        print("In AE: Window > Extensions > AE2ComfyUI.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
