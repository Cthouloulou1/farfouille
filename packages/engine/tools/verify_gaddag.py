"""Verifie que gaddag.bin contient exactement les rotations du dictionnaire."""
import struct, time
from pathlib import Path

LET = "?ABCDEFGHIJKLMNOPQRSTUVWXYZ#"
SEP = "#"

def load(p):
    b = open(p, "rb").read()
    assert b[:4] == b"DAWG"
    nodes, nedges, root = struct.unpack_from("<III", b, 4)
    return struct.unpack_from(f"<{nedges}I", b, 16), root

def contains(edges, root, s):
    idx = root
    for i, ch in enumerate(s):
        if idx == 0:
            return False
        code = LET.index(ch)
        hit = False
        while True:
            w = edges[idx]
            if (w >> 27) == code:
                if i == len(s) - 1:
                    return bool((w >> 25) & 1)
                idx = w & 0x1FFFFFF
                hit = True
                break
            if (w >> 26) & 1:
                break
            idx += 1
        if not hit:
            return False
    return False

def count_paths(edges, root):
    """Nombre de chaines acceptees (iteratif : la pile evite la recursion)."""
    n = 0
    stack = [root]
    while stack:
        idx = stack.pop()
        if idx == 0:
            continue
        while True:
            w = edges[idx]
            if (w >> 25) & 1:
                n += 1
            t = w & 0x1FFFFFF
            if t:
                stack.append(t)
            if (w >> 26) & 1:
                break
            idx += 1
    return n

edges, root = load(Path("packages/engine/data/gaddag.bin"))
words = [w.strip() for w in open("dictionnaire.txt", encoding="ascii") if w.strip()]

t0 = time.time()
total = count_paths(edges, root)
expected = sum(len(w) for w in words)
print(f"rotations attendues : {expected:>12,}")
print(f"chaines acceptees   : {total:>12,}")
print(f"exact               : {total == expected}   ({time.time()-t0:.1f} s)")

t0 = time.time()
bad = []
for w in words:
    for i in range(1, len(w) + 1):
        if not contains(edges, root, w[:i][::-1] + SEP + w[i:]):
            bad.append(w[:i][::-1] + SEP + w[i:])
            if len(bad) > 5:
                break
    if len(bad) > 5:
        break
print(f"\ntoutes les rotations des {len(words):,} mots acceptees : {not bad}   ({time.time()-t0:.0f} s)")
if bad:
    print("  manquantes :", bad[:6])

print("\ncontroles ponctuels (rotations qui NE doivent PAS exister) :")
for s, exp in [("TNEICS" + SEP, True),          # rev(SCIENT), validation d'un mot
               ("S" + SEP + "CIENT", True),     # ancrage sur le S initial
               ("EICS" + SEP + "NT", True),     # ancrage au milieu
               ("TNEICS" + SEP + "X", False),
               ("ZZZ" + SEP, False),
               ("W" + SEP + "OKISME", True)]:
    r = contains(edges, root, s)
    print(f"  {'ok ' if r == exp else 'ECHEC'} {s:<14} attendu {str(exp):<5} obtenu {r}")
