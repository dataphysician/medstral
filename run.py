`"""CLI entrypoint for testing MEDSTRAL traversal without the server."""
from __future__ import annotations

import asyncio
import logging
import os
import sys

from dotenv import load_dotenv

from agent import llm
from agent.llm import LLMConfig
from agent.traversal import (
    build_traversal_app,
    cleanup_persister,
    generate_traversal_cache_key,
)

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
logger = logging.getLogger(__name__)

SAMPLE_NOTE = """\
Patient is a 58-year-old male presenting with poorly controlled type 2 diabetes
mellitus. He has diabetic chronic kidney disease, stage 3. His most recent HbA1c
was 9.2%, indicating hyperglycemia. He also has essential hypertension, currently
managed with lisinopril. BMI is 32, consistent with obesity.
"""


async def main() -> None:
    load_dotenv()

    api_key = os.getenv("MISTRAL_API_KEY", "")
    if not api_key or api_key == "your-api-key-here":
        print("Set MISTRAL_API_KEY in .env to run live traversal.")
        print("Running in dry-run mode (testing graph construction only)...\n")
        await _dry_run()
        return

    llm.LLM_CONFIG = LLMConfig(api_key=api_key)

    note = SAMPLE_NOTE if len(sys.argv) < 2 else sys.argv[1]
    key = generate_traversal_cache_key(
        note, llm.LLM_CONFIG.model, llm.LLM_CONFIG.temperature
    )

    print(f"Cache key: {key[:16]}...")
    print(f"Clinical note: {note[:80]}...\n")

    try:
        app, cached = await build_traversal_app(context=note, partition_key=key)

        if cached:
            print("Cache hit — using cached results.")
            final_state = app.state
        else:
            print("Running live traversal...")
            _, _, final_state = await app.arun(
                halt_after=["finish"], inputs={}
            )

        final_nodes = final_state.get("final_nodes", [])
        batch_data = final_state.get("batch_data", {})

        print(f"\nTraversal complete.")
        print(f"  Batches processed: {len(batch_data)}")
        print(f"  Final codes ({len(final_nodes)}):")
        for code in final_nodes:
            print(f"    {code}")
    finally:
        await cleanup_persister()


async def _dry_run() -> None:
    """Test graph construction and ICD-10 index loading without LLM calls."""
    from agent.actions import get_index, get_node
    from agent.parallel import get_traversal_graph

    # Test index
    idx = get_index()
    print(f"ICD-10-CM index loaded: {len(idx)} nodes")

    root = get_node("ROOT")
    print(f"ROOT has {len(root['children'])} chapters")

    # Test a traversal path
    e11 = get_node("E11")
    print(f"E11 ({e11['label']}): depth={e11['depth']}, children={len(e11['children'])}")

    # Test graph construction
    graph = get_traversal_graph()
    print(f"\nTraversal graph built: entrypoint={graph.entrypoint}, halt_after={graph.halt_after}")
    print(f"Actions: {[a.name for a in graph.graph.actions]}")

    print("\nDry run complete — all components verified.")


if __name__ == "__main__":
    asyncio.run(main())
