import asyncio
import os
import sys

# Ensure backend directory is in path for imports
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

import logging

from database import get_db, store_chunks, init_db
from chunker import chunk_pdf

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


async def main():
    logger.info("Initializing database...")
    await init_db()

    logger.info("Scanning documents for missing chunk indexes...")
    async with get_db() as db:
        cursor = await db.execute("""
            SELECT d.id, d.file_path FROM documents d
            WHERE (d.doc_type IS NULL OR d.doc_type = 'pdf')
              AND d.file_path IS NOT NULL
              AND NOT EXISTS (
                SELECT 1 FROM document_chunks c WHERE c.document_id = d.id
              )
        """)
        docs = await cursor.fetchall()

    if not docs:
        logger.info("Nothing to do — every PDF is already indexed.")
        return

    logger.info("Found %d document(s) needing an index.", len(docs))
    indexed = failed = 0

    for doc in docs:
        doc_id = doc["id"]
        file_path = doc["file_path"]
        if not os.path.exists(file_path):
            logger.warning("File missing for %s: %s", doc_id, file_path)
            continue
        logger.info("Chunking document %s...", doc_id)
        try:
            chunks = await asyncio.to_thread(chunk_pdf, file_path)
            # store_chunks deletes before inserting, so re-running is safe.
            await store_chunks(doc_id, chunks)
            indexed += 1
            logger.info("Indexed %d chunks for %s.", len(chunks), doc_id)
        except Exception:
            logger.exception("Failed to chunk %s", doc_id)
            failed += 1

    logger.info("Done. indexed=%d failed=%d", indexed, failed)


if __name__ == "__main__":
    asyncio.run(main())