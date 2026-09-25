import os
import asyncio
import hashlib
import shutil
from pathlib import Path
from pydantic import BaseModel
from diagnostics import parse_diagnostics, Diagnostic
import time

from config import settings

MAX_BUILDS_PER_DOC = settings.latex_max_builds_per_doc
MAX_TOTAL_BUILDS = settings.latex_max_total_builds
MAX_TOTAL_BYTES = settings.latex_max_total_bytes

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


def _builds_root() -> Path:
    return Path(__file__).parent / "data" / "latex_builds"


def _touch(path: Path) -> None:
    """Mark a cache hit as recently used so LRU keeps hot builds."""
    try:
        os.utime(path, None)
    except OSError:
        pass


def _prune_builds(keep_doc_id: str | None = None, keep_key: str | None = None) -> dict:
    """Evict old builds; never raises. Returns stats for logging."""
    stats = {"deleted_dirs": 0, "freed_bytes": 0}
    try:
        root = _builds_root()
        if not root.is_dir():
            return stats

        def _rmtree(d: Path) -> None:
            try:
                size = sum(f.stat().st_size for f in d.rglob("*") if f.is_file())
            except OSError:
                size = 0
            shutil.rmtree(d, ignore_errors=True)
            stats["deleted_dirs"] += 1
            stats["freed_bytes"] += size

        # 1. Per-doc cap: keep newest N builds for the compiled doc
        # (current + a couple for undo/fallback and in-flight serves).
        if keep_doc_id:
            pdfs = sorted(
                root.glob(f"*/{keep_doc_id}.pdf"),
                key=lambda p: p.stat().st_mtime if p.exists() else 0,
                reverse=True,
            )
            keep_dirs = {p.parent for p in pdfs[:MAX_BUILDS_PER_DOC]}
            if keep_key:
                keep_dirs.add(root / keep_key)
            for pdf in pdfs[MAX_BUILDS_PER_DOC:]:
                if pdf.parent not in keep_dirs and pdf.parent != root:
                    _rmtree(pdf.parent)

        # 2. Global count cap (LRU by dir mtime).
        all_dirs = sorted(
            [d for d in root.iterdir() if d.is_dir()],
            key=lambda d: d.stat().st_mtime if d.exists() else 0,
        )
        while len(all_dirs) > MAX_TOTAL_BUILDS:
            _rmtree(all_dirs.pop(0))

        # 3. Global size cap (LRU).
        if MAX_TOTAL_BYTES > 0:
            def _dir_size(d: Path) -> int:
                try:
                    return sum(f.stat().st_size for f in d.rglob("*") if f.is_file())
                except OSError:
                    return 0
            total = sum(_dir_size(d) for d in all_dirs if d.exists())
            for d in all_dirs:
                if total <= MAX_TOTAL_BYTES:
                    break
                if not d.exists():
                    continue
                total -= _dir_size(d)
                _rmtree(d)
    except Exception:
        pass
    return stats


def _prune_temp_orphans(max_age_s: float = 3600) -> None:
    """Remove abandoned per-attempt temp dirs (e.g. after a crash/kill).

    Attempt dirs have unique tokens so a live compile's dir is at most
    seconds old; anything older than max_age_s is dead by definition.
    Never raises.
    """
    try:
        import time as _time
        tmp_root = _builds_root().parent / "latex_temp"
        if not tmp_root.is_dir():
            return
        now_wall = _time.time()
        for d in tmp_root.iterdir():
            try:
                if not d.is_dir():
                    continue
                age = now_wall - d.stat().st_mtime
                if age > max_age_s:
                    shutil.rmtree(d, ignore_errors=True)
            except OSError:
                continue
    except Exception:
        pass


def prune_all_builds() -> dict:
    """Startup/manual full sweep: enforce per-doc cap for every doc."""
    stats = {"deleted_dirs": 0, "freed_bytes": 0}
    try:
        _prune_temp_orphans()
        root = _builds_root()
        if not root.is_dir():
            return stats
        doc_ids = {p.name.rsplit(".", 1)[0] for p in root.glob("*/*.pdf")}
        for doc_id in doc_ids:
            s = _prune_builds(keep_doc_id=doc_id)
            stats["deleted_dirs"] += s["deleted_dirs"]
            stats["freed_bytes"] += s["freed_bytes"]
        # Strip orphan synctex from pre-cap builds (nothing serves it).
        try:
            for st in root.glob("*.synctex.gz"):
                try:
                    stats["freed_bytes"] += st.stat().st_size
                    st.unlink()
                except OSError:
                    pass
            for st in root.glob("*/**.synctex.gz"):
                try:
                    stats["freed_bytes"] += st.stat().st_size
                    st.unlink()
                except OSError:
                    pass
        except Exception:
            pass
        s = _prune_builds()
        stats["deleted_dirs"] += s["deleted_dirs"]
        stats["freed_bytes"] += s["freed_bytes"]
    except Exception:
        pass
    return stats

async def run_compile(doc_id: str, source_content: str) -> BuildResult:
    start_time = time.monotonic()

    entrypoint = f"{doc_id}.tex"
    build_key = get_build_key(source_content, entrypoint)

    # Store everything in the root data folder
    base_data_dir = Path(__file__).parent / "data"
    # Unique temp dir per attempt: the old shared `latex_temp/<doc_id>` dir
    # let concurrent compiles for the same doc wipe/replace each other's
    # .tex mid-run, so build <hash-A> could end up containing hash-B's PDF
    # (stale/wrong PDF after save) or fail spuriously. Same-content
    # concurrent runs share byte-identical input, so sharing the dir only
    # within one attempt (token) is still race-free.
    import uuid as _uuid
    temp_dir = base_data_dir / "latex_temp" / f"{doc_id}_{build_key[:12]}_{_uuid.uuid4().hex[:8]}"
    builds_dir = base_data_dir / "latex_builds" / build_key
    
    pdf_path = builds_dir / Path(entrypoint).with_suffix(".pdf").name
    log_path = builds_dir / Path(entrypoint).with_suffix(".log").name
    
    if builds_dir.exists() and pdf_path.exists():
        _touch(builds_dir)
        diagnostics = []
        if log_path.exists():
            diagnostics = parse_diagnostics("", log_path.read_text(encoding="utf-8", errors="replace"))
        return BuildResult(
            build_id=build_key,
            cached=True,
            status="success",
            duration_ms=int((time.monotonic() - start_time) * 1000),
            diagnostics=diagnostics
        )
    
    # Throttle concurrency
    async with compile_semaphore:
        # We might have waited, so check cache again just in case
        if builds_dir.exists() and pdf_path.exists():
            _touch(builds_dir)
            diagnostics = []
            if log_path.exists():
                diagnostics = parse_diagnostics("", log_path.read_text(encoding="utf-8", errors="replace"))
            return BuildResult(
                build_id=build_key,
                cached=True,
                status="success",
                duration_ms=int((time.monotonic() - start_time) * 1000),
                diagnostics=diagnostics
            )

        # Clear temp dir for this attempt (fresh uuid — normally absent;
        # rm -rf here only guards against a recycled name)
        if temp_dir.exists():
            shutil.rmtree(temp_dir, ignore_errors=True)
        temp_dir.mkdir(parents=True, exist_ok=True)
        
        # Write source file
        (temp_dir / entrypoint).write_text(source_content, encoding="utf-8")
        
        tectonic_bin = shutil.which("tectonic")
        if not tectonic_bin:
            return BuildResult(
                build_id=build_key,
                cached=False,
                status="error",
                duration_ms=0,
                diagnostics=[Diagnostic(severity="error", message="Tectonic compiler not found. Please run 'uv pip install tecto' or 'pip install tecto' in your backend environment.")]
            )
            
        process = await asyncio.create_subprocess_exec(
            tectonic_bin, "--outdir", str(temp_dir), "--keep-logs", entrypoint,
            cwd=str(temp_dir),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE
        )
        
        try:
            stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=45.0)
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
            # Evict stale snapshots (bounded cache). Runs after the copy so
            # the just-built dir is always retained; never fails the build.
            # NOTE: synctex deliberately not stored — no endpoint or viewer
            # code consumes .synctex.gz, it only bloated every snapshot.
            _touch(builds_dir)
            _prune_builds(keep_doc_id=doc_id, keep_key=build_key)
            _prune_temp_orphans()
                
        # Clean up temp
        shutil.rmtree(temp_dir, ignore_errors=True)
        
        return BuildResult(
            build_id=build_key,
            cached=False,
            status=status,
            duration_ms=int((time.monotonic() - start_time) * 1000),
            diagnostics=diagnostics
        )
