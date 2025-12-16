from __future__ import annotations

import math
from dataclasses import dataclass
from typing import List, Optional, Sequence, Tuple

try:
    import numpy as np
except Exception:  # pragma: no cover
    np = None  # type: ignore


def _cosine_top_k_numpy(matrix: "np.ndarray", query: "np.ndarray", top_k: int) -> List[int]:
    # matrix: (n, d) float32 normalized; query: (d,) float32 normalized
    sims = matrix @ query  # (n,)
    k = min(int(top_k), int(sims.shape[0]))
    if k <= 0:
        return []
    if k == sims.shape[0]:
        return list(np.argsort(-sims).astype(int).tolist())
    idx = np.argpartition(-sims, k - 1)[:k]
    idx = idx[np.argsort(-sims[idx])]
    return list(idx.astype(int).tolist())


def _cosine_top_k_py(vectors: Sequence[Sequence[float]], query: Sequence[float], top_k: int) -> List[int]:
    # Normalize query
    qn = math.sqrt(sum(float(x) * float(x) for x in query)) or 1.0
    q = [float(x) / qn for x in query]

    scored: List[Tuple[int, float]] = []
    for i, vec in enumerate(vectors):
        vn = math.sqrt(sum(float(x) * float(x) for x in vec)) or 1.0
        dot = 0.0
        # assume same length
        for a, b in zip(vec, q):
            dot += (float(a) / vn) * float(b)
        scored.append((i, dot))
    scored.sort(key=lambda x: x[1], reverse=True)
    return [i for i, _ in scored[: max(0, int(top_k))]]


@dataclass
class EmbeddingIndex:
    """
    In-memory cosine-similarity index for a small list of vectors (<= a few hundred).
    Stores normalized float32 matrix when numpy is available.
    """

    vectors: List[List[float]]
    _mat: Optional["np.ndarray"] = None

    @classmethod
    def build(cls, vectors: Sequence[Sequence[float]]) -> "EmbeddingIndex":
        vlist = [list(map(float, v)) for v in vectors]
        idx = cls(vectors=vlist)
        if np is not None and vlist:
            mat = np.asarray(vlist, dtype=np.float32)
            norms = np.linalg.norm(mat, axis=1, keepdims=True)
            norms = np.where(norms == 0, 1.0, norms)
            idx._mat = mat / norms
        return idx

    def top_k(self, query: Sequence[float], top_k: int) -> List[int]:
        if top_k <= 0:
            return []
        if np is not None and self._mat is not None:
            q = np.asarray(list(map(float, query)), dtype=np.float32)
            n = float(np.linalg.norm(q)) or 1.0
            q = q / n
            return _cosine_top_k_numpy(self._mat, q, top_k)
        return _cosine_top_k_py(self.vectors, query, top_k)

