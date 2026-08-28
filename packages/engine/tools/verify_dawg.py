"""Relit dawg.bin et verifie qu'il accepte exactement le dictionnaire source."""
import struct, sys, time
from pathlib import Path

LET = "?ABCDEFGHIJKLMNOPQRSTUVWXYZ#"   # index 1..26 = A..Z, 27 = separateur

def load(p):
    b = open(p, "rb").read()
    assert b[:4] == b"DAWG", "mauvais magic"
    nodes, nedges, root = struct.unpack_from("<III", b, 4)
    edges = struct.unpack_from(f"<{nedges}I", b, 16)
    return edges, root

def enumerate_words(edges, root):
    out = []
    def walk(idx, pref):
        if idx == 0:
            return
        while True:
            w = edges[idx]
            ch = LET[w >> 27]
            tgt = w & 0x1FFFFFF
            final = (w >> 25) & 1
            s = pref + ch
            if final:
                out.append(s)
            walk(tgt, s)
            if (w >> 26) & 1:
                break
            idx += 1
    walk(root, "")
    return out

def contains(edges, root, word):
    idx = root
    for i, ch in enumerate(word):
        if idx == 0:
            return False
        code = LET.index(ch)
        found = False
        while True:
            w = edges[idx]
            if (w >> 27) == code:
                if i == len(word) - 1:
                    return bool((w >> 25) & 1)
                idx = w & 0x1FFFFFF
                found = True
                break
            if (w >> 26) & 1:
                break
            idx += 1
        if not found:
            return False
    return False

sys.setrecursionlimit(100)
edges, root = load(Path("packages/engine/data/dawg.bin"))
src = sorted(w.strip() for w in open("dictionnaire.txt", encoding="ascii") if w.strip())

t0 = time.time()
got = sorted(enumerate_words(edges, root))
t1 = time.time()

print(f"mots dans le fichier source : {len(src):,}")
print(f"mots reconnus par le DAWG   : {len(got):,}")
print(f"identiques                  : {got == src}")
if got != src:
    a, b = set(src), set(got)
    print("  manquants :", list(a - b)[:10])
    print("  en trop   :", list(b - a)[:10])
print(f"enumeration en {t1-t0:.1f} s")

print("\ncontroles ponctuels :")
for w, expected in [("SCIENT", True), ("CEINTS", True), ("WOKISME", True), ("ZYTHUM", True),
                    ("AA", True), ("XI", True), ("SCIEN", False), ("ZZZ", False),
                    ("SCIENTS", False), ("BONJOURX", False)]:
    r = contains(edges, root, w)
    flag = "ok " if r == expected else "ECHEC"
    print(f"  {flag} {w:<10} attendu {str(expected):<5} obtenu {r}")
