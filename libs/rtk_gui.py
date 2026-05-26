#!/usr/bin/env python3
"""Graphical interface for DJI RTK image metadata analysis."""

from __future__ import annotations

import os
import threading
import tkinter as tk
from collections import Counter
from pathlib import Path
from tkinter import filedialog, messagebox, ttk
from typing import Optional

from rtk_analysis import (
    MAP_CATEGORIES,
    AnalysisOutputs,
    ImageRtkRecord,
    build_report_text,
    find_exiftool,
    run_analysis,
)

CATEGORY_ROW_COLORS = {
    "Fix": "#d8f5d0",
    "Fix+Warn": "#fff6bf",
    "Float": "#ffd9a8",
    "Single": "#ffc8c8",
}

FILTER_OPTIONS = ("All", "Fix", "Fix+Warn", "Float", "Single", "Flagged only")


class RtkAnalysisApp(tk.Tk):
    def __init__(self, default_folder: Optional[Path] = None) -> None:
        super().__init__()
        self.title("DJI RTK Analysis")
        self.geometry("1100x720")
        self.minsize(900, 600)

        self.outputs: Optional[AnalysisOutputs] = None
        self._analysis_thread: Optional[threading.Thread] = None
        self._folder_var = tk.StringVar(
            value=str(default_folder.resolve()) if default_folder else ""
        )
        self._filter_var = tk.StringVar(value="All")
        self._search_var = tk.StringVar()
        self._status_var = tk.StringVar(value="Select a folder and run analysis.")

        self._summary_labels: dict[str, tk.Label] = {}
        self._build_ui()
        self._search_var.trace_add("write", lambda *_: self._refresh_table())
        self._filter_var.trace_add("write", lambda *_: self._refresh_table())
        self._check_exiftool()

    def _build_ui(self) -> None:
        padding = {"padx": 10, "pady": 6}
        root = ttk.Frame(self)
        root.pack(fill=tk.BOTH, expand=True)

        folder_frame = ttk.LabelFrame(root, text="Image Folder")
        folder_frame.pack(fill=tk.X, **padding)

        folder_entry = ttk.Entry(folder_frame, textvariable=self._folder_var)
        folder_entry.pack(side=tk.LEFT, fill=tk.X, expand=True, padx=(10, 6), pady=10)
        ttk.Button(folder_frame, text="Browse...", command=self._browse_folder).pack(
            side=tk.LEFT, padx=(0, 6), pady=10
        )
        self._run_button = ttk.Button(folder_frame, text="Run Analysis", command=self._start_analysis)
        self._run_button.pack(side=tk.LEFT, padx=(0, 10), pady=10)

        summary_frame = ttk.LabelFrame(root, text="Summary")
        summary_frame.pack(fill=tk.X, **padding)

        summary_grid = ttk.Frame(summary_frame)
        summary_grid.pack(fill=tk.X, padx=10, pady=10)

        for index, key in enumerate(
            ("images", "drone", "fixed_pct", "fix", "fix_warn", "float", "single")
        ):
            label = ttk.Label(summary_grid, text="—", font=("Segoe UI", 10))
            label.grid(row=index // 4, column=index % 4, sticky="w", padx=(0, 24), pady=2)
            self._summary_labels[key] = label

        legend = ttk.Frame(summary_frame)
        legend.pack(fill=tk.X, padx=10, pady=(0, 10))
        for category in ("Fix", "Fix+Warn", "Float", "Single"):
            color = MAP_CATEGORIES[category]["color_hex"]
            swatch = tk.Label(
                legend,
                text="  ",
                background=color,
                relief=tk.SOLID,
                borderwidth=1,
            )
            swatch.pack(side=tk.LEFT, padx=(0, 4))
            ttk.Label(legend, text=category).pack(side=tk.LEFT, padx=(0, 16))

        controls = ttk.Frame(root)
        controls.pack(fill=tk.X, **padding)
        ttk.Label(controls, text="Filter:").pack(side=tk.LEFT)
        ttk.Combobox(
            controls,
            textvariable=self._filter_var,
            values=FILTER_OPTIONS,
            state="readonly",
            width=14,
        ).pack(side=tk.LEFT, padx=(6, 16))
        ttk.Label(controls, text="Search:").pack(side=tk.LEFT)
        ttk.Entry(controls, textvariable=self._search_var, width=30).pack(side=tk.LEFT, padx=(6, 0))

        paned = ttk.Panedwindow(root, orient=tk.VERTICAL)
        paned.pack(fill=tk.BOTH, expand=True, padx=10, pady=(0, 6))

        table_frame = ttk.LabelFrame(paned, text="Images")
        report_frame = ttk.LabelFrame(paned, text="Report")
        paned.add(table_frame, weight=3)
        paned.add(report_frame, weight=2)

        columns = ("filename", "category", "flag", "diff_age", "quality", "issues")
        self._tree = ttk.Treeview(
            table_frame,
            columns=columns,
            show="headings",
            selectmode="browse",
        )
        headings = {
            "filename": ("Filename", 260),
            "category": ("Category", 90),
            "flag": ("Flag", 50),
            "diff_age": ("Diff Age", 80),
            "quality": ("Quality", 70),
            "issues": ("Issues", 420),
        }
        for column, (heading, width) in headings.items():
            self._tree.heading(column, text=heading)
            self._tree.column(column, width=width, anchor=tk.W)

        for category, color in CATEGORY_ROW_COLORS.items():
            self._tree.tag_configure(category, background=color)

        tree_scroll_y = ttk.Scrollbar(table_frame, orient=tk.VERTICAL, command=self._tree.yview)
        tree_scroll_x = ttk.Scrollbar(table_frame, orient=tk.HORIZONTAL, command=self._tree.xview)
        self._tree.configure(yscrollcommand=tree_scroll_y.set, xscrollcommand=tree_scroll_x.set)
        self._tree.grid(row=0, column=0, sticky="nsew")
        tree_scroll_y.grid(row=0, column=1, sticky="ns")
        tree_scroll_x.grid(row=1, column=0, sticky="ew")
        table_frame.rowconfigure(0, weight=1)
        table_frame.columnconfigure(0, weight=1)

        self._report_text = tk.Text(
            report_frame,
            wrap=tk.WORD,
            font=("Consolas", 10),
            state=tk.DISABLED,
        )
        report_scroll = ttk.Scrollbar(report_frame, orient=tk.VERTICAL, command=self._report_text.yview)
        self._report_text.configure(yscrollcommand=report_scroll.set)
        self._report_text.pack(side=tk.LEFT, fill=tk.BOTH, expand=True, padx=(10, 0), pady=10)
        report_scroll.pack(side=tk.RIGHT, fill=tk.Y, pady=10, padx=(0, 10))

        actions = ttk.Frame(root)
        actions.pack(fill=tk.X, **padding)
        self._open_buttons: dict[str, ttk.Button] = {}
        for label, key, command in (
            ("Open CSV", "csv", lambda: self._open_output("csv")),
            ("Open KML", "kml", lambda: self._open_output("kml")),
            ("Open GeoJSON", "geojson", lambda: self._open_output("geojson")),
            ("Open Folder", "folder", self._open_folder),
        ):
            button = ttk.Button(actions, text=label, command=command, state=tk.DISABLED)
            button.pack(side=tk.LEFT, padx=(0, 8))
            self._open_buttons[key] = button

        status_bar = ttk.Label(root, textvariable=self._status_var, anchor=tk.W)
        status_bar.pack(fill=tk.X, padx=10, pady=(0, 10))

    def _check_exiftool(self) -> None:
        try:
            find_exiftool()
        except RuntimeError as exc:
            messagebox.showwarning("ExifTool Not Found", str(exc))

    def _browse_folder(self) -> None:
        initial = self._folder_var.get() or str(Path.home())
        selected = filedialog.askdirectory(initialdir=initial, title="Select image folder")
        if selected:
            self._folder_var.set(selected)

    def _start_analysis(self) -> None:
        if self._analysis_thread and self._analysis_thread.is_alive():
            return

        folder_text = self._folder_var.get().strip()
        if not folder_text:
            messagebox.showerror("Missing Folder", "Please select a folder containing images.")
            return

        folder = Path(folder_text)
        if not folder.is_dir():
            messagebox.showerror("Invalid Folder", f"Folder not found:\n{folder}")
            return

        self._run_button.configure(state=tk.DISABLED)
        self._status_var.set("Analyzing images...")
        for button in self._open_buttons.values():
            button.configure(state=tk.DISABLED)

        self._analysis_thread = threading.Thread(
            target=self._run_analysis_worker,
            args=(folder,),
            daemon=True,
        )
        self._analysis_thread.start()

    def _run_analysis_worker(self, folder: Path) -> None:
        try:
            outputs = run_analysis(folder)
            self.after(0, lambda: self._on_analysis_success(outputs))
        except Exception as exc:
            self.after(0, lambda: self._on_analysis_error(exc))

    def _on_analysis_success(self, outputs: AnalysisOutputs) -> None:
        self.outputs = outputs
        self._update_summary(outputs.records)
        self._set_report(build_report_text(outputs.records, outputs.folder))
        self._refresh_table()
        for button in self._open_buttons.values():
            button.configure(state=tk.NORMAL)
        self._run_button.configure(state=tk.NORMAL)
        self._status_var.set(
            f"Done. {len(outputs.records)} images analyzed. "
            f"Outputs saved to {outputs.folder}"
        )

    def _on_analysis_error(self, exc: Exception) -> None:
        self._run_button.configure(state=tk.NORMAL)
        self._status_var.set("Analysis failed.")
        messagebox.showerror("Analysis Failed", str(exc))

    def _update_summary(self, records: list[ImageRtkRecord]) -> None:
        total = len(records)
        map_counts = Counter(record.map_category for record in records)
        fixed_pct = 100.0 * sum(1 for record in records if record.rtk_flag == 50) / total if total else 0.0
        drone = records[0].product_name or records[0].drone_model or "Unknown" if records else "—"

        self._summary_labels["images"].configure(text=f"Images: {total}")
        self._summary_labels["drone"].configure(text=f"Drone: {drone}")
        self._summary_labels["fixed_pct"].configure(text=f"RTK Fixed: {fixed_pct:.1f}%")
        self._summary_labels["fix"].configure(text=f"Fix: {map_counts.get('Fix', 0)}")
        self._summary_labels["fix_warn"].configure(text=f"Fix+Warn: {map_counts.get('Fix+Warn', 0)}")
        self._summary_labels["float"].configure(text=f"Float: {map_counts.get('Float', 0)}")
        self._summary_labels["single"].configure(text=f"Single: {map_counts.get('Single', 0)}")

    def _set_report(self, text: str) -> None:
        self._report_text.configure(state=tk.NORMAL)
        self._report_text.delete("1.0", tk.END)
        self._report_text.insert(tk.END, text)
        self._report_text.configure(state=tk.DISABLED)

    def _filtered_records(self) -> list[ImageRtkRecord]:
        if not self.outputs:
            return []

        records = self.outputs.records
        filter_value = self._filter_var.get()
        if filter_value == "Flagged only":
            records = [record for record in records if record.quality != "PASS"]
        elif filter_value != "All":
            records = [record for record in records if record.map_category == filter_value]

        search = self._search_var.get().strip().lower()
        if search:
            records = [
                record
                for record in records
                if search in record.filename.lower() or search in record.issues.lower()
            ]
        return records

    def _refresh_table(self) -> None:
        self._tree.delete(*self._tree.get_children())
        for record in self._filtered_records():
            diff_age = f"{record.rtk_diff_age:.1f}s" if record.rtk_diff_age is not None else "—"
            self._tree.insert(
                "",
                tk.END,
                values=(
                    record.filename,
                    record.map_category,
                    record.rtk_flag if record.rtk_flag is not None else "—",
                    diff_age,
                    record.quality,
                    record.issues or "—",
                ),
                tags=(record.map_category,),
            )

    def _open_output(self, kind: str) -> None:
        if not self.outputs:
            return
        path = {
            "csv": self.outputs.csv_path,
            "kml": self.outputs.kml_path,
            "geojson": self.outputs.geojson_path,
        }[kind]
        self._open_path(path)

    def _open_folder(self) -> None:
        if self.outputs:
            self._open_path(self.outputs.folder)

    def _open_path(self, path: Path) -> None:
        if not path.exists():
            messagebox.showerror("File Not Found", f"Path does not exist:\n{path}")
            return
        try:
            os.startfile(path)  # type: ignore[attr-defined]
        except OSError as exc:
            messagebox.showerror("Open Failed", str(exc))


def launch_gui(default_folder: Optional[Path] = None) -> None:
    app = RtkAnalysisApp(default_folder=default_folder)
    app.mainloop()


if __name__ == "__main__":
    launch_gui()
