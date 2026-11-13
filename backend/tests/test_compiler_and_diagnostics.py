"""Tests for LaTeX diagnostics parser and compiler artifact cache/pruning."""

import dataclasses
import os
import time

import compiler
from diagnostics import parse_diagnostics


def test_parse_diagnostics_windows_path_dedup_and_log_warnings():
    stderr = (
        r"error: C:\Users\researcher\main.tex:14:7: Undefined control sequence." "\n"
        r"error: C:\Users\researcher\main.tex:14:7: Undefined control sequence" "\n"
    )
    log_content = (
        "! LaTeX Error: Environment theorem undefined.\n"
        "See the LaTeX manual for details.\n"
        "l.22 \\begin{theorem}\n"
        "LaTeX Warning: Reference `fig:missing' on page 2 undefined on input line 35.\n"
        "Overfull \\hbox (12.3pt too wide) in paragraph at lines 40--44\n"
    )

    diags = parse_diagnostics(stderr, log_content)
    assert len(diags) == 4
    assert diags[0].severity == "error"
    assert diags[0].file == r"C:\Users\researcher\main.tex"
    assert diags[0].line == 14
    assert diags[0].column == 7
    assert diags[0].message == "Undefined control sequence"

    assert diags[1].severity == "error"
    assert diags[1].line == 22
    assert "Environment theorem undefined" in diags[1].message

    assert diags[2].severity == "warning"
    assert diags[2].line == 35

    assert diags[3].severity == "warning"
    assert diags[3].line == 40


def test_get_build_artifact_prefers_exact_source_and_falls_back_to_latest(tmp_path, monkeypatch):
    builds = tmp_path / "latex_builds"
    builds.mkdir()
    monkeypatch.setattr(
        compiler,
        "settings",
        dataclasses.replace(compiler.settings, data_dir=tmp_path),
    )

    doc_id = "doc_tex"
    old_dir = builds / "oldhash"
    old_dir.mkdir()
    old_pdf = old_dir / f"{doc_id}.pdf"
    old_pdf.write_bytes(b"old")
    os.utime(old_pdf, (100, 100))

    src = "\\documentclass{article}\\begin{document}Hi\\end{document}"
    exact_key = compiler.get_build_key(src, f"{doc_id}.tex")
    exact_dir = builds / exact_key
    exact_dir.mkdir()
    exact_pdf = exact_dir / f"{doc_id}.pdf"
    exact_pdf.write_bytes(b"exact")
    os.utime(exact_pdf, (200, 200))

    assert compiler.get_build_artifact(doc_id, ".pdf", source_content=src) == exact_pdf
    # Missing exact key falls back to newest matching artifact
    assert compiler.get_build_artifact(doc_id, ".pdf", source_content="changed") == exact_pdf
    assert compiler.get_build_artifact("missing", ".pdf") is None


def test_prune_all_builds_enforces_per_doc_and_global_caps(tmp_path, monkeypatch):
    builds = tmp_path / "latex_builds"
    temp_dir = tmp_path / "latex_temp"
    builds.mkdir()
    temp_dir.mkdir()

    monkeypatch.setattr(
        compiler,
        "settings",
        dataclasses.replace(
            compiler.settings,
            data_dir=tmp_path,
            latex_max_builds_per_doc=1,
            latex_max_total_builds=2,
            latex_max_total_bytes=0,
        ),
    )

    # 2 builds for doc_a (oldest should be pruned by per-doc cap=1) + 2 other docs
    now = time.time()
    for name, filename, mtime in [
        ("a_old", "doc_a.pdf", now - 400),
        ("a_new", "doc_a.pdf", now - 100),
        ("b_old", "doc_b.pdf", now - 300),
        ("c_new", "doc_c.pdf", now - 50),
    ]:
        d = builds / name
        d.mkdir()
        p = d / filename
        p.write_bytes(b"%PDF")
        os.utime(p, (mtime, mtime))
        os.utime(d, (mtime, mtime))

    # Stale temp dir (> 1h) should be cleaned; fresh one preserved
    stale_tmp = temp_dir / "stale"
    fresh_tmp = temp_dir / "fresh"
    stale_tmp.mkdir()
    fresh_tmp.mkdir()
    os.utime(stale_tmp, (now - 7200, now - 7200))
    os.utime(fresh_tmp, (now, now))

    stats = compiler.prune_all_builds()
    assert stats["deleted_dirs"] >= 2
    remaining = {d.name for d in builds.iterdir() if d.is_dir()}
    assert remaining == {"a_new", "c_new"}
    assert not stale_tmp.exists()
    assert fresh_tmp.exists()

