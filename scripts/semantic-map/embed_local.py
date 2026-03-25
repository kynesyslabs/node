#!/usr/bin/env python3

import json
import os
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable, List, Tuple


@dataclass(frozen=True)
class Atom:
    uuid: str
    descriptions: List[str]


def read_jsonl(path: Path) -> List[Atom]:
    atoms: List[Atom] = []
    seen_uuids: set[str] = set()
    with path.open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            obj = json.loads(line)
            uuid = str(obj.get("uuid"))
            if uuid in seen_uuids:
                raise SystemExit(f"Duplicate UUID found in {path}: {uuid}")
            seen_uuids.add(uuid)
            descs = (
                obj.get("semantic_fingerprint", {})
                .get("natural_language_descriptions", [])
            )
            if not isinstance(descs, list):
                descs = []
            cleaned = [str(s).strip() for s in descs if str(s).strip()]
            atoms.append(Atom(uuid=uuid, descriptions=cleaned))
    return atoms


def atom_text(atom: Atom) -> str:
    if not atom.descriptions:
        return f"{atom.uuid}: (no descriptions)"
    # Stable formatting for deterministic embeddings.
    lines = []
    for s in atom.descriptions[:8]:
        lines.append(f"- {s}")
    return "\n".join(lines)


def chunked(xs: List[str], size: int) -> Iterable[List[str]]:
    for i in range(0, len(xs), size):
        yield xs[i : i + size]


def main() -> None:
    repo_root = Path.cwd()
    index_path = repo_root / "repository-semantic-map" / "semantic-index.jsonl"
    out_dir = repo_root / "repository-semantic-map" / "embeddings"
    out_dir.mkdir(parents=True, exist_ok=True)

    if not index_path.exists():
        raise SystemExit(f"Missing {index_path}. Run semantic map generation first.")

    atoms = read_jsonl(index_path)
    if not atoms:
        raise SystemExit(f"No atoms found in {index_path}")

    texts = [atom_text(a) for a in atoms]
    uuids = [a.uuid for a in atoms]

    # Local embedding provider: fastembed (ONNX).
    # Default model: small + good quality, 384-dim.
    model_name = os.environ.get("EMBED_LOCAL_MODEL", "BAAI/bge-small-en-v1.5")
    try:
        batch_size = int(os.environ.get("EMBED_BATCH_SIZE", "128"))
    except ValueError as exc:
        raise SystemExit("EMBED_BATCH_SIZE must be an integer") from exc
    if batch_size <= 0:
        raise SystemExit("EMBED_BATCH_SIZE must be greater than 0")

    from fastembed import TextEmbedding  # type: ignore
    import numpy as np  # type: ignore

    embedder = TextEmbedding(model_name=model_name)

    vectors: List[np.ndarray] = []
    embedded = 0

    for batch in chunked(texts, batch_size):
        for vec in embedder.embed(batch):
            vectors.append(np.asarray(vec, dtype=np.float32))
            embedded += 1
        if embedded % (batch_size * 10) == 0:
            print(f"[embed_local] {embedded}/{len(texts)} rows embedded")

    if len(vectors) != len(texts):
        raise SystemExit(f"Embedding count mismatch: {len(vectors)} != {len(texts)}")

    mat = np.vstack(vectors).astype(np.float32, copy=False)
    rows, cols = mat.shape

    npy_path = out_dir / "semantic-fingerprints.npy"
    np.save(npy_path, mat)

    mapping_path = out_dir / "uuid-mapping.json"
    mapping_path.write_text(
        json.dumps(
            {
                "generated_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
                "provider": {"name": "fastembed", "model": model_name, "dim": int(cols)},
                "rows": int(rows),
                "cols": int(cols),
                "uuids": uuids,
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )

    meta_path = out_dir / "meta.json"
    meta_path.write_text(
        json.dumps(
            {
                "generated_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
                "index_path": "repository-semantic-map/semantic-index.jsonl",
                "npy_path": "repository-semantic-map/embeddings/semantic-fingerprints.npy",
                "mapping_path": "repository-semantic-map/embeddings/uuid-mapping.json",
                "provider": {"name": "fastembed", "model": model_name, "dim": int(cols)},
                "notes": {
                    "text_source": "semantic_fingerprint.natural_language_descriptions (joined)",
                    "batch_size": batch_size,
                },
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )

    print(f"[embed_local] wrote {npy_path} shape={rows}x{cols}")
    print(f"[embed_local] wrote {mapping_path}")


if __name__ == "__main__":
    main()
