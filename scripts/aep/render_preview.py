#!/usr/bin/env python3
"""Render one representative frame of a local .aep template into the F2A template cache.

AEP files carry no still image, so the panel asks After Effects (through a separate headless
aerender process, never the user's open AE project) to render one frame at ~35% of the main
composition. The resulting image/video becomes the card preview and is cached by AEP path +
mtime + size; later panel opens reuse it without launching AE again.

Usage:
  python render_preview.py --aep <template.aep> --cache-dir <pack-cache/aep-xxxx>

Writes preview.(mp4|mov|png|jpg) + meta.json into --cache-dir and prints a JSON summary.
"""

import argparse
import json
import os
import re
import subprocess
import sys
import time

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

try:
    import py_aep
except Exception as exc:  # reported through the panel
    print(json.dumps({"ok": False, "error": "py_aep 不可用：" + str(exc)}, ensure_ascii=False))
    sys.exit(0)

PREVIEW_EXTS = (".png", ".jpg", ".jpeg", ".webp")
VIDEO_EXTS = (".mp4", ".mov", ".webm")


def find_aerender():
    env = os.environ.get("F2A_AERENDER")
    if env and os.path.isfile(env):
        return env
    candidates = []
    try:
        import winreg
        roots = [
            (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Adobe\After Effects"),
            (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\WOW6432Node\Adobe\After Effects"),
            (winreg.HKEY_CURRENT_USER, r"SOFTWARE\Adobe\After Effects"),
        ]
        for hive, base in roots:
            try:
                key = winreg.OpenKey(hive, base)
            except OSError:
                continue
            index = 0
            while True:
                try:
                    name = winreg.EnumKey(key, index)
                except OSError:
                    break
                index += 1
                try:
                    install, _ = winreg.QueryValueEx(winreg.OpenKey(key, name), "InstallPath")
                except OSError:
                    continue
                if install:
                    try:
                        version = float(name)
                    except ValueError:
                        version = 0.0
                    candidates.append((version, os.path.join(install, "aerender.exe")))
    except Exception:
        pass
    for base in (os.environ.get("ProgramFiles"), os.environ.get("ProgramFiles(x86)")):
        if not base:
            continue
        try:
            adobe_dirs = [os.path.join(base, n) for n in os.listdir(base) if n.startswith("Adobe")]
        except OSError:
            continue
        for adobe in adobe_dirs:
            if not os.path.isdir(adobe):
                continue
            for name in os.listdir(adobe):
                if name.lower().startswith(("after effects", "adobe after effects")):
                    match = re.search(r"(\d{4}|\d{2})(?:\.\d+)?", name)
                    version = float(match.group(1)) if match else 0.0
                    candidates.append((version, os.path.join(adobe, name, "Support Files", "aerender.exe")))
    candidates.sort(key=lambda pair: pair[0], reverse=True)
    for _, path in candidates:
        path = os.path.abspath(path)
        if os.path.isfile(path):
            return path
    return None


def clean_stem(path):
    text = os.path.splitext(os.path.basename(path))[0]
    text = re.sub(r"\s+(?:copy|复制)(?:\s.*)?$", "", text, flags=re.I)
    text = re.sub(r"[\s_-]+\d+\.x$", "", text, flags=re.I)
    text = re.sub(r"[\s_-]+\d{2}\.\d$", "", text, flags=re.I)
    return text.strip()


def pick_comp(comps, aep_path):
    stem = clean_stem(aep_path)

    def name_of(comp):
        return str(getattr(comp, "name", "") or "")

    def area(comp):
        return float(getattr(comp, "width", 0) or 0) * float(getattr(comp, "height", 0) or 0)

    exact = [c for c in comps if name_of(c) == stem]
    if exact:
        return exact[0]
    contains = [c for c in comps if name_of(c) and (name_of(c) in stem or stem in name_of(c))]
    if contains:
        return contains[0]
    render = [c for c in comps if re.search(r"render|final|main|preview|output|成品|主合成", name_of(c), re.I)]
    if render:
        return max(render, key=area)
    # Ignore auto-generated component names (Frame 132..., Group 132..., etc.) when a
    # deliberately named comp exists; those are usually internal helper comps.
    auto = re.compile(r"^(?:frame|group|precomp|vector|ellipse|rectangle|shape)\s*\d*$", re.I)
    named = [c for c in comps if name_of(c) and not auto.match(name_of(c).strip())]
    if named:
        return max(named, key=area)
    return max(comps, key=area) if comps else None


def output_file(directory):
    candidates = []
    for name in os.listdir(directory):
        lower = name.lower()
        if lower in ("meta.json", ".probed") or lower.endswith(".json"):
            continue
        full = os.path.join(directory, name)
        if os.path.isfile(full) and (lower.endswith(PREVIEW_EXTS) or lower.endswith(VIDEO_EXTS)):
            candidates.append(full)
    candidates.sort(key=os.path.getmtime, reverse=True)
    return candidates[0] if candidates else None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--aep", required=True)
    parser.add_argument("--cache-dir", required=True)
    args = parser.parse_args()

    aep_path = os.path.abspath(args.aep)
    cache_dir = os.path.abspath(args.cache_dir)
    meta_path = os.path.join(cache_dir, "meta.json")
    if os.path.isfile(meta_path):
        try:
            meta = json.load(open(meta_path, encoding="utf-8"))
            if meta.get("file") and os.path.isfile(meta["file"]):
                print(json.dumps({"ok": True, "cached": True, **meta}, ensure_ascii=False))
                return
        except Exception:
            pass

    os.makedirs(cache_dir, exist_ok=True)
    for name in os.listdir(cache_dir):
        lower = name.lower()
        if lower != "meta.json" and (lower.endswith(PREVIEW_EXTS) or lower.endswith(VIDEO_EXTS)):
            try:
                os.remove(os.path.join(cache_dir, name))
            except OSError:
                pass

    try:
        application = py_aep.parse(aep_path)
        comps = [item for item in application.project.items.values() if isinstance(item, py_aep.CompItem)]
        comp = pick_comp(comps, aep_path)
        if comp is None:
            raise RuntimeError("AEP 里没有可渲染的合成")
        fps = float(getattr(comp, "frame_rate", 30) or 30)
        duration = float(getattr(comp, "duration", 0) or 0)
        frame = int(round(duration * fps * 0.35)) if duration > 0 else 0
        frame = max(0, min(frame, max(0, int(round(duration * fps)) - 1)))
    except Exception as exc:
        print(json.dumps({"ok": False, "error": "解析 AEP 失败：" + str(exc)}, ensure_ascii=False))
        return

    aerender = find_aerender()
    if not aerender:
        print(json.dumps({"ok": False, "error": "未找到 aerender（After Effects 安装路径）"}, ensure_ascii=False))
        return

    output = os.path.join(cache_dir, "preview.mp4")
    command = [
        aerender,
        "-project", aep_path,
        "-comp", str(comp.name),
        "-s", str(frame), "-e", str(frame),
        "-continueOnMissingFootage",
        "-close", "DO_NOT_SAVE_CHANGES",
        "-output", output,
    ]
    started = time.time()
    log_path = os.path.join(cache_dir, "aerender.log")
    try:
        with open(log_path, "wb") as log_handle:
            process = subprocess.Popen(
                command,
                stdout=log_handle,
                stderr=subprocess.STDOUT,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
            try:
                exit_code = process.wait(timeout=90)
            except subprocess.TimeoutExpired:
                # aerender can spawn its own After Effects process; kill the whole tree.
                try:
                    subprocess.run(["taskkill", "/PID", str(process.pid), "/T", "/F"],
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                   creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
                except Exception:
                    pass
                try:
                    process.wait(timeout=10)
                except Exception:
                    pass
                print(json.dumps({"ok": False, "error": "渲染超时（aerender 超过 90 秒）"}, ensure_ascii=False))
                return
    except Exception as exc:
        print(json.dumps({"ok": False, "error": "启动 aerender 失败：" + str(exc)}, ensure_ascii=False))
        return

    produced = output_file(cache_dir)
    if not produced:
        tail = []
        try:
            with open(log_path, "rb") as log_handle:
                raw = log_handle.read().decode("utf-8", "replace")
            tail = [line for line in raw.strip().splitlines() if line.strip()][-6:]
        except Exception:
            pass
        print(json.dumps({"ok": False, "error": "aerender 没有生成预览：" + " / ".join(tail)}, ensure_ascii=False))
        return

    lower = produced.lower()
    kind = "video" if lower.endswith(VIDEO_EXTS) else "image"
    meta = {
        "file": produced,
        "kind": kind,
        "comp": str(comp.name),
        "frame": frame,
        "fps": fps,
        "duration": duration,
        "width": int(getattr(comp, "width", 0) or 0),
        "height": int(getattr(comp, "height", 0) or 0),
        "elapsed": round(time.time() - started, 2),
    }
    if kind == "video" and os.path.getsize(produced) < 500:
        meta = {**meta, "kind": "video", "warning": "preview file is very small"}
    with open(meta_path, "w", encoding="utf-8") as handle:
        json.dump(meta, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
    print(json.dumps({"ok": True, **meta}, ensure_ascii=False))


if __name__ == "__main__":
    main()
