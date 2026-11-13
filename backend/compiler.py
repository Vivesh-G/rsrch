import os
import asyncio
import hashlib
import shutil
import uuid as _uuid
from pathlib import Path
from pydantic import BaseModel
from diagnostics import parse_diagnostics, Diagnostic
import time

from config import settings


class BuildResult(BaseModel):
    build_id: str
    cached: bool
    status: str
    duration_ms: int
    diagnostics: list[Diagnostic]

# Global semaphore for compilation to throttle CPU usage
compile_semaphore = asyncio.Semaphore(2)


def get_build_key(source_content: str, entrypoint: str) -> str:
    hasher = hashlib.sha256()
    hasher.update(entrypoint.encode("utf-8"))
    hasher.update(source_content.encode("utf-8"))
    return hasher.hexdigest()


def get_build_artifact(doc_id: str, suffix: str, source_content: str = "") -> Path | None:
    """Resolve a compiled artifact (`suffix` like '.pdf' or '.synctex.gz') from cache, falling back to latest."""
    root = settings.latex_builds_dir
    if not root.is_dir():
        return None
    filename = f"{doc_id}{suffix}"
    if source_content:
        exact = root / get_build_key(source_content, f"{doc_id}.tex") / filename
        if exact.is_file():
            return exact
    matches = [p for p in root.glob(f"*/{filename}") if p.is_file()]
    return max(matches, key=lambda p: p.stat().st_mtime) if matches else None


def _touch(path: Path) -> None:
    """Mark a cache hit as recently used so LRU keeps hot builds."""
    try:
        os.utime(path, None)
    except OSError:
        pass


def _measure_dir_size(d: Path) -> int:
    try:
        return sum(f.stat().st_size for f in d.rglob("*") if f.is_file())
    except OSError:
        return 0


def _rmtree_tracked(d: Path, stats: dict) -> None:
    size = _measure_dir_size(d)
    shutil.rmtree(d, ignore_errors=True)
    stats["deleted_dirs"] += 1
    stats["freed_bytes"] += size


def _prune_doc_builds(root: Path, keep_doc_id: str, keep_key: str | None, stats: dict) -> None:
    max_per_doc = settings.latex_max_builds_per_doc
    pdfs = sorted(
        root.glob(f"*/{keep_doc_id}.pdf"),
        key=lambda p: p.stat().st_mtime if p.exists() else 0,
        reverse=True,
    )
    keep_dirs = {p.parent for p in pdfs[:max_per_doc]}
    if keep_key:
        keep_dirs.add(root / keep_key)
    for pdf in pdfs[max_per_doc:]:
        if pdf.parent not in keep_dirs and pdf.parent != root:
            _rmtree_tracked(pdf.parent, stats)


def _prune_global_builds(root: Path, stats: dict) -> None:
    all_dirs = sorted(
        [d for d in root.iterdir() if d.is_dir()],
        key=lambda d: d.stat().st_mtime if d.exists() else 0,
    )
    while len(all_dirs) > settings.latex_max_total_builds:
        _rmtree_tracked(all_dirs.pop(0), stats)

    max_bytes = settings.latex_max_total_bytes
    if max_bytes > 0:
        total = sum(_measure_dir_size(d) for d in all_dirs if d.exists())
        for d in all_dirs:
            if total <= max_bytes:
                break
            if not d.exists():
                continue
            total -= _measure_dir_size(d)
            _rmtree_tracked(d, stats)


def _prune_builds(keep_doc_id: str | None = None, keep_key: str | None = None) -> dict:
    """Evict old builds; never raises. Returns stats for logging."""
    stats = {"deleted_dirs": 0, "freed_bytes": 0}
    try:
        root = settings.latex_builds_dir
        if not root.is_dir():
            return stats
        if keep_doc_id:
            _prune_doc_builds(root, keep_doc_id, keep_key, stats)
        _prune_global_builds(root, stats)
    except OSError:
        pass
    return stats


def _prune_temp_orphans(max_age_s: float = 3600) -> None:
    """Remove abandoned per-attempt temp dirs older than max_age_s."""
    try:
        tmp_root = settings.latex_temp_dir
        if not tmp_root.is_dir():
            return
        now_wall = time.time()
        for d in tmp_root.iterdir():
            try:
                if not d.is_dir():
                    continue
                age = now_wall - d.stat().st_mtime
                if age > max_age_s:
                    shutil.rmtree(d, ignore_errors=True)
            except OSError:
                continue
    except OSError:
        pass


def prune_all_builds() -> dict:
    """Startup/manual full sweep: enforce per-doc cap for every doc."""
    stats = {"deleted_dirs": 0, "freed_bytes": 0}
    try:
        _prune_temp_orphans()
        root = settings.latex_builds_dir
        if not root.is_dir():
            return stats
        doc_ids = {p.name.rsplit(".", 1)[0] for p in root.glob("*/*.pdf")}
        for doc_id in doc_ids:
            _prune_doc_builds(root, doc_id, None, stats)
        _prune_global_builds(root, stats)
    except OSError:
        pass
    return stats


def _cached_result(
    builds_dir: Path, pdf_path: Path, log_path: Path, build_key: str, start_time: float
) -> BuildResult | None:
    if builds_dir.exists() and pdf_path.exists():
        _touch(builds_dir)
        diagnostics = []
        if log_path.exists():
            diagnostics = parse_diagnostics(
                "", log_path.read_text(encoding="utf-8", errors="replace")
            )
        return BuildResult(
            build_id=build_key,
            cached=True,
            status="success",
            duration_ms=int((time.monotonic() - start_time) * 1000),
            diagnostics=diagnostics,
        )
    return None

async def run_compile(doc_id: str, source_content: str, workspace_id: str | None = None) -> BuildResult:
    start_time = time.monotonic()

    entrypoint = f"{doc_id}.tex"
    build_key = get_build_key(source_content, entrypoint)

    temp_dir = settings.latex_temp_dir / f"{doc_id}_{build_key[:12]}_{_uuid.uuid4().hex[:8]}"
    builds_dir = settings.latex_builds_dir / build_key

    pdf_path = builds_dir / f"{doc_id}.pdf"
    log_path = builds_dir / f"{doc_id}.log"

    cached = _cached_result(builds_dir, pdf_path, log_path, build_key, start_time)
    if cached:
        return cached

    async with compile_semaphore:
        cached = _cached_result(builds_dir, pdf_path, log_path, build_key, start_time)
        if cached:
            return cached

        tectonic_bin = shutil.which("tectonic")
        if not tectonic_bin:
            return BuildResult(
                build_id=build_key,
                cached=False,
                status="error",
                duration_ms=0,
                diagnostics=[Diagnostic(severity="error", message="Tectonic compiler not found. Please run 'uv pip install tecto' or 'pip install tecto' in your backend environment.")]
            )

        temp_dir.mkdir(parents=True, exist_ok=True)
        (temp_dir / entrypoint).write_text(source_content, encoding="utf-8")
        if workspace_id:
            assets_dir = settings.workspace_assets_dir(workspace_id)
            if assets_dir.exists():
                shutil.copytree(assets_dir, temp_dir, dirs_exist_ok=True)

        process = await asyncio.create_subprocess_exec(
            tectonic_bin, "--outdir", str(temp_dir), "--keep-logs", "--synctex", entrypoint,
            cwd=str(temp_dir),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE
        )

        try:
            _stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=45.0)
        except asyncio.TimeoutError:
            try:
                process.kill()
            except OSError:
                pass
            shutil.rmtree(temp_dir, ignore_errors=True)
            return BuildResult(
                build_id=build_key,
                cached=False,
                status="timeout",
                duration_ms=int((time.monotonic() - start_time) * 1000),
                diagnostics=[Diagnostic(severity="error", message="Compilation timed out.")]
            )
            
        temp_log = temp_dir / Path(entrypoint).with_suffix(".log").name
        log_content = ""
        if temp_log.exists():
            log_content = temp_log.read_text(encoding="utf-8", errors="replace")
            
        diagnostics = parse_diagnostics(stderr.decode(errors="replace"), log_content)
        status = "success" if process.returncode == 0 else "error"
        
        # If success, move to permanent cache
        if status == "success":
            builds_dir.mkdir(parents=True, exist_ok=True)
            temp_pdf = temp_dir / Path(entrypoint).with_suffix(".pdf").name
            if temp_pdf.exists():
                shutil.copy(temp_pdf, pdf_path)
            if temp_log.exists():
                shutil.copy(temp_log, log_path)
            temp_synctex = temp_dir / Path(entrypoint).with_suffix(".synctex.gz").name
            if temp_synctex.exists():
                shutil.copy(temp_synctex, builds_dir / Path(entrypoint).with_suffix(".synctex.gz").name)
            
            # Evict stale snapshots (bounded cache). Runs after the copy so
            # the just-built dir is always retained; never fails the build.
            _touch(builds_dir)
            _prune_builds(keep_doc_id=doc_id, keep_key=build_key)
            _prune_temp_orphans()
                
        shutil.rmtree(temp_dir, ignore_errors=True)
        
        return BuildResult(
            build_id=build_key,
            cached=False,
            status=status,
            duration_ms=int((time.monotonic() - start_time) * 1000),
            diagnostics=diagnostics
        )
